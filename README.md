# golive

Low-latency, zero-cost, small-audience (≤10 viewers) live streaming. **AV1 only.**

- **Viewer**: web page at `watch/{roomId}`.
- **Host UI**: the *same* frontend in "host mode", unlocked when a native helper is present.
- **Native helper**: headless process doing capture + a single AV1 encode, fanned out to each viewer over WebRTC mesh (one upload per viewer by design — no SFU).
- **Transport**: WebRTC mesh with STUN first, TURN (host-provided credentials) as fallback.
- **Auth**: Discord OAuth **for hosts only** (room ownership + helper control). Viewers need no account — the room link is enough; there is no viewer allowlist.

Full design in [`project.md`](./project.md). Milestone plan in [`docs/milestones.md`](./docs/milestones.md), signaling protocol in [`docs/signaling.md`](./docs/signaling.md).

## Repository layout

```
packages/shared   – protocol + API types shared by server, web, and helper
server/           – signaling backend (Bun + Hono): Discord OAuth, rooms, WS relay, helper presence
web/              – viewer + host-mode frontend (Vite + TypeScript SPA)
helper-stub/      – tiny helper simulator: presence + control channel, no capture/encode yet
```

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.2.

```bash
bun install
cp .env.example .env      # defaults work for local dev (dev-auth mode)
bun run dev               # signaling backend on :8787, frontend on :5173
```

Then open http://localhost:5173:

1. **Log in (hosts only)** — dev-auth mode (no Discord config) logs you in instantly as "Dev User". Viewers never log in.
2. **Create a room** from the landing page, then open the host page link.
3. **Host test-connect** — on the host page, click *Start test broadcast* (browser-emulated host: animated canvas stream). This proves the SDP/ICE relay before any native code.
4. **Watch** — open the `watch/{roomId}` link in a second tab/window to receive the stream (AV1 preferred when the browser supports it).
5. **Helper presence** — in another terminal run `bun run helper:stub`; the host page flips to "Helper connected" and forwards stub commands. The browser never talks to the helper directly — only through the backend.

## Real (non-local) deployment

The backend is a single always-reachable service. For the full runbook (`.env`,
Discord OAuth, SESSION_SECRET, named `cloudflared` tunnel on your own domain, updates,
operating notes) see **`docs/self-host.md`**.

Quick start — useful for a throwaway check on a machine that has `cloudflared`:

```bash
# terminal 1 – run the backend
bun install && bun run build && bun run start

# terminal 2 – expose it (random hostname, changes every restart)
cloudflared tunnel --url http://localhost:8787
```

Note: quick tunnels get a new `*.trycloudflare.com` hostname per run — use a **named
tunnel** (see `docs/self-host.md`) for a permanent domain. `BASE_URL`, the Discord
redirect URI (`{BASE_URL}/auth/callback`), and `DISCORD_CLIENT_*` switch the backend
from dev-auth to real OAuth.

## Scripts

| Script | What it does |
| --- | --- |
| `bun run dev` | backend (watch) + frontend (Vite) concurrently |
| `bun run build` / `bun run start` | build web app, then serve it from the backend |
| `bun run typecheck` | `tsc --noEmit` across all packages |
| `bun run test` | backend unit tests (`bun:test`) |
| `bun run helper:stub` | run the helper presence simulator |

## Non-goals (v1)

No codec other than AV1, no Safari/iOS viewers, no recording, no mobile host app, no SFU, no native GUI, and **no browser-to-localhost calls of any kind** — host controls live in the web frontend and reach the helper only via the backend relay.