# M2 — Native AV1 + one viewer (design notes)

Goal (project.md §5, M2): the **native helper** captures the desktop on Windows, encodes
**one** real-time AV1 stream (hardware encoder preferred, `svtav1enc` software fallback),
and feeds it to **one** Chromium viewer over a WebRTC peer connection. STUN only.

**Exit condition:** helper captures → encodes AV1 once → one Chromium viewer receives a
stable live stream, with CPU/GPU usage measured.

## Decisions

- **Language/Runtime:** Rust (gstreamer-rs). Single static binary, no webview/runtime.
- **Signaling transport:** the helper is the room host, but carries SDP/ICE over its
  persistent `/ws/helper` channel (see `docs/signaling.md` · Helper room media signaling).
  No browser `/ws` connection, no browser↔localhost calls.
- **Protocol (M1 revisited):** the `start` command gains a `roomId` payload; the helper
  then sends `attach-room { roomId }` on `/ws/helper`; the server bridges room viewers↔helper.

## Pipeline (one peer, M2)

```
d3d11screencapturesrc|dxgiscreencapsrc
        ↓
    videoconvert → videorate
        ↓
    (hardware AV1: nvav1enc / qsvav1enc / vaapiav1enc)
        ↓ else
    svtav1enc (software, realtime-tunable)
        ↓
    rtpav1pay → webrtcbin (one peer in M2)
```

- Encode exactly once; a single `webrtcbin` is enough for M2. Fan-out to N peers changes
  this to `tee` → N `webrtcbin` (or `webrtcsink`) in M4 — no per-viewer re-encoding.
- Verify current GStreamer element names/plugins on the target install before finalizing
  (this area moves; `gst-inspect-1.0` is the source of truth).

## Helper crate layout

```
helper/
  src/
    main.rs        – entry, signal handling
    ws.rs          – tungstenite client: cookie auth, hello, ping/status, reconnect/backoff, acks
    signaling.rs   – attach-room + sdp/ice relay over /ws/helper
    pipeline.rs    – capture→encode→rtp→webrtcbin; encoder detection
    commands.rs    – start/stop/pick-source handling
```

Environment: dev-auth cookie via `POST /auth/dev` (like helper-stub), or a real
`SESSION_COOKIE` env var. GStreamer runtime must be installed on the host machine
(dev: probe with `gst-inspect-1.0`; distribution story is a later concern).

## Measuring (M2 exit)

- CPU/GPU: task-manager class numbers during a stream (rough is fine for M2).
- Confirm the selected ICE candidate pair is direct (`host`/`srflx`) — no TURN needed.

## Out of scope for M2

- TURN (M3), fan-out > 1 viewer (M4), host login/UX polish (M5).