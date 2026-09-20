//! GStreamer capture -> AV1 -> webrtcbin, hosted on the helper's own thread.
//!
//! Pipeline (from this machine's probe: GStreamer 1.28, no hardware AV1
//! encoder, so SVT software):
//!
//! ```text
//! d3d11screencapturesrc (show-cursor, framerate=30/1)
//!   -> d3d11convert -> d3d11download            (GPU -> system memory)
//!   -> videoconvert -> videorate -> videoscale  -> 1280x720 @30
//!   -> svtav1enc preset=12 crf=36
//!   -> rtpav1pay -> queue -> webrtcbin
//! ```
//!
//! On hardware that has one, swap `svtav1enc` for `nvav1enc`/`qsvav1enc` (M5).
//!
//! NOTE: gstreamer-rs 0.22 has no typed `WebRTCBin` wrapper anymore — the
//! element is driven through `gst::Element` with named signals/actions.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use gstreamer::prelude::*;
use log::{error, info, warn};

use crate::protocol::{Client, IceCandidate, SdpMessage};

/// Where outgoing SDP/ICE is addressed + which room they belong to.
/// Written by the app loop (GStreamer thread), read by signal callbacks
/// (also GStreamer thread), so an Arc<Mutex> is enough.
#[derive(Default)]
pub struct RunContext {
    pub room_id: Option<String>,
    pub peer_id: Option<String>,
}

pub struct StreamSession {
    pub pipeline: gstreamer::Pipeline,
    pub webrtcbin: gstreamer::Element,
    pub ctx: Arc<Mutex<RunContext>>,
    /// Set by webrtcbin when it wants an offer created (via negotiation-needed).
    pub negotiation_pending: Arc<AtomicBool>,
    pub out: tokio::sync::mpsc::UnboundedSender<Client>,
}

const STUN_SERVER: &str = "stun://stun.l.google.com:19302";

/// The caps rtpav1pay produces for AV1 RTP (payload type 96, 90 kHz clock).
/// webrtcbin only starts negotiation after receiving caps on its RTP sink
/// pad, and those normally arrive with the first encoded frame. On a fully
/// static desktop the capture source emits nothing, so the helper pre-pushes
/// these exact caps after PLAYING to unblock negotiation (see `play`).
const AV1_RTP_CAPS_STR: &str = concat!(
    "application/x-rtp, media=(string)video, encoding-name=(string)AV1, ",
    "payload=(int)96, clock-rate=(int)90000, encoding-params=(string)1"
);

pub fn build(out: tokio::sync::mpsc::UnboundedSender<Client>) -> Result<StreamSession> {
    // NOTE: `framerate` is not a property of d3d11screencapturesrc (the
    // gst-inspect range was a pad-template caps range). The frame rate is
    // locked to 30 by `videorate` + the caps filter downstream. A static
    // desktop produces no new frames (cursor movement with show-cursor=true
    // does); that matches WebRTC screenshare semantics well enough for M2.
    let desc = concat!(
        "d3d11screencapturesrc show-cursor=true ",
        "! d3d11convert ! video/x-raw(memory:D3D11Memory) ",
        "! d3d11download ! video/x-raw(memory:SystemMemory) ",
        "! videoconvert ! videorate ! videoscale ",
        "! video/x-raw,width=1280,height=720,framerate=30/1 ",
        "! svtav1enc preset=12 crf=36 ",
        "! rtpav1pay ",
        "! queue ",
        "! webrtcbin name=wc"
    );

    let bin = gstreamer::parse::bin_from_description_with_name(desc, false, "golive-stream")
        .map_err(|e| anyhow!("pipeline parse failed: {}", e))?;
    // parse::bin_from_description_* returns a plain Bin (not a Pipeline), so
    // wrap it in a real pipeline for clock + bus semantics.
    let pipeline = gstreamer::Pipeline::new();
    pipeline
        .add(&bin)
        .map_err(|e| anyhow!("cannot add parsed bin to pipeline: {e}"))?;

    let webrtcbin = pipeline
        .by_name("wc")
        .context("webrtcbin not found in pipeline")?;
    webrtcbin.set_property_from_str("stun-server", STUN_SERVER);

    let ctx = Arc::new(Mutex::new(RunContext::default()));
    let negotiation_pending = Arc::new(AtomicBool::new(false));

    // --- webrtcbin wants an offer --------------------------------------------
    // NOTE: webrtcbin emits this from its *internal* signalling thread, so we
    // must use `connect` (Send + Sync) rather than `connect_local`, whose
    // thread guard panics when the callback runs on another thread.
    let pending = negotiation_pending.clone();
    webrtcbin.connect("on-negotiation-needed", false, move |_values| {
        info!("webrtcbin requests negotiation");
        pending.store(true, Ordering::SeqCst);
        None
    });

    // --- local ICE candidates -------------------------------------------------
    // Also emitted from webrtcbin's internal thread — `connect`, not
    // `connect_local` (see the negotiation-needed handler above).
    let ctx_ice = ctx.clone();
    let out_ice = out.clone();
    webrtcbin.connect("on-ice-candidate", false, move |values| {
        let mline = values.get(1).and_then(|v| v.get::<u32>().ok());
        let candidate = values.get(2).and_then(|v| v.get::<String>().ok());
        let (Some(mline), Some(candidate)) = (mline, candidate) else {
            return None;
        };
        let (room_id, peer_id) = {
            let c = ctx_ice.lock().unwrap();
            (c.room_id.clone(), c.peer_id.clone())
        };
        let (Some(room_id), Some(peer_id)) = (room_id, peer_id) else {
            return None;
        };
        info!("local ICE candidate (m={mline}): {candidate}");
        let _ = out_ice.send(Client::RoomIce {
            room_id,
            peer_id,
            candidate: IceCandidate::full_candidate(candidate),
        });
        None
    });

    // --- bus: surface errors / EOS -------------------------------------------
    let bus = pipeline.bus().context("pipeline has no bus")?;
    bus.connect_message(None, |_bus: &gstreamer::Bus, msg: &gstreamer::Message| {
        use gstreamer::MessageView;
        match msg.view() {
            MessageView::Error(err) => {
                error!("stream error: {} ({:?})", err.error(), err.debug());
            }
            MessageView::Eos(_) => info!("stream EOS"),
            _ => {}
        }
    });

    Ok(StreamSession {
        pipeline,
        webrtcbin,
        ctx,
        negotiation_pending,
        out,
    })
}

/// Create the offer for the currently-targeted viewer, install it as the
/// local description, and ship it to the room. Call only when a viewer is
/// targeted and negotiation has been requested.
pub fn create_offer(session: &StreamSession) -> Result<()> {
    let (room_id, peer_id) = {
        let c = session.ctx.lock().unwrap();
        (c.room_id.clone(), c.peer_id.clone())
    };
    let room_id = room_id.context("no room attached")?;
    let peer_id = peer_id.context("no viewer targeted")?;

    let out = session.out.clone();
    let webrtcbin = session.webrtcbin.clone();

    let promise = gstreamer::Promise::with_change_func(move |res| {
        let reply = match res {
            Ok(Some(reply)) => reply,
            Ok(None) => {
                warn!("create-offer promise cancelled");
                return;
            }
            Err(e) => {
                warn!("create-offer promise error: {e:?}");
                return;
            }
        };
        // The reply's "offer" field is an SDPMessage (or a structure wrapping
        // one) depending on the GStreamer release; accept both shapes.
        let sdp_obj = match reply.get::<gstreamer_sdp::SDPMessage>("offer") {
            Ok(sdp) => sdp,
            Err(_) => match reply.get::<gstreamer::Structure>("offer") {
                Ok(stru) => match stru.get::<gstreamer_sdp::SDPMessage>("sdp") {
                    Ok(s) => s,
                    Err(_) => {
                        warn!("create-offer reply structure has no sdp message — offer not sent");
                        return;
                    }
                },
                Err(_) => {
                    warn!("create-offer reply has no offer field");
                    return;
                }
            },
        };
        let text = sdp_obj.to_string();

        info!("offer ready for peer {peer_id}");
        let _ = webrtcbin.emit_by_name::<()>("set-local-description", &[&sdp_obj]);
        let _ = out.send(Client::RoomSdp {
            room_id,
            peer_id,
            sdp: SdpMessage {
                sdp_type: "offer".into(),
                sdp: text,
            },
        });
    });

    session
        .webrtcbin
        .emit_by_name::<()>("create-offer", &[&promise]);
    Ok(())
}

/// Feed the viewer's answer into webrtcbin, then start streaming.
pub fn set_remote_description(session: &StreamSession, sdp_text: &str) -> Result<()> {
    let sdp = gstreamer_sdp::SDPMessage::parse_buffer(sdp_text.as_bytes())
        .context("viewer SDP is not a valid SDP message")?;
    session
        .webrtcbin
        .emit_by_name::<()>("set-remote-description", &[&sdp]);
    play(session)
}

/// Feed a remote ICE candidate into webrtcbin (video is mline 0 in M2).
pub fn add_remote_candidate(session: &StreamSession, candidate: &str) {
    session
        .webrtcbin
        .emit_by_name::<()>("add-ice-candidate", &[&0u32, &candidate]);
}

pub fn play(session: &StreamSession) -> Result<()> {
    session
        .pipeline
        .set_state(gstreamer::State::Playing)
        .map(|_| ())
        .map_err(|_| anyhow!("could not set pipeline to PLAYING"))?;
    pre_push_caps(session);
    Ok(())
}

/// Push the AV1 RTP caps onto webrtcbin's sink pad (downstream of the queue,
/// exactly where rtpav1pay would emit them) so negotiation is possible even
/// before any frame was captured. Idempotent: when real frames flow later,
/// rtpav1pay pushes the same caps again.
fn pre_push_caps(session: &StreamSession) {
    let caps = match AV1_RTP_CAPS_STR.parse::<gstreamer::Caps>() {
        Ok(c) => c,
        Err(e) => {
            warn!("invalid AV1_RTP_CAPS_STR: {e}");
            return;
        }
    };
    // The sink pad webrtcbin created (from its sink_%u request template).
    let Some(sink_pad) = session
        .webrtcbin
        .pads()
        .into_iter()
        .find(|p| p.name().starts_with("sink_"))
    else {
        warn!("webrtcbin sink pad not found — cannot pre-push caps");
        return;
    };
    let Some(peer) = sink_pad.peer() else {
        warn!("webrtcbin sink pad has no peer — cannot pre-push caps");
        return;
    };
    if !peer.push_event(gstreamer::event::Caps::new(&caps)) {
        warn!("pre-push of AV1 caps was rejected");
    } else {
        info!("pre-pushed AV1 caps onto webrtcbin sink pad");
    }
}

pub fn stop(session: &StreamSession) -> Result<()> {
    session
        .pipeline
        .set_state(gstreamer::State::Null)
        .map(|_| ())
        .map_err(|_| anyhow!("could not set pipeline to NULL"))
}