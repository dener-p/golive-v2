# Self-hosting the golive backend (operator runbook)

The backend is a single always-reachable service. The intended setup is a **Windows
notebook** (or a small always-on PC) running the local server behind a **cloudflared
named tunnel** that exposes it on your own domain (here: `golive.puhl.dev`).

The repo is self-contained for deployment:

- `server/` runs the signaling backend **and** serves the web app (built output) and
  the helper download.
- The release helper exe + `latest.json` are **committed** under `server/public/helper/`
  — a fresh clone already serves the download; a Rust toolchain is **not** needed on
  the notebook unless you want to rebuild the helper yourself.

---

## What you need on the notebook

- Windows 10/11 x64, internet.
- [git](https://git-scm.com), [bun](https://bun.sh) ≥ 1.2.
- `cloudflared` — download the Windows AMD64 binary (install anywhere, add to
  PATH, or call it by full path). Test: `cloudflared --version`.
- Rust + a Windows linker **only if** you'll run `tools/release/build.ps1` yourself.

## One-time setup

### 1. Clone

```bash
git clone <this-repo> golive && cd golive
bun install
```

### 2. `.env` (copy from `.env.example`, edit)

```env
PORT=8787
BASE_URL=https://golive.puhl.dev
SESSION_SECRET=<random 64 hex chars>
DISCORD_CLIENT_ID=<your app id>
DISCORD_CLIENT_SECRET=<your app secret>
```

- **SESSION_SECRET** — generate with `bun -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
  The server **refuses to start** (outside dev-auth) if this is missing or still the
  default. Keep `.env` out of git.
- **Discord OAuth** — create an app at https://discord.com/developers/applications. OAuth2 redirect URI must be exactly
  `https://golive.puhl.dev/auth/callback` (no trailing slash). Scope: `identify`.
  Leave both values empty to run in **dev-auth mode** (instant login as "Dev User") —
  fine for a private test, not for real use.
- `RATE_LIMITS` stays on (default). Only set `RATE_LIMITS=off` for local dev loops.
- STUN server defaults are fine. TURN is optional host-provided recovery — see below.

### 3. Build the web app and start

```bash
bun run build   # vite -> web/dist (served by the backend)
bun run start   # server, listens on $PORT
```

Smoke checks:

- `curl http://localhost:8787/healthz` → `{"ok":true,…}`
- `curl http://localhost:8787/api/helper/latest` → version/file/sha256 of the helper.

## Cloudflare tunnel (name it, don't quick-tunnel your real domain)

Quick tunnels (`cloudflared tunnel --url …`) give a random `*.trycloudflare.com`
hostname that changes on restart — fine for a demo, **not** for `golive.puhl.dev`.
Use a named tunnel:

```bash
cloudflared tunnel login                 # opens a browser, authorizes your CF account
cloudflared tunnel create golive         # one-time; prints a tunnel ID + token file
```

Create `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: golive
credentials-file: C:\Users\<you>\.cloudflared\<tunnel-id>.json

ingress:
  - hostname: golive.puhl.dev
    service: http://localhost:8787
  - service: http_status:404
```

Point DNS (must be on a `puhl.dev` zone you control in the same account):

```bash
cloudflared tunnel route dns golive puhl.dev
```

Run it (keep it up):

```bash
cloudflared tunnel run golive
```

For always-on, install as a Windows service: `cloudflared service install`
(it reads the config above and starts the tunnel at boot).

Verify from the outside: `curl https://golive.puhl.dev/healthz`.

## Operating notes

- **In-memory state.** Sessions, pairing codes, helper tokens, and rooms live in
  server memory. After a backend restart:
  - hosts must log in again,
  - paired helpers lose their token — the helper detects the rejection and tells
    the user to `unpair` and re-pair from the host page,
  - rooms are gone; open a new room and re-share the watch link.
  Restarts are cheap; just know they invalidate pairings.
- **One instance.** One helper per account is enforced per instance (last connection
  wins). Don't run two backend instances against the same helpers/user tokens.
- **Update the helper.** Rebuild with `powershell -ExecutionPolicy Bypass -File tools/release/build.ps1`
  (needs Rust), then **commit** the produced exe + `latest.json` — they're what the
  backend serves. Bump `helper/Cargo.toml` version for a visible "update available"
  prompt on the host page.
- **TURN (optional recovery).** Configure per-room on the host page, or globally via
  `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL` in `.env`. This is *host-provided
  recovery* — there is never an implicit shared relay. Webrtcbin/libnice has the
  source-port caveat documented in `docs/milestones.md` (M8) — mappings from UPNP are
  ignored because ICE won't use them.
- **Rate limits.** Auth, room creation, and pairing are rate-limited per IP
  (`server/src/rateLimit.ts`). If a real user trips one, they get a `429` with a
  `Retry-After`; don't just disable limits, raise `limit`/`windowMs` in the route
  config instead.
- **Backups.** The only durable data on the operator side is `.env`; the exe is in
  git. Keep `.env` in a password manager or bitwarden export, not in the repo.