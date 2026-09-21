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
use gstreamer::PadLinkCheck;
use log::{error, info, warn};

use crate::protocol::{Client, IceCandidate, SdpMessage};

// ---------------------------------------------------------------------------
// Per-viewer context (written by the app loop, read by signal callbacks)
// ---------------------------------------------------------------------------

/// Per-viewer ICE candidate-type tallies (diagnostics: how many host/srflx/
/// prflx/relay candidates were gathered locally vs received from the viewer).
/// A session settled on `host ⇄ host` with no srflx from the viewer, or one
/// that flapped between connected/completed, should be visible here.
#[derive(Clone, Default)]
pub struct IceDiag {
    pub local: HashMap<String, usize>,
    pub remote: HashMap<String, usize>,
}

impl IceDiag {
    /// "host: 3, srflx: 1" summary of a tally map ("none" when empty).
    pub fn tally(map: &HashMap<String, usize>) -> String {
        if map.is_empty() {
            return "none".into();
        }
        let mut parts: Vec<(&String, &usize)> = map.iter().collect();
        parts.sort_by(|a, b| b.1.cmp(a.1));
        parts
            .iter()
            .map(|(k, v)| format!("{k}: {v}"))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Parse the candidate type token ("host"/"srflx"/"prflx"/"relay"/…) out of an
/// ICE candidate attribute string, e.g. "candidate:41 1 udp … typ host …".
pub fn candidate_kind(candidate: &str) -> &str {
    let mut tokens = candidate.split_whitespace();
    while let Some(tok) = tokens.next() {
        if tok == "typ" {
            return tokens.next().unwrap_or("unknown");
        }
    }
    "unknown"
}

#[derive(Clone)]
pub struct ViewerContext {
    pub room_id: String,
    pub peer_id: String,
    /// Running ICE candidate-type tallies for this viewer.
    pub ice: IceDiag,
}

pub struct ViewerEntry {
    pub webrtcbin: gstreamer::Element,
    /// Queue sits between tee and webrtcbin. It provides a thread boundary and
    /// absorbs data flow so that dynamic pad linking in a PLAYING pipeline
    /// works reliably.
    pub queue: gstreamer::Element,
    pub ctx: Arc<Mutex<ViewerContext>>,
    /// Offer waiting to be applied via set-local-description.
    /// Created by create-offer, applied on the next poll_negotiations tick.
    pub pending_offer: Arc<Mutex<Option<gstreamer_webrtc::WebRTCSessionDescription>>>,
    /// Promises handed to webrtcbin that webrtcbin resolves asynchronously
    /// (set-local-description, set-remote-description). Rust must keep its
    /// handle alive until the change function fires, otherwise the promise is
    /// freed while still PENDING -> it expires and the description is never
    /// applied. The change function clears this list when it fires.
    pub pending_promises: Arc<Mutex<Vec<gstreamer::Promise>>>,
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
    /// STUN server (chosen from the backend's list by `stun::choose_server`).
    pub stun: String,
    pub out: tokio::sync::mpsc::UnboundedSender<Client>,
}

/// Fallback STUN used until the backend delivers its ICE server list (handshake
/// ordering guarantees this virtually never happens in practice).
pub const DEFAULT_STUN_SERVER: &str = "stun://stun.l.google.com:19302";

// ---------------------------------------------------------------------------
// Build the base pipeline (up to tee — no webrtcbin yet)
// ---------------------------------------------------------------------------

pub fn build(
    out: tokio::sync::mpsc::UnboundedSender<Client>,
    stun_server: &str,
) -> Result<StreamSession> {
    let desc = concat!(
        "d3d11screencapturesrc show-cursor=true ",
        "! d3d11convert ! video/x-raw(memory:D3D11Memory) ",
        "! d3d11download ! video/x-raw(memory:SystemMemory) ",
        "! videoconvert ! videorate ! videoscale ",
        "! video/x-raw,width=1280,height=720,framerate=30/1 ",
        "! svtav1enc preset=12 crf=36 intra-period-length=60 parameters-string=\"pred-struct=1\" ",
        "! av1parse ",
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
            MessageView::Warning(warn) => {
                warn!("stream warning: {} ({:?})", warn.error(), warn.debug());
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
        stun: stun_server.to_string(),
        out,
    })
}

// ---------------------------------------------------------------------------
// Add / remove viewers (dynamic webrtcbin instances)
// ---------------------------------------------------------------------------

/// Create a new webrtcbin for `peer_id`, link it to a fresh tee src pad
/// via a queue (standard tee fan-out pattern), and wire up signal handlers.
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

    // --- create queue + webrtcbin ---------------------------------------------
    // The queue sits between tee and webrtcbin. It provides a thread boundary
    // and absorbs data flow so dynamic pad linking in a PLAYING pipeline works.
    let queue = gstreamer::ElementFactory::make("queue")
        .property_from_str("name", &format!("q_{peer_id}"))
        .build()
        .context("failed to create queue")?;

    let webrtcbin = gstreamer::ElementFactory::make("webrtcbin")
        .property_from_str("name", &format!("wc_{peer_id}"))
        .build()
        .context("failed to create webrtcbin")?;
    webrtcbin.set_property_from_str("stun-server", &session.stun);
    info!("viewer {peer_id}: using STUN server {}", session.stun);

    // --- guarantee a media m-line in the offer ---------------------------------
    // Pre-configure a sendonly AV1 transceiver so the SDP offer always contains
    // a video m-line, even when a viewer joins before the first RTP packet with
    // stream caps arrives (which otherwise yields an empty offer). The media
    // branch links below to its own (second) transceiver via the requested sink
    // pad; the browser keys on the sendrecv one. This keeps the offer valid in
    // every environment while the deterministic tee-last linking handles the
    // black-screen race.
    let av1_rtp_caps = "application/x-rtp,media=video,encoding-name=AV1,payload=96,clock-rate=90000"
        .parse::<gstreamer::Caps>()
        .context("invalid AV1 RTP caps")?;
    {
        let _trans: Option<gstreamer_webrtc::WebRTCRTPTransceiver> = webrtcbin.emit_by_name(
            "add-transceiver",
            &[&gstreamer_webrtc::WebRTCRTPTransceiverDirection::Sendonly, &av1_rtp_caps],
        );
    }

    session
        .pipeline
        .add_many([&queue, &webrtcbin])
        .context("cannot add elements to pipeline")?;

    // --- link: queue -> webrtcbin ----------------------------------------------
    // Wire the branch between tee and webrtcbin while the tee is NOT yet
    // linked, so the live tee never pushes into it during setup. Use link_full
    // with empty PadLinkCheck to bypass the caps compatibility check that fails
    // when linking to a request pad; caps are negotiated at runtime.
    {
        let q_src = queue.static_pad("src").context("queue has no src")?;
        let wb_sink_template = webrtcbin
            .pad_template("sink_%u")
            .context("webrtcbin has no sink_%u pad template")?;
        let wb_sink = webrtcbin
            .request_pad(&wb_sink_template, None, Some(&av1_rtp_caps))
            .context("could not request webrtcbin sink pad")?;
        q_src
            .link_full(&wb_sink, PadLinkCheck::empty())
            .map_err(|e| anyhow!("could not link queue -> webrtcbin: {e}"))?;
    }

    // Let the new elements adopt the pipeline's running state.
    queue
        .sync_state_with_parent()
        .context("queue sync_state failed")?;
    webrtcbin
        .sync_state_with_parent()
        .context("webrtcbin sync_state failed")?;

    // --- wait until the branch is active ---------------------------------------
    // The state change above is asynchronous; the tee is already PLAYING and
    // pushes a copy of every buffer to each linked src pad. If the tee is
    // linked before this branch is active, the first push returns
    // GST_FLOW_FLUSHING, which propagates upstream and permanently stalls the
    // whole pipeline (the intermittent black-screen bug: the viewer's branch
    // receives zero buffers). Wait (non-blocking, short poll) for the queue's
    // sink pad to become active, THEN link the tee pad.
    {
        let q_sink = queue.static_pad("sink").context("queue has no sink")?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while !q_sink.is_active() {
            if std::time::Instant::now() >= deadline {
                warn!("queue sink pad for {peer_id} did not become active in 1s");
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    // --- link: tee_src_pad -> queue.sink (LAST) -------------------------------
    // The branch is fully active now, so the live tee's push into it succeeds.
    {
        let q_sink = queue.static_pad("sink").context("queue has no sink")?;
        tee_src_pad
            .link_full(&q_sink, PadLinkCheck::empty())
            .map_err(|e| anyhow!("could not link tee -> queue: {e}"))?;
    }

    // --- per-viewer state -----------------------------------------------------
    let ctx = Arc::new(Mutex::new(ViewerContext {
        room_id: String::new(), // filled in after attach-ack
        peer_id: peer_id.to_string(),
        ice: IceDiag::default(),
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
        // GStreamer signals end-of-candidates with an empty candidate string;
        // that is not a real ICE candidate and must not be forwarded.
        if candidate.is_empty() {
            let tally = {
                let c = ctx_ice.lock().unwrap();
                IceDiag::tally(&c.ice.local)
            };
            info!("viewer candidate gathering finished for m-line {mline} — local candidates [{tally}]");
            return None;
        }
        let (room_id, peer_id) = {
            let mut c = ctx_ice.lock().unwrap();
            if c.room_id.is_empty() || c.peer_id.is_empty() {
                warn!(
                    "ICE candidate fired but dropped (room={:?} peer={:?}): {candidate}",
                    c.room_id, c.peer_id
                );
                return None;
            }
            let kind = candidate_kind(&candidate);
            *c.ice.local.entry(kind.to_string()).or_insert(0) += 1;
            (c.room_id.clone(), c.peer_id.clone())
        };
        info!("local ICE candidate (m={mline}) for viewer {peer_id}: {candidate}");
        let _ = out_ice.send(Client::RoomIce {
            room_id,
            peer_id,
            candidate: IceCandidate::full_candidate(candidate, mline),
        });
        None
    });

    info!("added viewer {peer_id} (tee pad {pad_name})");

    session.viewers.insert(
        peer_id.to_string(),
        ViewerEntry {
            webrtcbin,
            queue,
            ctx,
            pending_offer: Arc::new(Mutex::new(None)),
            pending_promises: Arc::new(Mutex::new(Vec::new())),
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

/// Remove a viewer: unlink its queue from the tee, remove from pipeline,
/// release the tee src pad.
pub fn remove_viewer(session: &mut StreamSession, peer_id: &str) {
    let Some(entry) = session.viewers.remove(peer_id) else {
        return;
    };

    // Unlink tee -> queue (the queue's sink peer is the tee src pad).
    if let Some(q_sink) = entry.queue.static_pad("sink") {
        if let Some(tee_pad) = q_sink.peer() {
            let _ = tee_pad.unlink(&q_sink);
            session.tee.release_request_pad(&tee_pad);
        }
    }

    // Remove all elements from pipeline (NULL them first).
    let _ = entry.webrtcbin.set_state(gstreamer::State::Null);
    let _ = entry.queue.set_state(gstreamer::State::Null);
    let _ = session.pipeline.remove(&entry.webrtcbin);
    let _ = session.pipeline.remove(&entry.queue);

    info!("removed viewer {peer_id}");
}

// ---------------------------------------------------------------------------
// Per-viewer SDP / ICE
// ---------------------------------------------------------------------------

/// Create an offer for a specific viewer. The offer is stored in `pending_offer`
/// and applied via `set-local-description` on the next `apply_pending_offers`
/// call; the SDP is only sent to the viewer once that local description is in
/// place (see `apply_pending_offers` for why the order matters).
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

    let pending = entry.pending_offer.clone();

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
        let offer = match reply.get::<gstreamer_webrtc::WebRTCSessionDescription>("offer") {
            Ok(o) => o,
            Err(e) => {
                warn!("create-offer reply missing 'offer' field: {e}");
                return;
            }
        };
        info!("offer ready for viewer {viewer_peer_id} — deferring send until set-local-description");

        // Store the offer so apply_pending_offers can call set-local-description
        // from the main loop (avoiding reentrancy inside the create-offer callback).
        //
        // The SDP is intentionally NOT sent from here: it is sent only after the
        // local description has been applied. Otherwise the viewer can answer
        // before webrtcbin enters the `have-local-offer` state, and the answer is
        // then rejected by set-remote-description — leaving the peer connection
        // negotiated but with no media (black screen for the viewer).
        *pending.lock().unwrap() = Some(offer);
    });

    let options = gstreamer::Structure::new_empty("create-offer-options");
    entry
        .webrtcbin
        .emit_by_name::<()>("create-offer", &[&options, &promise]);
    Ok(())
}

/// Apply any pending offers via set-local-description.
/// Called from poll_negotiations on the main loop tick.
pub fn apply_pending_offers(session: &StreamSession) {
    for (peer_id, entry) in &session.viewers {
        let offer = entry.pending_offer.lock().unwrap().take();
        let Some(offer) = offer else { continue };

        let (room_id, viewer_peer_id) = {
            let c = entry.ctx.lock().unwrap();
            (c.room_id.clone(), c.peer_id.clone())
        };
        let text = offer.sdp().to_string();
        info!("applying set-local-description for viewer {peer_id}");
        let webrtcbin = entry.webrtcbin.clone();
        let vp_id = peer_id.clone();
        let pending = entry.pending_promises.clone();
        let out = session.out.clone();
        let promise = gstreamer::Promise::with_change_func(move |res| {
            match res {
                Ok(_) => {
                    info!("set-local-description OK for viewer {vp_id}");
                    // webrtcbin is now in `have-local-offer`. Only now do we send
                    // the offer, so the viewer's answer can never arrive before we
                    // are ready to accept it.
                    if !room_id.is_empty() {
                        let _ = out.send(Client::RoomSdp {
                            room_id: room_id.clone(),
                            peer_id: viewer_peer_id.clone(),
                            sdp: SdpMessage {
                                sdp_type: "offer".into(),
                                sdp: text.clone(),
                            },
                        });
                        info!("offer sent for viewer {vp_id}");
                    }
                }
                Err(e) => warn!("set-local-description error for viewer {vp_id}: {e:?}"),
            }
            // The promise is done for good (resolved/expired/interrupted);
            // release everything we were holding open for this viewer.
            pending.lock().unwrap().clear();
        });
        // Keep the Promise alive until the change function fires: webrtcbin may
        // resolve this promise asynchronously, after emit_by_name returns.
        entry.pending_promises.lock().unwrap().push(promise.clone());
        webrtcbin.emit_by_name::<()>("set-local-description", &[&offer, &promise]);
    }
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
    let desc = gstreamer_webrtc::WebRTCSessionDescription::new(
        gstreamer_webrtc::WebRTCSDPType::Answer,
        sdp,
    );
    let webrtcbin = entry.webrtcbin.clone();
    let vp_id = peer_id.to_string();
    let pending = entry.pending_promises.clone();
    let promise = gstreamer::Promise::with_change_func(move |res| {
        match res {
            Ok(_) => info!("set-remote-description OK for viewer {vp_id}"),
            Err(e) => warn!("set-remote-description error for viewer {vp_id}: {e:?}"),
        }
        pending.lock().unwrap().clear();
    });
    // Keep the Promise alive until the change function fires (see apply_pending_offers).
    entry.pending_promises.lock().unwrap().push(promise.clone());
    webrtcbin.emit_by_name::<()>("set-remote-description", &[&desc, &promise]);
    play(session)
}

/// Feed a remote ICE candidate into a viewer's webrtcbin.
pub fn add_remote_candidate_for_viewer(
    session: &StreamSession,
    peer_id: &str,
    mline: u32,
    candidate: &str,
) {
    if let Some(entry) = session.viewers.get(peer_id) {
        entry
            .webrtcbin
            .emit_by_name::<()>("add-ice-candidate", &[&mline, &candidate]);
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

pub fn stop(session: &StreamSession) -> Result<()> {
    session
        .pipeline
        .set_state(gstreamer::State::Null)
        .map(|_| ())
        .map_err(|_| anyhow!("could not set pipeline to NULL"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pipeline_offer() {
        gstreamer::init().unwrap();
        let (out, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut session = build(out, DEFAULT_STUN_SERVER).expect("build pipeline");
        play(&session).expect("play pipeline");
        let peer_id = "test-viewer-1";
        add_viewer(&mut session, peer_id).expect("add viewer");
        set_viewer_room(&session, peer_id, "room-123");

        // M6: the webrtcbin must be wired to the chosen STUN server (here the
        // fallback default since no backend config exists in the unit test).
        let entry = session.viewers.get(peer_id).unwrap();
        let stun_val = entry
            .webrtcbin
            .property::<gstreamer::glib::Value>("stun-server");
        let stun_set = match stun_val.get::<String>() {
            Ok(s) => s,
            Err(_) => format!("{stun_val:?}"),
        };
        assert!(
            stun_set.contains(DEFAULT_STUN_SERVER),
            "webrtcbin stun-server should be {DEFAULT_STUN_SERVER}, got {stun_set:?}"
        );

        let src_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let enc_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let pay_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let tee_sink_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let sc = src_count.clone();
        if let Some(src) = session.pipeline.by_name("d3d11screencapturesrc0") {
            if let Some(pad) = src.static_pad("src") {
                pad.add_probe(gstreamer::PadProbeType::BUFFER, move |_, _| {
                    sc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    gstreamer::PadProbeReturn::Ok
                });
            }
        }
        let dl_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let vconv_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let vrate_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let vscale_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let enc_sink_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let dlc = dl_count.clone();
        if let Some(e) = session.pipeline.by_name("d3d11download0") {
            if let Some(pad) = e.static_pad("src") {
                pad.add_probe(gstreamer::PadProbeType::BUFFER, move |_, _| {
                    dlc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    gstreamer::PadProbeReturn::Ok
                });
            }
        }
        let vcc = vconv_count.clone();
        if let Some(e) = session.pipeline.by_name("videoconvert0") {
            if let Some(pad) = e.static_pad("src") {
                pad.add_probe(gstreamer::PadProbeType::BUFFER, move |_, _| {
                    vcc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    gstreamer::PadProbeReturn::Ok
                });
            }
        }
        let vrc = vrate_count.clone();
        if let Some(e) = session.pipeline.by_name("videorate0") {
            if let Some(pad) = e.static_pad("src") {
                pad.add_probe(gstreamer::PadProbeType::BUFFER, move |_, _| {
                    vrc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    gstreamer::PadProbeReturn::Ok
                });
            }
        }
        let vsc = vscale_count.clone();
        if let Some(e) = session.pipeline.by_name("videoscale0") {
            if let Some(pad) = e.static_pad("src") {
                pad.add_probe(gstreamer::PadProbeType::BUFFER, move |_, _| {
                    vsc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    gstreamer::PadProbeReturn::Ok
                });
            }
        }
        let esc = enc_sink_count.clone();
        if let Some(e) = session.pipeline.by_name("svtav1enc0") {
            if let Some(pad) = e.static_pad("sink") {
                pad.add_probe(gstreamer::PadProbeType::BUFFER, move |_, _| {
                    esc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    gstreamer::PadProbeReturn::Ok
                });
            }
        }
        let pc = pay_count.clone();
        if let Some(pay) = session.pipeline.by_name("rtpav1pay0") {
            if let Some(pad) = pay.static_pad("src") {
                pad.add_probe(gstreamer::PadProbeType::BUFFER, move |_, _| {
                    pc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    gstreamer::PadProbeReturn::Ok
                });
            }
        }
        let tc = tee_sink_count.clone();
        if let Some(pad) = session.tee.static_pad("sink") {
            pad.add_probe(gstreamer::PadProbeType::BUFFER, move |_, _| {
                tc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                gstreamer::PadProbeReturn::Ok
            });
        }

        let buffer_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let bc = buffer_count.clone();
        let entry = session.viewers.get(peer_id).unwrap();
        let q_sink = entry.queue.static_pad("sink").unwrap();
        q_sink.add_probe(gstreamer::PadProbeType::BUFFER, move |_pad, _info| {
            bc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            gstreamer::PadProbeReturn::Ok
        });

        create_offer_for_viewer(&session, peer_id).expect("create offer");

        // Iterate main context to process the create-offer promise, which only
        // stores the offer in `pending_offer` (nothing is sent yet).
        for _ in 0..100 {
            gstreamer::glib::MainContext::default().iteration(false);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        // Apply the offer locally. The SDP is only sent to the viewer once
        // set-local-description succeeds, so the viewer's answer cannot race
        // ahead of webrtcbin entering `have-local-offer`.
        apply_pending_offers(&session);

        for _ in 0..100 {
            gstreamer::glib::MainContext::default().iteration(false);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        // Collect messages: expect the SDP offer (ICE candidates may interleave).
        let mut got_offer = false;
        let mut ice_candidates = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            if let Client::RoomIce { candidate, .. } = &msg {
                ice_candidates.push(candidate.clone());
            }
            if let Client::RoomSdp { room_id, peer_id, sdp } = &msg {
                println!("Got SDP offer for room {room_id}, peer {peer_id}:\n{}", sdp.sdp);
                got_offer = true;
            }
            println!("Got message from out channel: {msg:?}");
        }
        assert!(got_offer, "should receive SDP offer");
        assert!(!ice_candidates.is_empty(), "Should have gathered ICE candidates");

        // Now test setting remote answer
        let answer_sdp = concat!(
            "v=0\r\n",
            "o=- 1234567890 2 IN IP4 127.0.0.1\r\n",
            "s=-\r\n",
            "t=0 0\r\n",
            "a=ice-options:trickle\r\n",
            "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n",
            "c=IN IP4 0.0.0.0\r\n",
            "a=setup:active\r\n",
            "a=ice-ufrag:viewerUfrag1234\r\n",
            "a=ice-pwd:viewerPassword12345678901234\r\n",
            "a=rtcp-mux\r\n",
            "a=rtcp-rsize\r\n",
            "a=recvonly\r\n",
            "a=rtpmap:96 AV1/90000\r\n",
            "a=mid:video0\r\n",
            "a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00\r\n"
        );
        set_remote_description_for_viewer(&session, peer_id, answer_sdp)
            .expect("set remote description");

        for _ in 0..100 {
            gstreamer::glib::MainContext::default().iteration(false);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        println!("src: {}, dl: {}, vconv: {}, vrate: {}, vscale: {}, enc_sink: {}, enc_src: {}, pay: {}, tee_sink: {}, queue: {}",
            src_count.load(std::sync::atomic::Ordering::SeqCst),
            dl_count.load(std::sync::atomic::Ordering::SeqCst),
            vconv_count.load(std::sync::atomic::Ordering::SeqCst),
            vrate_count.load(std::sync::atomic::Ordering::SeqCst),
            vscale_count.load(std::sync::atomic::Ordering::SeqCst),
            enc_sink_count.load(std::sync::atomic::Ordering::SeqCst),
            enc_count.load(std::sync::atomic::Ordering::SeqCst),
            pay_count.load(std::sync::atomic::Ordering::SeqCst),
            tee_sink_count.load(std::sync::atomic::Ordering::SeqCst),
            buffer_count.load(std::sync::atomic::Ordering::SeqCst),
        );
        stop(&session).unwrap();
    }
}

