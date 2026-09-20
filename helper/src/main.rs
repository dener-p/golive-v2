//! golive native helper (M4): Windows screen capture -> AV1 -> N viewers.
//!
//! Two threads:
//!   - main thread: tokio runtime; the WS client (ws.rs) plus ctrl-C handling.
//!   - gst thread: owns every gstreamer object (they are !Send) and drives the
//!     helper state machine. The GLib default main context is pumped manually
//!     in its loop so webrtcbin promises/signals fire without a MainLoop.
//!
//! M4 change: the pipeline encodes once and fans the RTP stream through a `tee`
//! element to one `webrtcbin` per connected viewer.  Viewers join and leave
//! dynamically; each gets its own SDP negotiation and ICE agent.

mod pipeline;
mod protocol;
mod ws;

use std::collections::HashMap;
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

/// Per-viewer state tracked on the app (GStreamer) thread.
struct ViewerState {
    /// Whether we already sent an SDP offer for this viewer.
    offer_sent: bool,
}

struct App {
    out: UnboundedSender<Client>,
    state: RunState,
    session: Option<pipeline::StreamSession>,
    /// The room we're currently streaming into (set by `start` command).
    current_room: Option<String>,
    /// Per-viewer negotiation state keyed by peer_id.
    viewers: HashMap<String, ViewerState>,
    shutdown: bool,
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
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
            "dev login failed with HTTP {}",
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

fn gst_thread(mut in_rx: UnboundedReceiver<Inbound>, out: UnboundedSender<Client>) {
    if let Err(e) = gstreamer::init() {
        error!("gstreamer init failed: {e}");
        return;
    }
    info!("gstreamer {} ready", gstreamer::version_string());

    let mut app = App {
        out,
        state: RunState::Idle,
        session: None,
        current_room: None,
        viewers: HashMap::new(),
        shutdown: false,
    };

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

        app.poll_negotiations();

        while gstreamer::glib::MainContext::default().iteration(false) {}
        std::thread::sleep(Duration::from_millis(2));
    }

    if let Some(session) = app.session.take() {
        if let Err(e) = pipeline::stop(&session) {
            warn!("pipeline stop failed: {e}");
        }
    }
    info!("gst thread exiting");
}

// ---------------------------------------------------------------------------
// App message handling
// ---------------------------------------------------------------------------

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
                    format!(
                        "pipeline {:?}, {} viewer(s)",
                        s.pipeline.current_state(),
                        s.viewers.len()
                    )
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
                    let rid = room_id.as_deref().unwrap_or("?");
                    let existing = viewers.unwrap_or_default();
                    info!(
                        "attached to room {rid} ({:?} viewer(s) waiting: {:?})",
                        viewer_count.unwrap_or(0),
                        existing
                    );
                    // Create webrtcbin + offer for each viewer already in the room.
                    if let Some(rid) = &room_id {
                        for pid in &existing {
                            self.add_viewer(pid);
                            // Set room_id now that we know it.
                            if let Some(s) = &self.session {
                                pipeline::set_viewer_room(s, pid, rid);
                            }
                        }
                    }
                } else {
                    let detail = error
                        .map(|e| format!("{e}"))
                        .unwrap_or_else(|| "attach rejected".into());
                    error!("attach failed: {detail}");
                }
            }
            Server::PeerJoined { peer_id, .. } => {
                info!("viewer {peer_id} joined");
                self.add_viewer(&peer_id);
            }
            Server::PeerLeft { peer_id, .. } => {
                info!("viewer {peer_id} left");
                self.remove_viewer(&peer_id);
            }
            Server::RoomSdp { peer_id, sdp, .. } => {
                info!("SDP from viewer {peer_id}: {}", sdp.sdp_type);
                if let Some(s) = &self.session {
                    if let Err(e) = pipeline::set_remote_description_for_viewer(s, &peer_id, &sdp.sdp) {
                        error!("set remote description failed for {peer_id}: {e}");
                    }
                }
            }
            Server::RoomIce {
                peer_id, candidate, ..
            } => {
                info!("ICE candidate from viewer {peer_id}: {}", candidate.candidate);
                if let Some(s) = &self.session {
                    pipeline::add_remote_candidate_for_viewer(
                        s,
                        &peer_id,
                        candidate.sdp_mline_index.unwrap_or(0),
                        &candidate.candidate,
                    );
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
                let _ = self.out.send(Client::ack(
                    id,
                    true,
                    self.state.as_str(),
                    Some("stopped".into()),
                ));
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

    // -- stream lifecycle ----------------------------------------------------

    fn start_stream(&mut self, room_id: &str) {
        if self.session.is_some() {
            info!("restarting stream (room {room_id})");
            self.stop_stream();
        }
        match pipeline::build(self.out.clone()) {
            Ok(session) => {
                self.current_room = Some(room_id.to_string());
                // Set room on any viewers that were queued before stream start.
                for pid in self.viewers.keys().cloned().collect::<Vec<_>>() {
                    pipeline::set_viewer_room(&session, &pid, room_id);
                }
                if let Err(e) = pipeline::play(&session) {
                    error!("could not start pipeline: {e}");
                    return;
                }
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

    fn stop_stream(&mut self) {
        if let Some(session) = self.session.take() {
            let _ = pipeline::stop(&session);
            self.state = RunState::Idle;
            self.current_room = None;
            self.viewers.clear();
            let _ = self.out.send(Client::DetachRoom);
            info!("stream stopped");
        }
    }

    // -- multi-viewer management --------------------------------------------

    fn add_viewer(&mut self, peer_id: &str) {
        self.viewers
            .insert(peer_id.to_string(), ViewerState { offer_sent: false });

        if let Some(ref mut s) = self.session {
            if let Err(e) = pipeline::add_viewer(s, peer_id) {
                error!("failed to add viewer {peer_id}: {e}");
                self.viewers.remove(peer_id);
                return;
            }
            // Use the room_id we stored when start was called.
            if let Some(room_id) = &self.current_room {
                pipeline::set_viewer_room(s, peer_id, room_id);
            }
            info!(
                "now serving {} viewer(s): {}",
                s.viewers.len(),
                s.viewers.keys().cloned().collect::<Vec<_>>().join(", ")
            );
        }
    }

    fn remove_viewer(&mut self, peer_id: &str) {
        self.viewers.remove(peer_id);
        if let Some(s) = &mut self.session {
            pipeline::remove_viewer(s, peer_id);
            info!(
                "now serving {} viewer(s)",
                s.viewers.len()
            );
        }
    }

    /// Check all viewers that haven't received an offer yet and create one.
    fn poll_negotiations(&mut self) {
        let Some(session) = &self.session else {
            return;
        };

        let room_id = match &self.current_room {
            Some(r) => r.clone(),
            None => return,
        };

        // Collect viewer peer_ids that need an offer.
        let need_offer: Vec<String> = session
            .viewers
            .keys()
            .filter(|pid| {
                self.viewers
                    .get(pid.as_str())
                    .map(|vs| !vs.offer_sent)
                    .unwrap_or(false)
            })
            .cloned()
            .collect();

        for peer_id in need_offer {
            // Ensure room_id is set on the viewer context.
            pipeline::set_viewer_room(session, &peer_id, &room_id);

            match pipeline::create_offer_for_viewer(session, &peer_id) {
                Ok(()) => {
                    if let Some(vs) = self.viewers.get_mut(&peer_id) {
                        vs.offer_sent = true;
                    }
                    info!("offer created for viewer {peer_id}");
                }
                Err(e) => warn!("create offer failed for {peer_id}: {e}"),
            }
        }

        // Apply any pending offers (set-local-description) from the previous tick.
        // This must be called from the main loop, not from inside create-offer's
        // promise callback, to avoid reentrancy in webrtcbin's state machine.
        pipeline::apply_pending_offers(session);
    }
}
