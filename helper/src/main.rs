//! golive native helper (M2): Windows screen capture -> AV1 -> WebRTC.
//!
//! Two threads:
//!   - main thread: tokio runtime; the WS client (ws.rs) plus ctrl-C handling.
//!   - gst thread: owns every gstreamer object (they are !Send) and drives the
//!     helper state machine. The GLib default main context is pumped manually
//!     in its loop so webrtcbin promises/signals fire without a MainLoop.

mod pipeline;
mod protocol;
mod ws;

use std::env;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use gstreamer::prelude::*;
use log::{error, info, warn};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use protocol::{Client, Server, StartPayload};

const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug)]
pub enum Inbound {
    Server(Server),
    Shutdown,
}

#[derive(Clone, Copy, PartialEq)]
enum RunState {
    Idle,
    Live,
}

impl RunState {
    fn as_str(self) -> &'static str {
        match self {
            RunState::Idle => "idle",
            RunState::Live => "live",
        }
    }
}

struct App {
    out: UnboundedSender<Client>,
    state: RunState,
    session: Option<pipeline::StreamSession>,
    offer_sent: bool,
    shutdown: bool,
    last_neg_debug: u64,
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .format_timestamp_millis()
    .init();

    let base = env::var("BASE_URL").unwrap_or_else(|_| "http://localhost:8787".into());
    let ws_url = format!("{}/ws/helper", base.replace("http", "ws").replace("https", "wss"));

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("tokio runtime")?;

    rt.block_on(async move {
        let cookie = obtain_cookie(&base).await?;

        // Cross-thread channels (a bounded WS + app state live on different threads).
        let (out_tx, out_rx) = unbounded_channel::<Client>();
        let (in_tx, in_rx) = unbounded_channel::<Inbound>();

        let gst_handle = std::thread::Builder::new()
            .name("gst".into())
            .spawn(move || gst_thread(in_rx, out_tx))
            .context("spawn gst thread")?;

        let ws_in = in_tx.clone();
        let ws_cookie = cookie.clone();
        tokio::spawn(async move {
            ws::run(&ws_url, &ws_cookie, VERSION, ws_in, out_rx).await;
        });

        info!("golive helper {VERSION} starting… (backend {base})");
        tokio::signal::ctrl_c().await.context("ctrl_c")?;
        info!("shutting down");
        let _ = in_tx.send(Inbound::Shutdown);
        drop(in_tx);
        let _ = gst_handle.join();
        Ok::<(), anyhow::Error>(())
    })
}

/// Dev auth (or SESSION_COOKIE override) — same trick as helper-stub.
async fn obtain_cookie(base: &str) -> Result<String> {
    if let Ok(cookie) = env::var("SESSION_COOKIE") {
        return Ok(cookie);
    }
    let client = reqwest::Client::new();
    let res = client
        .post(format!("{base}/auth/dev"))
        .send()
        .await
        .context("dev login request")?;
    if !res.status().is_success() {
        return Err(anyhow!(
            "dev login failed with HTTP {} — are the DISCORD_* env vars set?",
            res.status()
        ));
    }
    let header = res.headers();
    for value in header.get_all(reqwest::header::SET_COOKIE) {
        let raw = value.to_str().unwrap_or("");
        if let Some(session) = raw.split(';').next() {
            if session.starts_with("session=") {
                return Ok(session[8..].to_string());
            }
        }
    }
    Err(anyhow!("no session cookie in the dev-login response"))
}

// ---------------------------------------------------------------------------
// GStreamer thread
// ---------------------------------------------------------------------------

fn gst_thread(
    mut in_rx: UnboundedReceiver<Inbound>,
    out: UnboundedSender<Client>,
) {
    if let Err(e) = gstreamer::init() {
        error!("gstreamer init failed: {e}");
        return;
    }
    info!("gstreamer {} ready", gstreamer::version_string());

    let mut app = App {
        out,
        state: RunState::Idle,
        session: None,
        offer_sent: false,
        shutdown: false,
        last_neg_debug: 0,
    };

    // Process gstreamer/glib sources (promises, bus, timeouts) + our channel.
    loop {
        while let Ok(msg) = in_rx.try_recv() {
            app.handle(msg);
            if app.shutdown {
                break;
            }
        }
        if app.shutdown {
            break;
        }

        app.poll_negotiation();

        gstreamer::glib::MainContext::default().iteration(false);
        std::thread::sleep(Duration::from_millis(2));
    }

    if let Some(session) = app.session.take() {
        if let Err(e) = pipeline::stop(&session) {
            warn!("pipeline stop failed: {e}");
        }
    }
    info!("gst thread exiting");
}

impl App {
    fn handle(&mut self, msg: Inbound) {
        match msg {
            Inbound::Shutdown => self.shutdown = true,
            Inbound::Server(server) => self.handle_server(server),
        }
    }

    fn handle_server(&mut self, msg: Server) {
        match msg {
            Server::HelloAck { server_time } => {
                info!("handshake acknowledged (server time {server_time})");
            }
            Server::Ping => {
                let state = self.state.as_str();
                let detail = if let Some(s) = &self.session {
                    format!("pipeline state {:?}", s.pipeline.current_state())
                } else {
                    "no pipeline".into()
                };
                let _ = self.out.send(Client::Status {
                    state: state.to_string(),
                    detail: Some(detail),
                });
            }
            Server::Command { id, command, payload } => {
                self.handle_command(&id, &command, payload.as_ref());
            }
            Server::AttachAck {
                ok,
                room_id,
                viewer_count,
                viewers,
                error,
            } => {
                if ok {
                    info!(
                        "attached to room {} ({} viewer(s) waiting: {})",
                        room_id.as_deref().unwrap_or("?"),
                        viewer_count.unwrap_or(0),
                        viewers.unwrap_or_default().join(", ")
                    );
                } else {
                    let detail = error
                        .map(|e| format!("{e}"))
                        .unwrap_or_else(|| "attach rejected".into());
                    error!("attach failed: {detail}");
                }
            }
            Server::PeerJoined { peer_id, .. } => {
                info!("viewer {peer_id} joined");
                self.target_peer(&peer_id);
            }
            Server::PeerLeft { peer_id, .. } => {
                info!("viewer {peer_id} left");
                if let Some(s) = &self.session {
                    let is_ours = s
                        .ctx
                        .lock()
                        .unwrap()
                        .peer_id
                        .as_deref()
                        == Some(peer_id.as_str());
                    if is_ours {
                        s.ctx.lock().unwrap().peer_id = None;
                        self.offer_sent = false;
                    }
                }
            }
            Server::RoomSdp {
                peer_id,
                sdp,
                ..
            } => {
                info!("SDP from viewer {peer_id}: {}", sdp.sdp_type);
                if let Some(s) = &self.session {
                    let is_ours = s.ctx.lock().unwrap().peer_id.as_deref() == Some(peer_id.as_str());
                    if is_ours {
                        if let Err(e) = pipeline::set_remote_description(s, &sdp.sdp) {
                            error!("set remote description failed: {e}");
                        }
                    }
                }
            }
            Server::RoomIce { peer_id, candidate, .. } => {
                if let Some(s) = &self.session {
                    let is_ours = s.ctx.lock().unwrap().peer_id.as_deref() == Some(peer_id.as_str());
                    if is_ours {
                        pipeline::add_remote_candidate(s, &candidate.candidate);
                    }
                }
            }
        }
    }

    fn handle_command(&mut self, id: &str, command: &str, payload: Option<&serde_json::Value>) {
        match command {
            "start" => {
                let p: StartPayload = payload
                    .cloned()
                    .map(|v| serde_json::from_value(v).unwrap_or_default())
                    .unwrap_or_default();
                let room_id = p.room_id.unwrap_or_default();
                if room_id.is_empty() {
                    let _ = self.out.send(Client::ack(
                        id,
                        false,
                        self.state.as_str(),
                        Some("start requires a roomId payload".into()),
                    ));
                    return;
                }
                self.start_stream(&room_id);
                let _ = self.out.send(Client::ack(
                    id,
                    true,
                    self.state.as_str(),
                    Some(format!("capturing into room {room_id}")),
                ));
            }
            "stop" => {
                self.stop_stream();
                let _ = self.out.send(Client::ack(id, true, self.state.as_str(), Some("stopped".into())));
            }
            other => {
                let _ = self.out.send(Client::ack(
                    id,
                    false,
                    self.state.as_str(),
                    Some(format!("unknown command `{other}`")),
                ));
            }
        }
    }

    fn start_stream(&mut self, room_id: &str) {
        if self.session.is_some() {
            info!("restarting stream (room {room_id})");
            self.stop_stream();
        }
        match pipeline::build(self.out.clone()) {
            Ok(session) => {
                if let Err(e) = pipeline::play(&session) {
                    error!("could not start pipeline: {e}");
                    return;
                }
                session.ctx.lock().unwrap().room_id = Some(room_id.to_string());
                let _ = session.out.send(Client::AttachRoom {
                    room_id: room_id.to_string(),
                });
                self.session = Some(session);
                self.state = RunState::Live;
                info!("stream running for room {room_id}");
            }
            Err(e) => warn!("pipeline build failed: {e:#}"),
        }
    }

    fn target_peer(&mut self, peer_id: &str) {
        if let Some(s) = &self.session {
            s.ctx.lock().unwrap().peer_id = Some(peer_id.to_string());
            self.offer_sent = false;
            info!("targeting viewer {peer_id} for negotiation");
        } else {
            warn!("viewer joined but no stream is running");
        }
    }

    /// Create the offer once webrtcbin asks and a viewer is targeted.
    fn poll_negotiation(&mut self) {
        if self.offer_sent {
            return;
        }
        let Some(session) = &self.session else {
            return;
        };
        if !session.negotiation_pending.load(std::sync::atomic::Ordering::SeqCst) {
            // Diagnostics: sanity-check the app loop is ticking while we wait.
            self.last_neg_debug = self.last_neg_debug.wrapping_add(1);
            if self.last_neg_debug % 500 == 1 && session.ctx.lock().unwrap().peer_id.is_some() {
                info!(
                    "still waiting for webrtcbin negotiation (loop alive) — pipeline state {:?}",
                    session.pipeline.current_state()
                );
            }
            return;
        }
        if session.ctx.lock().unwrap().peer_id.is_none() {
            return;
        }
        match pipeline::create_offer(session) {
            Ok(()) => {
                self.offer_sent = true;
                info!("offer created and queued");
            }
            Err(e) => warn!("create offer failed: {e}"),
        }
    }

    fn stop_stream(&mut self) {
        if let Some(session) = self.session.take() {
            let _ = pipeline::stop(&session);
            self.state = RunState::Idle;
            self.offer_sent = false;
            let _ = self.out.send(Client::DetachRoom);
            info!("stream stopped");
        }
    }
}