//! GStreamer capture -> AV1 -> tee -> N webrtcbin instances (M4: multi-viewer).
//!
//! Pipeline:
//!
//! ```text
//! d3d11screencapturesrc show-cursor=true
//!   -> d3d11convert -> d3d11download            (GPU -> system memory)
//!   -> videoconvert -> videorate -> videoscale  -> 1280x720 @30
//!   -> svtav1enc preset=12 crf=36
//!   -> rtpav1pay -> queue -> tee
//! ```
//!
//! Each viewer gets its own `webrtcbin` element dynamically linked to a tee
//! src pad.  The AV1 encode happens once; tee fans the RTP packets to every
//! connected viewer without re-encoding.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use gstreamer::prelude::*;
use log::{error, info, warn};

use crate::protocol::{Client, IceCandidate, SdpMessage};

// ---------------------------------------------------------------------------
// Per-viewer context (written by the app loop, read by signal callbacks)
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct ViewerContext {
    pub room_id: String,
    pub peer_id: String,
}

pub struct ViewerEntry {
    pub webrtcbin: gstreamer::Element,
    pub capsfilter: gstreamer::Element,
    pub ctx: Arc<Mutex<ViewerContext>>,
}

// ---------------------------------------------------------------------------
// Stream session
// ---------------------------------------------------------------------------

pub struct StreamSession {
    pub pipeline: gstreamer::Pipeline,
    /// The tee element whose src pads feed per-viewer webrtcbin instances.
    tee: gstreamer::Element,
    /// Active viewers keyed by peer_id.
    pub viewers: HashMap<String, ViewerEntry>,
    /// Monotonically increasing pad index for tee src pads.
    next_pad_idx: u32,
    pub out: tokio::sync::mpsc::UnboundedSender<Client>,
}

const STUN_SERVER: &str = "stun://stun.l.google.com:19302";

/// The caps rtpav1pay produces for AV1 RTP (payload type 96, 90 kHz clock).
const AV1_RTP_CAPS_STR: &str = concat!(
    "application/x-rtp, media=(string)video, encoding-name=(string)AV1, ",
    "payload=(int)96, clock-rate=(int)90000, encoding-params=(string)1"
);

// ---------------------------------------------------------------------------
// Build the base pipeline (up to tee — no webrtcbin yet)
// ---------------------------------------------------------------------------

pub fn build(out: tokio::sync::mpsc::UnboundedSender<Client>) -> Result<StreamSession> {
    let desc = concat!(
        "d3d11screencapturesrc show-cursor=true ",
        "! d3d11convert ! video/x-raw(memory:D3D11Memory) ",
        "! d3d11download ! video/x-raw(memory:SystemMemory) ",
        "! videoconvert ! videorate ! videoscale ",
        "! video/x-raw,width=1280,height=720,framerate=30/1 ",
        "! svtav1enc preset=12 crf=36 ",
        "! rtpav1pay ",
        "! queue ",
        "! tee name=t"
    );

    let bin = gstreamer::parse::bin_from_description_with_name(desc, false, "golive-stream")
        .map_err(|e| anyhow!("pipeline parse failed: {}", e))?;

    let pipeline = gstreamer::Pipeline::new();
    pipeline
        .add(&bin)
        .map_err(|e| anyhow!("cannot add parsed bin to pipeline: {e}"))?;

    let tee = pipeline
        .by_name("t")
        .context("tee element not found in pipeline")?;

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
        tee,
        viewers: HashMap::new(),
        next_pad_idx: 0,
        out,
    })
}

// ---------------------------------------------------------------------------
// Add / remove viewers (dynamic webrtcbin instances)
// ---------------------------------------------------------------------------

/// Create a new webrtcbin for `peer_id`, link it to a fresh tee src pad,
/// pre-push AV1 caps so negotiation can start immediately, and wire up
/// the signal handlers.
pub fn add_viewer(session: &mut StreamSession, peer_id: &str) -> Result<()> {
    if session.viewers.contains_key(peer_id) {
        return Ok(()); // already tracked
    }

    let pad_idx = session.next_pad_idx;
    session.next_pad_idx += 1;
    let pad_name = format!("src_{pad_idx}");

    // --- request a tee src pad ------------------------------------------------
    let tee_pad_template = session
        .tee
        .pad_template("src_%u")
        .context("tee has no src_%u pad template")?;
    let tee_src_pad = session
        .tee
        .request_pad(&tee_pad_template, Some(&pad_name), None)
        .with_context(|| format!("could not request tee pad {pad_name}"))?;

    // --- create webrtcbin -----------------------------------------------------
    let webrtcbin = gstreamer::ElementFactory::make("webrtcbin")
        .property_from_str("name", &format!("wc_{peer_id}"))
        .build()
        .context("failed to create webrtcbin")?;
    webrtcbin.set_property_from_str("stun-server", STUN_SERVER);

    // tee src pads have no caps until data flows, but webrtcbin's sink_%u
    // expects RTP caps. Insert a capsfilter to bridge the gap.
    let capsfilter = gstreamer::ElementFactory::make("capsfilter")
        .build()
        .context("failed to create capsfilter")?;
    capsfilter.set_property(
        "caps",
        AV1_RTP_CAPS_STR.parse::<gstreamer::Caps>().unwrap(),
    );

    session
        .pipeline
        .add_many([&webrtcbin, &capsfilter])
        .context("cannot add elements to pipeline")?;

    // Link: tee_src_pad -> capsfilter -> webrtcbin
    let cf_sink = capsfilter.static_pad("sink").context("capsfilter has no sink")?;
    tee_src_pad.link(&cf_sink).context("could not link tee -> capsfilter")?;

    let cf_src = capsfilter.static_pad("src").context("capsfilter has no src")?;
    let wb_sink_template = webrtcbin
        .pad_template("sink_%u")
        .context("webrtcbin has no sink_%u pad template")?;
    let wb_sink = webrtcbin
        .request_pad(&wb_sink_template, None, None)
        .context("could not request webrtcbin sink pad")?;
    cf_src.link(&wb_sink).context("could not link capsfilter -> webrtcbin")?;

    // Let the new element adopt the pipeline's running state.
    webrtcbin
        .sync_state_with_parent()
        .context("webrtcbin sync_state failed")?;

    // --- per-viewer state -----------------------------------------------------
    let ctx = Arc::new(Mutex::new(ViewerContext {
        room_id: String::new(), // filled in after attach-ack
        peer_id: peer_id.to_string(),
    }));

    // --- webrtcbin signals (per-viewer) ---------------------------------------
    let ctx_ice = ctx.clone();
    let out_ice = session.out.clone();
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
        if room_id.is_empty() || peer_id.is_empty() {
            return None;
        }
        info!("local ICE candidate (m={mline}) for viewer {peer_id}: {candidate}");
        let _ = out_ice.send(Client::RoomIce {
            room_id,
            peer_id,
            candidate: IceCandidate::full_candidate(candidate),
        });
        None
    });

    // --- pre-push AV1 caps so negotiation isn't blocked on first frame ---------
    // NOTE: webrtcbin creates sink_%u pads lazily after the pipeline reaches
    // PLAYING.  If the pad doesn't exist yet, skip the pre-push — the first
    // encoded frame will carry the caps anyway.
    {
        let mut has_sink = false;
        for pad in webrtcbin.pads() {
            if pad.name().starts_with("sink_") {
                has_sink = true;
                break;
            }
        }
        if has_sink {
            pre_push_caps(session, &webrtcbin);
        } else {
            info!("webrtcbin sink pad not yet created — skipping pre-push caps for viewer {peer_id}");
        }
    }

    info!("added viewer {peer_id} (tee pad {pad_name})");

    session.viewers.insert(
        peer_id.to_string(),
        ViewerEntry {
            webrtcbin,
            capsfilter,
            ctx,
        },
    );

    // Create the offer immediately rather than waiting for on-negotiation-needed.
    // With a dynamic webrtcbin linked to a tee, the signal may not fire reliably.
    // We need the room_id to be set first — if it's not yet, poll_negotiations
    // will pick it up later.
    {
        let ctx_clone = session.viewers.get(peer_id).unwrap().ctx.clone();
        let room_id = ctx_clone.lock().unwrap().room_id.clone();
        if !room_id.is_empty() {
            if let Err(e) = create_offer_for_viewer(session, peer_id) {
                warn!("initial create offer failed for {peer_id}: {e}");
            } else {
                info!("immediately created offer for viewer {peer_id}");
            }
        }
        // If room_id was empty, poll_negotiations will create the offer once
        // set_viewer_room is called.
    }

    Ok(())
}

/// Remove a viewer: unlink its webrtcbin from the tee, remove from pipeline,
/// release the tee src pad.
pub fn remove_viewer(session: &mut StreamSession, peer_id: &str) {
    let Some(entry) = session.viewers.remove(peer_id) else {
        return;
    };

    // Unlink tee -> capsfilter (the capsfilter's sink peer is the tee src pad).
    if let Some(cf_sink) = entry.capsfilter.static_pad("sink") {
        if let Some(tee_pad) = cf_sink.peer() {
            let _ = tee_pad.unlink(&cf_sink);
            session.tee.release_request_pad(&tee_pad);
        }
    }

    // Remove all elements from pipeline (NULL them first).
    let _ = entry.webrtcbin.set_state(gstreamer::State::Null);
    let _ = entry.capsfilter.set_state(gstreamer::State::Null);
    let _ = session.pipeline.remove(&entry.webrtcbin);
    let _ = session.pipeline.remove(&entry.capsfilter);

    info!("removed viewer {peer_id}");
}

// ---------------------------------------------------------------------------
// Per-viewer SDP / ICE
// ---------------------------------------------------------------------------

/// Create an offer for a specific viewer and ship it to the room.
pub fn create_offer_for_viewer(session: &StreamSession, peer_id: &str) -> Result<()> {
    let entry = session
        .viewers
        .get(peer_id)
        .context("viewer not found")?;

    let (room_id, viewer_peer_id) = {
        let c = entry.ctx.lock().unwrap();
        (c.room_id.clone(), c.peer_id.clone())
    };
    if room_id.is_empty() {
        return Err(anyhow!("viewer has no room attached"));
    }

    let out = session.out.clone();
    let webrtcbin = entry.webrtcbin.clone();

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
        let sdp_obj = match reply.get::<gstreamer_sdp::SDPMessage>("offer") {
            Ok(sdp) => sdp,
            Err(_) => match reply.get::<gstreamer::Structure>("offer") {
                Ok(stru) => match stru.get::<gstreamer_sdp::SDPMessage>("sdp") {
                    Ok(s) => s,
                    Err(_) => {
                        warn!("create-offer reply structure has no sdp message");
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
        info!("offer ready for viewer {viewer_peer_id}");
        let _ = webrtcbin.emit_by_name::<()>("set-local-description", &[&sdp_obj]);
        let _ = out.send(Client::RoomSdp {
            room_id,
            peer_id: viewer_peer_id,
            sdp: SdpMessage {
                sdp_type: "offer".into(),
                sdp: text,
            },
        });
    });

    let options = gstreamer::Structure::new_empty("create-offer-options");
    entry
        .webrtcbin
        .emit_by_name::<()>("create-offer", &[&promise, &options]);
    Ok(())
}

/// Set the room_id on a viewer's context (called after attach-ack).
pub fn set_viewer_room(session: &StreamSession, peer_id: &str, room_id: &str) {
    if let Some(entry) = session.viewers.get(peer_id) {
        entry.ctx.lock().unwrap().room_id = room_id.to_string();
    }
}

/// Feed a viewer's answer into its webrtcbin.
pub fn set_remote_description_for_viewer(
    session: &StreamSession,
    peer_id: &str,
    sdp_text: &str,
) -> Result<()> {
    let entry = session
        .viewers
        .get(peer_id)
        .context("viewer not found")?;
    let sdp = gstreamer_sdp::SDPMessage::parse_buffer(sdp_text.as_bytes())
        .context("viewer SDP is not valid")?;
    entry
        .webrtcbin
        .emit_by_name::<()>("set-remote-description", &[&sdp]);
    play(session)
}

/// Feed a remote ICE candidate into a viewer's webrtcbin.
pub fn add_remote_candidate_for_viewer(
    session: &StreamSession,
    peer_id: &str,
    candidate: &str,
) {
    if let Some(entry) = session.viewers.get(peer_id) {
        entry
            .webrtcbin
            .emit_by_name::<()>("add-ice-candidate", &[&0u32, &candidate]);
    }
}

// ---------------------------------------------------------------------------
// Pipeline state
// ---------------------------------------------------------------------------

pub fn play(session: &StreamSession) -> Result<()> {
    session
        .pipeline
        .set_state(gstreamer::State::Playing)
        .map(|_| ())
        .map_err(|_| anyhow!("could not set pipeline to PLAYING"))
}

fn pre_push_caps(_session: &StreamSession, webrtcbin: &gstreamer::Element) {
    let caps = match AV1_RTP_CAPS_STR.parse::<gstreamer::Caps>() {
        Ok(c) => c,
        Err(e) => {
            warn!("invalid AV1_RTP_CAPS_STR: {e}");
            return;
        }
    };
    let Some(sink_pad) = webrtcbin
        .pads()
        .into_iter()
        .find(|p| p.name().starts_with("sink_"))
    else {
        // webrtcbin may not have created sink_%u pads yet (happens on first
        // link); fall back to the static "sink" pad.
        if let Some(sink) = webrtcbin.static_pad("sink") {
            if let Some(peer) = sink.peer() {
                if !peer.push_event(gstreamer::event::Caps::new(&caps)) {
                    warn!("pre-push of AV1 caps was rejected (static sink)");
                }
            }
        } else {
            warn!("webrtcbin sink pad not found — cannot pre-push caps");
        }
        return;
    };
    if let Some(peer) = sink_pad.peer() {
        if !peer.push_event(gstreamer::event::Caps::new(&caps)) {
            warn!("pre-push of AV1 caps was rejected");
        } else {
            info!("pre-pushed AV1 caps onto webrtcbin sink pad");
        }
    }
}

pub fn stop(session: &StreamSession) -> Result<()> {
    session
        .pipeline
        .set_state(gstreamer::State::Null)
        .map(|_| ())
        .map_err(|_| anyhow!("could not set pipeline to NULL"))
}
