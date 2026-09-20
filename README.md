# golive

Low-latency, zero-cost, small-audience (≤10 viewers) live streaming. **AV1 only.**

- **Viewer**: web page at `watch/{roomId}`.
- **Host UI**: the *same* frontend in "host mode", unlocked when a native helper is present.
- **Native helper**: headless process doing capture + a single AV1 encode, fanned out to each viewer over WebRTC mesh (one upload per viewer by design — no SFU).
- **Transport**: WebRTC mesh with STUN first, TURN (host-provided credentials) as fallback.
- **Auth**: Discord OAuth for identities and TURN-allowlist checks.

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

1. **Log in** — dev-auth mode (no Discord config) logs you in instantly as "Dev User".
2. **Create a room** from the landing page, then open the host page link.
3. **Host test-connect** — on the host page, click *Start test broadcast* (browser-emulated host: animated canvas stream). This proves the SDP/ICE relay before any native code.
4. **Watch** — open the `watch/{roomId}` link in a second tab/window to receive the stream (AV1 preferred when the browser supports it).
5. **Helper presence** — in another terminal run `bun run helper:stub`; the host page flips to "Helper connected" and forwards stub commands. The browser never talks to the helper directly — only through the backend.

## Real (non-local) deployment

The backend is a single always-reachable service; for a quick start point it at a notebook with a `cloudflared` tunnel:

```bash
# terminal 1 – run the backend
bun install && bun run build && bun run start

# terminal 2 – expose it
cloudflared tunnel --url http://localhost:8787
```

Set `BASE_URL` (in `.env`) to the tunnel hostname and re-added `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` to switch from dev-auth to real Discord OAuth. Redirect URI: `{BASE_URL}/auth/callback`.

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