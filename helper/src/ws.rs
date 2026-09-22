//! Async WebSocket client: the single persistent `/ws/helper` connection.
//!
//! Straightforward duplex pump: inbound server messages are forwarded to the
//! GStreamer thread (which owns helper state); outbound `Client` frames are
//! serialized and written. Reconnects with exponential backoff; the `hello`
//! handshake is re-sent on every fresh connection.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use log::{error, info, warn};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{AUTHORIZATION, COOKIE};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::protocol::{parse_server, Client};
use crate::Inbound;

/** How the helper authenticates to `/ws/helper`. */
pub enum WsAuth {
    /// Paired long-lived device token → `Authorization: Bearer <token>`.
    Bearer(String),
    /// Dev-only session cookie → `Cookie: session=<cookie>`.
    Cookie(String),
}

pub async fn run(
    ws_url: &str,
    auth: WsAuth,
    version: &str,
    in_tx: UnboundedSender<Inbound>,
    mut out_rx: UnboundedReceiver<Client>,
) {
    let mut attempt: u32 = 0;

    loop {
        let req = match IntoClientRequest::into_client_request(ws_url) {
            Ok(r) => r,
            Err(e) => {
                error!("bad WS url: {e}");
                return;
            }
        };
        let mut req = req;
        match &auth {
            WsAuth::Bearer(token) => {
                if let Ok(v) = HeaderValue::from_str(&format!("Bearer {token}")) {
                    req.headers_mut().insert(AUTHORIZATION, v);
                }
            }
            WsAuth::Cookie(cookie) => {
                if let Ok(v) = HeaderValue::from_str(&format!("session={cookie}")) {
                    req.headers_mut().insert(COOKIE, v);
                }
            }
        }

        match connect_async(req).await {
            Ok((mut sink, _resp)) => {
                attempt = 0;
                info!("connected to the signaling backend");

                if let Err(e) = sink
                    .send(Message::Text(
                        serde_json::to_string(&Client::Hello {
                            version: version.to_string(),
                        })
                        .unwrap_or_else(|_| "{\"type\":\"hello\",\"version\":\"?\"}".into()),
                    ))
                    .await
                {
                    warn!("hello send failed: {e}");
                }

                // Duplex pump for this connection.
                let mut connected = true;
                while connected {
                    tokio::select! {
                        m = out_rx.recv() => {
                            match m {
                                Some(msg) => {
                                    let raw = match serde_json::to_string(&msg) {
                                        Ok(r) => r,
                                        Err(e) => { warn!("serialize outbound: {e}"); continue; }
                                    };
                                    if let Err(e) = sink.send(Message::Text(raw)).await {
                                        warn!("write failed: {e}");
                                        connected = false;
                                    }
                                }
                                None => { info!("app closed the outbound channel"); return; }
                            }
                        }
                        msg = sink.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    if let Some(server) = parse_server(&text) {
                                        if in_tx.send(Inbound::Server(server)).is_err() {
                                            info!("app is gone; stopping ws");
                                            return;
                                        }
                                    }
                                }
                                Some(Ok(_)) => {}
                                Some(Err(e)) => {
                                    warn!("read error: {e}");
                                    connected = false;
                                }
                                None => {
                                    info!("connection closed by server");
                                    connected = false;
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                // Upsert auth failures (401/403 on the upgrade) so a revoked token
                // doesn't spin forever — tell the user to pair again.
                if let tokio_tungstenite::tungstenite::Error::Http(res) = &e {
                    if res.status().is_client_error() {
                        error!(
                            "auth rejected by the backend ({}) — the device token was revoked or missing. Run `golive-helper unpair`, then pair again from the Host page.",
                            res.status()
                        );
                        return;
                    }
                }
                warn!("connect failed: {e}");
            }
        }

        let delay = Duration::from_millis(500 * 2u64.pow(attempt.min(5)));
        attempt += 1;
        info!("reconnecting in {delay:?} (attempt {attempt})…");
        tokio::time::sleep(delay).await;
    }
}