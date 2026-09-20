# Milestones

Derived from `project.md` §5 (milestones 0–5). M1 ships in this repo; M0's remaining
scope (connection diagnostics) is being finished now.

| # | Deliverable | Status |
| --- | --- | --- |
| M0 | **Signaling proof** — browser host/viewer harness, minimum SDP/ICE relay, STUN only, connection diagnostics (ICE state, candidate type `host`/`srflx`/`relay`, RTT, packet loss, bitrate, FPS, resolution) | ✅ |
| M1 | **Helper presence and control** — persistent helper WS, authentication + presence (`online`/`offline`), host-browser command API (start, stop, basic source), stub helper, no browser↔localhost calls | ✅ |
| M2 | **Native AV1 + one viewer** — Windows screen capture, GStreamer → AV1 (hardware encoder preferred, `svtav1enc` fallback), one real-time stream, one WebRTC peer to one Chromium viewer, STUN first, CPU/GPU measured | ❌ |
| M3 | **TURN as optional host-provided recovery** — STUN first, retry with host-provided TURN when direct ICE fails, clear host-facing error if no TURN is configured, never an implicit GoLive relay | ❌ |
| M4 | **Encode once, multiple viewers** — single AV1 encoder fanned into one peer connection per viewer (2–3 then ~10), upload/quality impact measured and surfaced | ❌ |
| M5 | **Permissions and polish** — Discord OAuth identity + room ownership, viewer allowlist, TURN restricted to allowed viewers, room-link UX, helper reconnect/backoff, source picker, bandwidth/error indicators | ❌ |

## M0 scope checklist

Signaling proof — the browser host/viewer harness predates M2's native path, so it stays
as the test instrument.

- [x] Browser host ⇄ viewer over the relay: SDP offer/answer + ICE candidates, role enforcement (host = room owner, one host per room)
- [x] Public STUN only (no TURN yet)
- [x] AV1-preferred codec negotiation; recv-only viewer transceiver
- [x] Connection diagnostics in the UI — ICE state, selected candidate type (`host`/`srflx` = direct, `relay` = relayed), RTT, packet loss, bitrate, FPS, resolution (viewer page + host test-broadcast card)
- [x] Host page: helper-status gate + browser-emulated test host; clear errors when no host/helper signal arrives; 60s no-signal prompt
- [x] Work/legacy already committed while this repo used the older plan (kept as the signaling foundation): monorepo + shared types, Discord OAuth + dev-auth fallback, rooms, WebSocket relay, helper presence/command endpoints, helper stub, unit tests

**Exit condition:** one browser-to-browser stream works reliably on direct connectivity,
and the UI can distinguish a direct (`host`/`srflx`) path from a relayed (`relay`) path. ✅

## M1 scope checklist

Trustworthy presence + real command acks through the same relay the native helper will use.

- [x] Presence requires a `hello` handshake (version carried) — pending conns that don't hello within 10s are closed (`hello_timeout`); frames before hello → `hello_required`
- [x] Server heartbeat: `ping` every 10s; helpers must send frames; stale helpers (>30s silent) reported offline and dropped (`stale`)
- [x] One helper per account, last-wins: reconnecting helper supersedes and closes the old connection (`superseded`)
- [x] `ack { id, ok, state?, detail? }` message — helper echoes the command id
- [x] Server records lastCommand result (joined by id) and exposes it via `GET /api/helper/status` (`lastCommand`, `helperVersion`)
- [x] `POST /api/helper/command` returns `{ delivered, id }`; 64-char command length guard
- [x] Helper stub acks every command (start → live, stop → idle) and answers pings with status
- [x] Host page shows helper version + surfaces ack results ("accepted · now live" / "REJECTED — reason")
- [x] Unit tests for the registry (handshake, supersede, staleness, ack join, rejected ack, rogue conn)

**Exit condition:** the host browser can detect the helper and send commands to it end to
end through the backend. ✅

## M2 scope checklist (next)

Native AV1 + one viewer. See `docs/m2-helper.md` for the design notes.

- [ ] Helper media signaling rides the persistent `/ws/helper` channel (room attach + SDP/ICE relay)
- [ ] Rust helper binary: WS connection (cookie auth, hello, ping/status, reconnect/backoff, command acks)
- [ ] GStreamer pipeline: Windows screen capture → `videoconvert`/`videorate` → AV1 (hardware preferred, `svtav1enc` fallback) → RTP → one `webrtcbin` peer
- [ ] STUN first (no TURN required for the test)
- [ ] Measure CPU/GPU during the stream
- [ ] E2E: backend + helper + one Chromium viewer receives a stable live stream

**Exit condition:** the native helper captures the desktop, encodes AV1 once, and one
Chromium viewer receives a stable live stream.

## Notes for later milestones

- Signaling state lives in memory (single process). Multi-process/durable storage is deferred until it's actually needed (M5+).
- Session store is also in-memory; rotate to signed stateless cookies or a DB when deploying multi-process.
- The browser-emulated host is a *test* instrument, not a product path — the real host is the native helper (M2+).
- TURN (M3) is optional STUN-first recovery only; there is never a GoLive/shared TURN fallback (see `project.md` §4.3).