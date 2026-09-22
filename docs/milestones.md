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
| M5 | **Permissions and polish** — Discord OAuth identity + room ownership for **hosts only**, **anonymous viewers via the room link (no allowlist)**, host-provided TURN, room-link UX, helper reconnect/backoff, source picker, bandwidth/error indicators | ❌ |
| M6 | **P2P NAT traversal (no TURN)** — multiple public STUN servers (backend-driven, helper probes & pins a reachable one), full trickle ICE verified end-to-end, IPv6/ICE-TCP candidates kept, candidate-type diagnostics for failed direct connections, TURN stays optional recovery | ✅ (P2P proven across residential NATs; strict cellular CGNAT classified as TURN-required; IPv6 candidates gathered where available; UPnP/NAT-PMP deferred to M8) |
| M7 | **Connection diagnostics + NAT regression suite** — final transport path shown at candidate granularity (`direct host`/`srflx`/`prflx` vs `TURN relay`), timing metrics (gather / check / time-to-first-frame / RTT / loss / bitrate / disconnect reason), repeatable network matrix re-run after networking changes | ◐ (working: granular path + timing metrics + matrix runner + LAN baseline + helper `nat-test` self-test; field re-tests pending) |
| M8 | **Optional native NAT-assistance experiments** — probe & verify router-assisted port mapping (UPnP IGD / NAT-PMP) in the helper and decide whether it earns a permanent place | ◐ (experiment command `nat-map` + webrtcbin port-pinning verdict; see checklist below) |

## M6 scope checklist

- [x] Multiple public STUN servers — backend `iceServers` list → helper probes & pins a reachable one (`stun.rs choose_server`, verify-with-second-pin)
- [x] Full trickle ICE end-to-end — every local candidate forwarded immediately through signaling; every remote candidate applied on arrival; end-of-candidates marker not treated as a candidate
- [x] `iceTransportPolicy` stays default `all` (host/srflx/prflx before TURN)
- [x] Gathering/checks never stopped prematurely while connecting
- [x] Candidate types preserved & exposed in diagnostics — `host`/`srflx`/`prflx`/`relay` tallies (helper settle line + watch page)
- [x] IPv6 — IPv6 candidates gathered & kept by default (`webrtcbin`); tested networks show the cellular path has no IPv6 (carrier 464XLAT/CGNAT), the home keeps both families. `webrtcbin` has no explicit preference knob; keeping candidates covers it
- [x] Detailed diagnostics for failed direct connections — helper `ICE settled ({state}) after {N}s — local […], remote […]` + full state trail; watch-page `stallDiagnosis` buckets (failed / transport / decode), candidate-kind summary, AV1 decode probe, carrier-CGNAT (100.64/10) classification
- [x] NAT test/record mode — folded into the M7 regression matrix below; each real-network test already recorded there
- [ ] UPnP / NAT-PMP / PCP — deferred to M8 (optional host-side enhancement)

**Validated networks (seeds for the M7 matrix):**

| Network | Result | Path |
| --- | --- | --- |
| Helper host LAN (`repro.mjs` harness) | works | direct host |
| Tailscale overlay (phone ⇄ PC on tailnet) | works | direct host (tailnet) |
| Residential NAT ⇄ residential NAT (friend's PC, normal home router) | works | direct srflx |
| Residential NAT ⇄ carrier CGNAT (Android Chrome, cellular, no IPv6) | fails — **TURN-required** | strict CGNAT blocks srflx; viewer host addr in 100.64.0.0/10 |

**Exit condition:** P2P succeeds across the representative networks (LAN + two home routers),
and every failure explicitly identifies whether TURN is required (CGNAT classification +
transport/decode buckets). ✅

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

## M7 scope checklist (connection diagnostics + NAT regression suite)

- [x] Granular final transport path at candidate kind — `direct host` / `srflx` / `prflx` vs `TURN relay`, in the watch stats line + host viewer card (`pathInfo`)
- [x] Connection timing metrics — ICE gather time, ICE check/first-frame timing, RTT, loss, bitrate, FPS resolution; disconnect reason (`Peer <state> after Ns`) in the watch log
- [x] Failed sessions render NO PATH once; watch `stallDiagnosis` buckets (failed / transport / decode) + carrier-CGNAT (100.64/10) note
- [x] Helper settle line logs `ICE settled ({state}) after {N}s — local […], remote […]` with candidate tallies
- [x] Repeatable matrix runner — `tools/repro/repro.mjs` (`--label`, `--trials`, `--seconds`, `--json`), JSONL row-separation guard, per-trial records; `tools/repro/README.md` catalog
- [x] Network matrix seeded + LAN baseline snapshot (5×20s, all WORKS, direct host) as the committed green reference
- [x] Helper NAT self-test — `nat-test` command: same-socket probes against 2 distinct public STUN endpoints (Google + Cloudflare in defaults), endpoint-dependence verdict, CGNAT/private/double-NAT detection, best-effort global-IPv6 reflexive probe; verdict line surfaces on the host page
- [ ] Field re-tests to grow the matrix (e.g. second residential network on the phone; re-run LAN leg after any networking/signaling change)

**Exit condition:** the matrix re-runs green on the networks tested, and the host can
see *why* their own network classifies the way it does (`nat-test`) before a viewer joins.

## M8 scope checklist (optional native NAT-assistance experiments)

Experiments only; `project.md` §5 exit condition explicitly allows "leave it out".

- [x] `nat-map` helper command — **discovery + mapping + verification + cleanup**:
  - SSDP `M-SEARCH` for UPnP IGD (ephemeral + 1900 source ports), device-description XML → `WANIPConnection`/`WANPPPConnection` service `controlURL`
  - NAT-PMP probe (op 0) against gateway candidates — `ipconfig` (locale-independent), plus derived `.1`/`.254` from the local interface IP
  - If supported: `AddPortMapping`/`DeletePortMapping` (SOAP) or NAT-PMP `MapUDP` (lease 3600, delete = lifetime 0), then **same-socket STUN** — does the srflx equal the mapped external ip:port?
  - Runs opt-in (command), fully degradable; report via ack detail + host-page button `NAT-map probe`
- [x] Port-pinning verdict (M8 #4): `webrtcbin` exposes **no source-port/port-range property** (verified with `gst-inspect-1.0`), so libnice always picks the ICE socket's ephemeral port — a router mapping for any other port can *never* become the srflx candidate on this stack
- [x] Home-network live run: router offers **no** UPnP (0 SSDP IGD replies) and **no** NAT-PMP (26.0.0.1 / 192.168.2.1 / 192.168.2.254 unanswered) → "nothing to map; srflx ICE already covers this network"
- [ ] PCP — same diagnostic path *where a router actually supports NAT-PMP*; home/PCP not probed (gateway silent on 5351)
- [ ] Success-rate comparison with assistance disabled/enabled (needs a NAT-assist-capable network — e.g. friend's router when the field re-test is back on)
  - Expected per the port-pinning verdict: even a working mapping won't be used by ICE, so no success-rate delta
- [x] Unit tests (8 new): SSDP LOCATION parse, service/controlURL extraction, tag parsing, relative URL join, SOAP body + fault detection, NAT-PMP request build + probe/MapUDP response parse, HTTP body split — 18 total pass

**Exit condition (project.md):** any native NAT assistance is demonstrably useful on tested
networks and does not make normal connections less reliable; if little benefit, leave it out.
Current evidence (no router support on the tested network + no ICE port-pinning on
`webrtcbin`) points to **leave it out**; keep `nat-map` as an opt-in diagnostic.

## Notes for later milestones

- Signaling state lives in memory (single process). Multi-process/durable storage is deferred until it's actually needed (M5+).
- Session store is also in-memory; rotate to signed stateless cookies or a DB when deploying multi-process.
- The browser-emulated host is a *test* instrument, not a product path — the real host is the native helper (M2+).
- TURN (M3) is optional STUN-first recovery only; there is never a GoLive/shared TURN fallback (see `project.md` §4.3).