# golive — Native AV1 Broadcast Host

## 1. What this is

A low-latency, zero-cost, small-audience (≤10 viewers) live streaming tool.

- **Viewer**: a web page (`golive.puhl.dev/watch/{roomId}`)  .
- **Host UI**: the *same* web frontend as the viewer (no separate app to build), with a
  "host mode" that unlocks once a native helper is detected as connected — see §3.
- **Native helper**: a small, headless background process (no GUI, not a Tauri app) that
  does the actual screen capture and AV1 encoding, and fans a single encode out to each
  connected viewer directly (mesh — see §3 for why no SFU is used).
- **Transport**: WebRTC mesh — helper connects directly to each viewer. NAT traversal
  uses STUN first. TURN is optional and host-provided when needed.
- **TURN is host-provided and optional** — each host can bring/own their own TURN
  credentials rather than relying on a shared third-party quota. STUN is always tried
  first. If direct connectivity cannot be established and the host has not configured
  TURN, the connection stops with a clear error telling the host that a TURN server
  is required. There is **no fallback to a GoLive/shared TURN server**.

- **Auth**: Discord OAuth — used **for hosts only** (room ownership + helper control).
  Viewers are anonymous: the room link is enough. There is no viewer allowlist.

Codec scope for v1: **AV1 only**. No fallback codec, no transcoding.

## 2. Constraints (don't violate these)

- **$0 infrastructure cost**, and no shared quota that scales badly as more people run
  this — each host supplies their own TURN relay, so cost/capacity is distributed per
  host rather than centralized.
- No self-hosted signaling or TURN server run *from the host's own machine*, since the
  operator's router blocks inbound connections — anything that needs a public IP
  (signaling, TURN) runs on a small always-reachable service the host deploys
  ( a small VPS).
- **No direct browser-to-localhost communication.** The host browser and the native
  helper run on the same machine but must never call each other directly. This is
  deliberate: it sidesteps Chrome's evolving Local Network Access / Private Network
  Access restrictions (a permission layer specifically targeting public HTTPS pages
  calling `localhost`/private-network addresses, currently being rolled out and still
  changing) entirely, rather than building against a moving target.
- ≤10 concurrent viewers per room. Do not over-engineer for scale beyond this.
- Host machine may be behind an arbitrary home NAT; assume no port forwarding, no
  static IP, no UPnP guarantee. STUN may be enough, but TURN is required when the
  network cannot establish a direct peer connection.
- **Accepted tradeoff**: since there is no SFU, the host's *upload* bandwidth must
  support roughly `bitrate × concurrent viewer count`. Consider surfacing an estimated
  required upload bandwidth in the host UI based on chosen quality × viewer cap.

## 3. Architecture

```mermaid
flowchart LR
    subgraph HostMachine["Host machine"]
        Browser["Host browser<br/>(host mode UI)"]
        Helper["Native helper<br/>capture, encode"]
    end

    Backend["Shared backend<br/>signaling + TURN creds"]

    subgraph ViewerSide["Viewer"]
        Page["Viewer browser<br/>watch page"]
    end

    Browser -- "start/stop, TURN config" --> Backend
    Helper -- "persistent outbound connection<br/>(status + relayed commands)" --> Backend
    Backend -- "auth, room join, TURN creds" --> Page
    Helper == "direct WebRTC media<br/>STUN, TURN fallback" ==> Page
```

Note what's *not* there: no line between "Host browser" and "Native helper" — despite
running on the same machine, they never talk to each other directly. Both only ever
connect outward to the shared backend, which relays control commands between them. This
is the mechanism that avoids browser-to-localhost calls entirely (see §2).

### Why no SFU

An SFU solves two distinct problems, only one of which still applies here:

1. **Single encode instead of one encode per viewer** — solved without an SFU, since the
   native helper encodes once and duplicates the already-encoded RTP packets across each
   outgoing peer connection (no per-viewer re-encoding).
2. **Single upload instead of one upload per viewer** — an SFU is the only thing that
   removes this, since TURN only relays what it's given; it doesn't multiply it. Without
   an SFU, the helper's upload bandwidth genuinely scales with viewer count. **This is
   the one tradeoff we're accepting**, in exchange for not depending on a shared
   external relay/quota.

If this ever becomes a real problem (helper's upload insufficient for the desired
viewer count/quality), reintroducing an SFU is the fix — flag as a possible v2
direction, not needed now.

## 4. Components

### 4.1 Host browser (UI)

No separate app to build here. The same frontend that serves `watch/{roomId}` gains a
"host mode":

1. After login, ask the shared backend whether a native helper is currently connected
   for this account (see §4.3 — the backend already knows, since the helper maintains a
   persistent connection to it).
2. If connected, unlock host controls: pick capture source, configure TURN,
   start/stop, show the room link, live bandwidth/quality indicator.
3. Every control action is a normal API call to the shared backend (same pattern already
   used for room state) — the backend forwards it to the helper over the existing
   persistent connection. The browser never calls the helper directly.
4. If no helper is connected, show a prompt to download/run it, with no host controls.

### 4.2 Native helper

Headless background process — no GUI window required (a system tray icon for user
comfort is optional, but there's no webview to bundle, so this is not a Tauri app).

Responsibilities:

1. On startup, open a persistent outbound connection (e.g. a WebSocket) to the shared
   backend and authenticate as this host's helper. This connection is both the presence
   signal ("helper is online") and the control channel (receives start/stop/pick-source
   commands relayed from the host browser).
2. Let the backend-relayed commands drive capture source selection.
3. Encode captured frames as AV1, in real time, **once**.
4. Open one WebRTC peer connection per connected viewer, feeding each the **same**
   already-encoded stream (no per-viewer re-encoding) — a `tee` feeding N outgoing
   connections.
5. For each peer connection, try public STUN first. If direct connectivity fails, use
   host-provided TURN credentials when configured. If no TURN is configured, surface a
   clear connection error to the host; never silently fall back to a GoLive/shared TURN.
6. Accept any viewer that reaches the room: access is gated only by knowing the room
   link — there is no viewer allowlist.

Suggested implementation:

- **Capture + encode**: GStreamer pipeline.
  - Capture: platform-specific source (`d3d11screencapturesrc`/`dxgiscreencapsrc` on
    Windows, `ximagesrc`/`pipewiresrc` on Linux, `avfvideosrc` on macOS).
  - Encode: try a hardware AV1 encoder first if present (`nvav1enc`, `qsvav1enc`,
    `vaapiav1enc`, or platform equivalent), fall back to `svtav1enc` (software,
    real-time tunable) if none is available.
  - Fan-out: `tee` element feeding N `webrtcbin` instances (one per viewer), each with
    its own ICE configuration — avoids re-encoding per branch.
- **Packaging**: a plain Rust or Go binary is sufficient (single static executable,
  cross-platform, no webview/runtime to bundle). Windows first, since that's most likely
  for screen/game capture; Linux/macOS as stretch.
- Verify current GStreamer element names/plugins against current docs before relying on
  the ones listed above — this area moves.

### 4.3 Host-provided TURN (optional)

TURN is **not mandatory** for every session. The helper always attempts direct WebRTC
connectivity through STUN first. TURN is only needed when the host/viewer networks cannot
establish a direct path.

The host provides the TURN configuration used by their room. For the first implementation,
this can be Cloudflare TURN short-lived credentials. A later version may support coturn or
another host-controlled TURN provider. Do not build a shared GoLive TURN relay.

Rules:

1. TURN credentials are short-lived and only exposed to the participants that need them.
2. TURN is configured per room; any viewer who has the room link may receive the room's
   TURN credentials (no allowlist gating).
3. If STUN succeeds, no TURN relay is used.
4. If STUN fails and TURN is configured, retry ICE using the host's TURN server.
5. If STUN fails and TURN is not configured, stop and show a clear error such as:
   **"Direct connection failed. The host needs to configure a TURN server for this
   network."**
6. There is **no fallback to a GoLive/shared TURN server**. The project must never
   silently absorb relay bandwidth costs for a host.

### 4.4 Shared signaling and control relay

Can remain a single centralized service , since it carries no
media, just:

1. Discord OAuth login → session/identity.
2. Room creation and lookup (`roomId` → which host, which credential-API endpoint to hit).
3. SDP offer/answer and ICE candidate relay between helper and each viewer.
4. **The persistent connection from each native helper** (presence + control relay), and
   the corresponding API the host browser calls to issue commands to its own helper.

Because this never carries media, it stays cheap and shareable across many hosts/rooms
without anyone's usage crowding anyone else out.

## 5. First implementation steps

The first milestone is intentionally much smaller than the complete architecture. The goal
is to prove the hardest technical path — **native capture → AV1 encode → one WebRTC viewer**
— before adding Discord permissions, TURN provisioning, or multi-viewer fan-out.

### Milestone 0 — Signaling proof

1. browser host/viewer as the test harness.
2. Implement the minimum signaling messages needed for one WebRTC connection:
   SDP offer/answer and ICE candidates.
3. Use public STUN only. Do not add TURN yet.
4. Verify that a browser host can connect to a browser viewer and inspect the selected ICE
   candidate pair.
5. Add connection diagnostics: ICE state, selected candidate type (`host`, `srflx`,
   `relay`), RTT, packet loss, bitrate, FPS, and resolution.

**Exit condition:** one browser-to-browser stream works reliably when direct connectivity
is available, and the UI can distinguish direct (`host`/`srflx`) from relayed (`relay`) paths.

### Milestone 1 — Helper presence and control

1. Add the native helper's persistent outbound WebSocket connection to the backend.
2. Implement helper authentication and presence (`online` / `offline`).
3. Add the host-browser command API: start, stop, and basic capture-source selection.
4. Use a stub helper first; it does not need capture or WebRTC yet.
5. Verify that the browser never communicates with `localhost`; all commands travel through
   the backend relay.

**Exit condition:** the host browser can detect the helper and send commands to it end to
end through the backend.

### Milestone 2 — Native AV1 + one viewer

1. Implement Windows screen capture in the helper.
2. Add GStreamer capture → AV1 encoding.
3. Prefer the available hardware AV1 encoder; keep `svtav1enc` as the software fallback
   for development/testing.
4. Produce one real-time encoded AV1 stream.
5. Create exactly one WebRTC peer connection from the helper to one Chrome/Chromium viewer.
6. Use STUN first. Do not require TURN for the test.
7. Validate AV1 playback in the browser with WebCodecs/WebRTC and measure CPU/GPU usage.

**Exit condition:** the native helper captures the desktop, encodes AV1 once, and one
Chromium viewer receives a stable live stream.

### Milestone 3 — TURN as optional host-provided recovery

1. Add the host's TURN configuration/short-lived credential flow.
2. Keep STUN as the first ICE path.
3. If direct ICE fails, retry with the host-provided TURN server.
4. If direct ICE fails and no TURN is configured, show a clear host-facing error instead
   of using any GoLive/shared relay.
5. Log the final ICE candidate type so it is obvious whether the session is direct or
   relayed.

**Exit condition:** direct sessions work without TURN; NAT combinations that require a
relay work when the host supplies TURN; there is never an implicit GoLive TURN fallback.

### Milestone 4 — Encode once, multiple viewers

1. Keep a single AV1 encoder instance.
2. Fan the already-encoded stream into one WebRTC peer connection per viewer.
3. Start with 2–3 viewers, then test the real target of up to ~10.
4. Measure total host upload (`bitrate × viewers`) and per-viewer bitrate.
5. Monitor CPU/GPU, frame rate, packet loss, RTT, and viewer stability.

**Exit condition:** one encode can feed the target viewer count without per-viewer
re-encoding, and the host UI reports the real upload/quality impact.

### Milestone 5 — Permissions and polish

1. Discord OAuth identity and room ownership (hosts only; viewers need no account).
2. Anonymous viewer join via the room link — no viewer allowlist.
3. Host-provided TURN configuration for the room.
4. Room link UX and viewer join flow.
5. Helper reconnect/backoff handling.
6. Capture-source picker and bandwidth/connection error indicators.

**Exit condition:** the complete v1 flow works from host login → helper online → host
starts stream → viewer joins via the link → direct WebRTC or host-provided TURN →
stream ends.

## 5.1 Implementation priority

The recommended order is:

```text
Browser WebRTC proof
        ↓
Helper presence + control relay
        ↓
Native capture + hardware AV1 + 1 viewer
        ↓
Optional host-provided TURN
        ↓
Single encode → 2–3 viewers
        ↓
Single encode → ~10 viewers
        ↓
Discord (hosts) / anonymous viewers / UX polish
```

Do not start with TURN infrastructure, multi-viewer fan-out, or Discord permissions. Each
of those adds another failure domain before the native media path is proven.

## 6. Open questions to resolve before/while building

- Exact protocol for the persistent helper↔backend connection (WebSocket is the obvious
  default) and its reconnect/backoff behavior if the helper's network blips.
- Where does each host actually run their credential API + coturn? A documented
  "one-click" deploy target (e.g. a free-tier Fly.io/Oracle Cloud VM) would keep this
  from becoming the new friction point that used to be "download an executable."
- Exact current GStreamer fan-out element names — verify against `gst-plugins-rs` and
  core GStreamer docs at build time.
- How do we keep an anonymous room link from being trivially enumerated/abused, now that
  the link alone grants access? (e.g. longer room ids; out of scope for v1.)
- What's the actual bandwidth/quality ceiling to design the UI around, given the
  accepted host-upload-scales-with-viewers tradeoff?

## 7. Explicit non-goals for v1

- No codec other than AV1.
- No support for viewers beyond modern Chromium-based browsers (Safari/iOS AV1 support
  is unreliable — out of scope for now).
- No recording/DVR functionality.
- No mobile host app.
- No SFU (see §3 for why, and the note on revisiting this if helper upload bandwidth
  becomes a real limiting factor).
- No native GUI / Tauri wrapper, and no browser-to-localhost calls of any kind — host
  controls live entirely in the shared web frontend, relayed through the backend.

### Milestone 6 — Maximize direct NAT traversal

The goal of this milestone is to reduce how often a session needs TURN without changing the
core WebRTC architecture. The helper remains responsible for the peer connection, while the
backend continues to handle signaling only.

1. **Use multiple public STUN servers** instead of depending on a single STUN endpoint.
2. **Verify full trickle ICE support** end to end. Every local ICE candidate should be sent
   immediately through signaling, and every remote candidate should be applied as soon as it
   arrives.
3. Keep `iceTransportPolicy` set to `all` so the ICE agent can try direct `host`, `srflx`,
   and peer-reflexive paths before falling back to `relay` when TURN is available.
4. Do not stop ICE candidate gathering/checks prematurely. Allow the ICE agent to continue
   discovering and testing candidate pairs while the connection is being established.
5. Preserve and expose all useful candidate types in diagnostics: `host`, `srflx`, `prflx`,
   and `relay`.
6. **Prefer IPv6 when a usable IPv6 path exists**, while retaining IPv4 candidates for normal
   home networks.
7. Add detailed ICE diagnostics for failed direct connections:
   - local and remote candidate types
   - candidate pair state
   - selected candidate pair
   - ICE connection state
   - RTT
   - packet loss
   - bitrate
   - connection establishment time
8. Add a dedicated **NAT diagnostics/test mode** so the same helper and viewer can be tested
   from different networks. Record whether each test succeeded directly, required TURN, or
   failed without TURN.
9. Investigate **UPnP and NAT-PMP/PCP support in the native helper** as an optional enhancement.
   The helper may attempt router-assisted port mapping where supported, but this must remain an
   optimization rather than a requirement. Do not assume a manually opened mapping is useful
   unless the ICE stack is actually using the corresponding socket/port.
10. Test representative difficult network combinations before considering this milestone done:
    - same LAN
    - two normal home routers
    - symmetric/NAT-restricted combinations where possible
    - double NAT
    - CGNAT
    - IPv6-capable networks
    - networks where UDP is restricted

**Exit condition:** direct P2P connectivity succeeds across a broader range of real-world NAT
combinations, and every failure clearly identifies whether TURN is required or whether the
connection failed for another reason. TURN remains the recovery path for networks where direct
ICE cannot establish a usable route.

### Milestone 7 — Connection diagnostics and NAT regression suite

Turn the diagnostics from Milestone 6 into a repeatable test suite so future networking changes
do not silently reduce connectivity.

1. Add a host/viewer diagnostics panel showing the final transport path:
   `direct host`, `direct srflx`, `direct prflx`, or `TURN relay`.
2. Record ICE gathering time, ICE checking time, time to first decoded frame, selected candidate
   pair, RTT, packet loss, bitrate, and disconnect reason.
3. Store anonymized connection-test results for development/debugging if the project later has a
   suitable telemetry path. Do not collect unnecessary network-identifying data.
4. Build a small matrix of known test networks and repeat it after changes to the helper,
   signaling, ICE configuration, or router/NAT handling.
5. Make direct-vs-relayed behavior visible during development so TURN usage cannot accidentally
   become the default.

**Exit condition:** a networking change can be tested against the same NAT scenarios and the
project can demonstrate whether direct connectivity improved, stayed the same, or regressed.

### Milestone 8 — Optional native NAT-assistance experiments

Only after the normal WebRTC ICE path is stable, evaluate additional native networking features.
These are experiments, not requirements for v1.

1. Prototype UPnP port mapping in the helper.
2. Prototype NAT-PMP/PCP where supported by the router.
3. Compare connection success rates with assistance disabled/enabled.
4. Verify that any mapped port is actually represented by a usable ICE candidate and selected
   by the ICE agent; a router mapping by itself is not enough.
5. Keep the feature opt-in or safely degradable if router discovery/mapping fails.
6. Do not replace WebRTC ICE with a custom NAT traversal protocol at this stage.

**Exit condition:** any native NAT assistance is demonstrably useful on tested networks and does
not make normal connections less reliable. If it provides little benefit, leave it out rather
than adding another permanent dependency.

## 5.2 Updated implementation priority

After the existing v1 milestones, networking improvements should follow this order:

```text
Milestone 5 complete
        ↓
Multiple STUN servers + full trickle ICE verification
        ↓
IPv6 + complete ICE candidate diagnostics
        ↓
NAT diagnostics/test mode
        ↓
Real-world NAT regression testing
        ↓
Optional UPnP / NAT-PMP experiments
        ↓
Keep TURN as host-provided recovery for networks that still cannot connect directly
```

The project should **not** implement a custom Parsec-like UDP protocol or custom NAT traversal
before exhausting the capabilities of WebRTC ICE. The native helper already removes many of the
browser limitations, while WebRTC provides the mature ICE machinery needed for STUN, candidate
pair checks, and TURN fallback.

## 5.3 NAT traversal design rules

These rules are intended to prevent later changes from accidentally making direct P2P less
reliable:

- Direct ICE is always attempted before TURN.
- TURN is never a hidden GoLive/shared fallback.
- All trickled ICE candidates must be forwarded in both directions.
- Do not discard `host`, `srflx`, or `prflx` candidates just because a TURN candidate also exists.
- Do not assume the first discovered candidate pair is the final or best path.
- Do not disable IPv6 candidates globally.
- NAT-assistance features such as UPnP/NAT-PMP are optional optimizations, never prerequisites.
- A failed direct connection must produce diagnostics that explain what happened rather than only
  reporting a generic "connection failed" message.
- If direct connectivity is impossible and no host-provided TURN is configured, fail clearly and
  tell the host what configuration is required.
