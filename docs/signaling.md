# Signaling protocol (M0)

A shared backend relays everything; media flows **directly** between host and viewer over WebRTC.
All signaling messages are JSON over WebSocket. Identities come from the session cookie.

## Connections

| Endpoint | Who | Purpose |
| --- | --- | --- |
| `GET /ws?roomId=…&role=host\|viewer` | browsers (host emulation & viewers; future: native helper as host) | Room signaling: SDP/ICE relay, presence |
| `GET /ws/helper` | native helper | Presence + control channel (commands from host browser) |

### Cookie auth
Clients authenticate with the `session` cookie. Native clients (non-browser) must set the
`Cookie: session=…` header explicitly — e.g. the helper-stub logs in via `POST /auth/dev`
and reads `Set-Cookie`.

## REST endpoints

| Method | Path | Auth | Body | Returns |
| --- | --- | --- | --- | --- |
| `POST` | `/auth/login` | – | – | Redirect to Discord (or instant dev login) |
| `GET` | `/auth/callback?code&state` | – | – | Sets session, redirects to `/#/host` |
| `GET` | `/auth/me` | session | – | `{ user: PublicUser }` or 401 |
| `POST` | `/auth/logout` | session | – | `{ ok: true }` |
| `POST` | `/auth/dev` | – (dev mode only) | – | `{ user }` dev login, sets session |
| `GET` | `/api/meta` | – (public) | – | `{ name, auth: 'dev'\|'discord' }` |
| `POST` | `/api/rooms` | session | `{}` | `201 { room: RoomInfo }` |
| `GET` | `/api/rooms/{roomId}` | session | – | `{ room: RoomInfo }` or 404 |
| `GET` | `/api/ice-servers` | session | – | `{ iceServers: RTCIceServer[] }` |
| `GET` | `/api/helper/status` | session | – | `{ status: HelperStatus }` |
| `POST` | `/api/helper/command` | session | `{ command, payload? }` | `{ delivered }`; 409 if helper offline |

## Room signaling messages (`/ws`)

Client → server:

| Message | Payload | Notes |
| --- | --- | --- |
| `join` | `{ roomId, role, peerId }` | Sent on open. `peerId` is a client-generated id that addresses this connection (the host fans out one peer connection per viewer, keyed by `peerId`). Enforced: host must be room owner, one host per room. |
| `sdp` | `{ roomId, sdp: { type, sdp } }` | Host→server→all viewers; viewer→server→host. |
| `ice` | `{ roomId, candidate }` | Same routing as `sdp`. |
| `leave` | – | Close the socket instead is also fine. |

Server → client:

| Message | Payload | Notes |
| --- | --- | --- |
| `joined` | `{ roomId, role, peerId, viewerCount }` | Ack after successful `join`. |
| `peer-joined` | `{ roomId, role, peerId }` | Host learns of a viewer; viewers learn of a host. |
| `peer-left` | `{ roomId, role, peerId }` | Clean leave. |
| `sdp` / `ice` | `{ from: role, peerId, … }` | Relayed payloads; `peerId` is the sender's connection id. |
| `error` | `{ code, message }` | e.g. `room_not_found`, `not_room_host`, `host_already_connected`, `unauthorized`; server then closes. |

## Helper channel messages (`/ws/helper`)

| Dir | Message | Payload |
| --- | --- | --- |
| C→S | `hello` | `{ version }` – presence registration (login cookie = host account) |
| C→S | `status` | `{ state: idle\|live\|error, detail? }` |
| S→C | `hello-ack` | `{ serverTime }` |
| S→C | `ping` | heartbeat |
| S→C | `command` | `{ id, command, payload? }` – started from `POST /api/helper/command` |

## Flow: viewer receives a stream

1. Viewer opens `/ws?roomId=X&role=viewer`, sends `join`.
2. Host (browser emulation today, native helper later) opens `/ws?roomId=X&role=host`, sends `join`, then `sdp(offer)`.
3. Server broadcasts the offer to viewers; each viewer answers and relays its `sdp(answer)` + `ice` to the host.
4. Host relays its ICE candidates to each viewer; media flows **peer to peer**.

No ICE/signaling server carries audio/video — this channel only relays SDP and ICE.

## Future evolution (not M0)

- Signal *renotification* / reconnect handling with thresholds.
- The native helper will carry `sdp`/`ice` frames on its persistent `/ws/helper` channel (same
  protocol messages) instead of a per-room browser connection.
- Allowlist validation and short-lived TURN credential issuance (M2, host credential API).