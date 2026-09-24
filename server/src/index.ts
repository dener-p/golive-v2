import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { resolve, sep } from 'node:path';
import type { ClientSignal, HelperMessage, Role, ServerHelperMessage, ServerSignal } from '@golive/shared';
import { config, isDevAuth } from './config';
import { userFromCookieHeader, userFromRequest } from './http';
import { authApp } from './routes/auth';
import { apiApp } from './routes/api';
import { roomsApp } from './routes/rooms';
import {
  handleSignal,
  joinSignaling,
  leaveSignaling,
  type SignalingSocket,
} from './signaling';
import { attachHelperToRoom, helloAck, helperSignalingSocket } from './helperSignaling';
import { runMigrations } from './db/client';
import { loadRooms, sweepExpiredRooms } from './store';
import { loadSessions } from './sessions';
import { loadHelperTokens } from './tokens';
import {
  registerHelper,
  unregisterHelper,
  updateHelperState,
  touchHelper,
  pendHelper,
  clearPending,
  handleHelperAck,
  pingHelpers,
  sweepStaleHelpers,
  HELPER_PING_INTERVAL_MS,
  type SocketLike,
} from './helperRegistry';

const app = new Hono();
app.use(logger());

// ---------------------------------------------------------------------------
// Liveness probe (public — tunnel/Uptime checks can hit this without auth)
// ---------------------------------------------------------------------------

const startedAt = Date.now();
app.get('/healthz', (c) =>
  c.json({
    ok: true,
    uptimeMs: Date.now() - startedAt,
    auth: isDevAuth ? 'dev' : 'discord',
  }),
);

app.route('/auth', authApp);
app.route('/api', apiApp);
app.route('/api/rooms', roomsApp);

// ---------------------------------------------------------------------------
// Room signaling (browser host/viewer <-> server)
// ---------------------------------------------------------------------------

app.get(
  '/ws',
  upgradeWebSocket((c) => {
    const user = userFromCookieHeader(c.req.header('cookie'));
    const connId = crypto.randomUUID();
    // Viewers are anonymous — only hosting requires a signed-in room owner.
    // Anonymous connections get a per-connection guest id so the signaling
    // layer can still address them; it never grants host ownership.
    const userId = user?.id ?? `guest-${connId}`;

    const fail = (
      ws: { send(data: string): void | Promise<void>; close(code?: number, reason?: string): void },
      code: string,
      message: string,
    ): void => {
      const msg: ServerSignal = { type: 'error', code, message };
      void ws.send(JSON.stringify(msg));
      ws.close(1008, code);
    };

    return {
      onMessage(evt, ws) {
        let msg: ClientSignal;
        try {
          msg = JSON.parse(String(evt.data)) as ClientSignal;
        } catch {
          return; // ignore malformed frames
        }

        const socket: SignalingSocket = { id: connId, send: (raw) => ws.send(raw) };

        if (msg.type === 'join') {
          const roomId = (msg.roomId ?? '').trim().toLowerCase();
          const role: Role | undefined =
            msg.role === 'host' ? 'host' : msg.role === 'viewer' ? 'viewer' : undefined;
          if (!roomId || !role) {
            fail(ws, 'bad_request', 'join requires roomId and role');
            return;
          }
          const peerId = msg.peerId?.trim() || connId;
          const result = joinSignaling(socket, roomId, role, userId, peerId);
          if (!result.ok) {
            fail(ws, result.code, result.message);
            return;
          }
          return;
        }

        handleSignal(socket, msg);
      },
      onClose() {
        leaveSignaling(connId);
      },
    };
  }),
);

// ---------------------------------------------------------------------------
// Helper presence + control channel (native helper <-> server)
// ---------------------------------------------------------------------------

app.get(
  '/ws/helper',
  upgradeWebSocket((c) => {
    const user = userFromRequest(c);
    const connId = crypto.randomUUID();
    /** Presence only counts once a valid `hello` handshake completes. */
    let registered = false;

    return {
      onOpen(_evt, ws) {
        if (!user) {
          ws.close(1008, 'unauthorized');
          return;
        }
        pendHelper(user.id, connId, ws);
      },
      onMessage(evt, ws) {
        if (!user) return;
        let msg: HelperMessage;
        try {
          msg = JSON.parse(String(evt.data)) as HelperMessage;
        } catch {
          return;
        }

        if (msg.type === 'hello') {
          const version = (msg.version ?? '').trim();
          if (!version || version.length > 64) {
            ws.close(1008, 'bad_hello');
            return;
          }
          if (!registered) {
            registered = true;
            registerHelper({
              userId: user.id,
              connId,
              conn: ws,
              state: 'idle',
              version,
              lastSeenAt: Date.now(),
            });
          }
          const ack: ServerHelperMessage = helloAck();
          ws.send(JSON.stringify(ack));
          return;
        }

        // Anything after the handshake must have been preceded by `hello`.
        if (!registered) {
          ws.close(1008, 'hello_required');
          return;
        }

        touchHelper(user.id, connId);

        if (msg.type === 'status') {
          updateHelperState(user.id, connId, msg.state, msg.detail);
          return;
        }
        if (msg.type === 'ack') {
          handleHelperAck(user.id, connId, msg);
          return;
        }

        // --- room media signaling (helper as host) -------------------------
        const helperSocket = helperSignalingSocket(connId, (raw) => ws.send(raw));

        if (msg.type === 'attach-room') {
          const roomId = (msg.roomId ?? '').trim().toLowerCase();
          if (!roomId) {
            sendAttachError(ws, 'bad_request', 'attach-room requires a roomId');
            return;
          }
          const result = attachHelperToRoom(helperSocket, roomId, user.id);
          if (!result.ok) {
            sendAttachError(ws, result.code, result.message);
            return;
          }
          attachedRooms.set(connId, result.roomId);
          return;
        }
        if (msg.type === 'detach-room') {
          leaveSignaling(connId);
          attachedRooms.delete(connId);
          return;
        }
        if (msg.type === 'room-sdp' || msg.type === 'room-ice') {
          if (!attachedRooms.has(connId)) {
            sendAttachError(ws, 'not_attached', 'Attach to a room before sending media signals');
            return;
          }
          if (msg.type === 'room-sdp') {
            handleSignal(helperSocket, {
              type: 'sdp',
              roomId: msg.roomId,
              sdp: msg.sdp,
              target: msg.peerId,
            });
          } else {
            handleSignal(helperSocket, {
              type: 'ice',
              roomId: msg.roomId,
              candidate: msg.candidate,
              target: msg.peerId,
            });
          }
        }
      },
      onClose() {
        if (user) {
          clearPending(connId);
          if (registered) {
            unregisterHelper(user.id, connId);
            leaveSignaling(connId);
            attachedRooms.delete(connId);
          }
        }
      },
    };
  }),
);

function sendAttachError(ws: { send(data: string): void }, code: string, message: string): void {
  const out: ServerHelperMessage = {
    type: 'attach-ack',
    ok: false,
    error: { code, message },
  };
  ws.send(JSON.stringify(out));
}

/** Helper connections currently attached to a room (connId → roomId). */
const attachedRooms = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helper binaries + metadata (published by tools/release/build.ps1)
// ---------------------------------------------------------------------------

const HELPER_DIR = resolve(import.meta.dir, '../public/helper');

app.get('/helper/*', async (c) => {
  const name = decodeURIComponent(c.req.path.slice('/helper/'.length));
  if (
    !name ||
    name.includes('..') ||
    name.includes('\\') ||
    name.includes('/')
  ) {
    return c.notFound();
  }
  const file = Bun.file(resolve(HELPER_DIR, name));
  if (!(await file.exists())) return c.notFound();
  const type = name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
  return new Response(file, { headers: { 'Content-Type': type } });
});

// ---------------------------------------------------------------------------
// Static web app (built output) with SPA fallback
// ---------------------------------------------------------------------------

const DIST_DIR = resolve(import.meta.dir, '../../web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function mimeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return MIME[path.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

app.notFound(async (c) => {
  const path = c.req.path;
  if (path.startsWith('/api') || path.startsWith('/auth') || path.startsWith('/ws')) {
    return c.json({ error: 'not_found' }, 404);
  }

  const rel = path === '/' ? 'index.html' : path.slice(1).replaceAll('/', sep);
  const filePath = resolve(DIST_DIR, rel);
  if (filePath.startsWith(DIST_DIR + sep)) {
    const file = Bun.file(filePath);
    if (await file.exists()) return new Response(file, { headers: { 'Content-Type': mimeFor(filePath) } });
  }

  const index = Bun.file(resolve(DIST_DIR, 'index.html'));
  if (await index.exists()) return new Response(index, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  return c.text('golive signaling server is running. Run `bun run build` to serve the web app.');
});

// ---------------------------------------------------------------------------
// Helper heartbeat: ping every interval; drop helpers that miss enough frames.
// ---------------------------------------------------------------------------

setInterval(() => {
  pingHelpers();
  sweepStaleHelpers();
}, HELPER_PING_INTERVAL_MS);

// Rooms expire: periodic sweep keeps the store (and session-free watch links)
// tidy between accesses. Lazy expiry on read is the source of truth.
setInterval(() => {
  sweepExpiredRooms();
}, 15 * 60 * 1000);

// ---------------------------------------------------------------------------
// Startup guard + serve
// ---------------------------------------------------------------------------

// P4 hardening: never boot a real deployment with a well-known session secret.
// Dev-auth mode (no Discord credentials) is exempt — it's meant for local runs.
if (!isDevAuth && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-secret-change-me')) {
  console.error('[golive] refusing to start: SESSION_SECRET is missing or still the default while Discord OAuth is configured.');
  console.error('[golive] generate one, e.g.  openssl rand -hex 32 , and put it in .env');
  process.exit(1);
}

// Database: apply migrations and rebuild the in-memory mirrors (sessions,
// helper tokens, rooms) so restarts no longer log out hosts, un-pair helpers,
// or destroy watch links.
async function startDatabase(): Promise<void> {
  try {
    await runMigrations();
    await Promise.all([loadSessions(), loadHelperTokens(), loadRooms()]);
  } catch (err) {
    console.error('[golive] database setup failed (DATABASE_URL / DATABASE_AUTH_TOKEN?):', err);
    process.exit(1);
  }
  console.log(`[golive] database: ${config.databaseUrl.includes('libsql:') ? 'Turso (libsql)' : 'local SQLite'}`);
}
await startDatabase();

const server = Bun.serve({ port: config.port, fetch: app.fetch, websocket });
console.log(`[golive] signaling backend on ${config.baseUrl}`);
console.log(
  `[golive] host auth: ${isDevAuth ? 'DEV (instant login as Dev User)' : 'Discord OAuth'} — viewers need no login`,
);
if (config.turn) console.log('[golive] TURN configured — ice-servers will include it');

process.on('SIGINT', () => server.stop(true));
process.on('SIGTERM', () => server.stop(true));