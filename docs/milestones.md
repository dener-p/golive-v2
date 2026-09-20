# Milestones

Derived from the build order in `project.md` §5. M0 is what this repo ships today.

| # | Deliverable | Status |
| --- | --- | --- |
| M0 | **Repo + shared signaling skeleton** — monorepo, Discord OAuth (dev fallback), room create/lookup, WebSocket SDP/ICE relay, browser-emulated host/viewer test page, helper-presence + command-relay endpoints, stub helper | ✅ |
| M1 | **Control relay end to end** — trustworthy helper presence + host→helper command API exercised by a stub that actually receives/acks commands | ✅ |
| M2 | **Credential API + TURN** — per-host credential API (Cloudflare TURN creds or coturn) issuing short-lived creds gated by viewer allowlist; `IceServers` endpoint returns TURN | ❌ |
| M3 | **Native helper MVP** — capture + software AV1 encode (svtav1enc) + one peer connection, driven by real commands relayed through the backend | ❌ |
| M4 | **Multi-viewer fan-out** — `tee` one encode into N peer connections, measure upload bandwidth vs viewer count (~10 target) | ❌ |
| M5 | **Hardware encoder path** — detect/prefer nvav1enc/qsv/vaapi before falling back to software | ❌ |
| M6 | **Allowlist UX + polish** — viewer allowlist management, room-link UX, reconnect handling, source picker, bandwidth/quality indicators | ❌ |

## M0 scope checklist

- [x] Git repo + workspace layout
- [x] Shared protocol/API types (`packages/shared`)
- [x] Signaling backend (Bun + Hono)
  - [x] Discord OAuth login/callback/logout/me (+ dev-auth mode when no Discord creds)
  - [x] Room creation + lookup (case-insensitive short IDs)
  - [x] WebSocket session signaling: join/leave, SDP + ICE relay, role enforcement (host = room owner, one host per room)
  - [x] Helper presence WS (hello/status) + `GET /api/helper/status` + `POST /api/helper/command`
  - [x] `GET /api/ice-servers` (STUN now, TURN when configured)
  - [x] Static serving of the built web app with SPA fallback
  - [x] Logger middleware
- [x] Frontend (Vite + TS SPA)
  - [x] Hash router: landing / `watch/{roomId}` / host
  - [x] Login (Discord redirect + dev button), create room, room link copy
  - [x] Viewer page: joins room, answers host offer, renders AV1-preferred stream
  - [x] Host page: helper-status gate + browser-emulated test host (proves relay, no native code needed)
  - [x] Clear error surfaced when the helper/host is absent and no signal arrives
- [x] Helper stub (Bun script) — presence + control channel only
- [x] Unit tests for room store + signaling role rules
- [x] Docs: README, protocol doc, milestones doc, `.env.example`

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

## Notes for later milestones

- Signaling state lives in memory (single process). Multi-process/durable storage is deferred until it's actually needed (M6+).
- Session store is also in-memory; rotate to signed stateless cookies or a DB when deploying multi-process.
- The browser-emulated host in host page is a *test* instrument, not a product path — real host is the native helper (M3+).