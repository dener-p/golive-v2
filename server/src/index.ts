import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { upgradeWebSocket, websocket } from 'hono/bun';
import { resolve, sep } from 'node:path';
import type { ClientSignal, HelperMessage, Role, ServerHelperMessage, ServerSignal } from '@golive/shared';
import { config, isDevAuth } from './config';
import { userFromCookieHeader } from './http';
import { authApp } from './routes/auth';
import { apiApp } from './routes/api';
import { roomsApp } from './routes/rooms';
import {
  handleSignal,
  joinSignaling,
  leaveSignaling,
  type SignalingSocket,
} from './signaling';
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
      onOpen(_evt, ws) {
        if (!user) fail(ws, 'unauthorized', 'Sign in first to use signaling');
      },
      onMessage(evt, ws) {
        if (!user) return;

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
          const result = joinSignaling(socket, roomId, role, user.id, peerId);
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
    const user = userFromCookieHeader(c.req.header('cookie'));
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
          const ack: ServerHelperMessage = { type: 'hello-ack', serverTime: new Date().toISOString() };
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
        } else if (msg.type === 'ack') {
          handleHelperAck(user.id, connId, msg);
        }
      },
      onClose() {
        if (user) {
          clearPending(connId);
          if (registered) unregisterHelper(user.id, connId);
        }
      },
    };
  }),
);

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

// ---------------------------------------------------------------------------

const server = Bun.serve({ port: config.port, fetch: app.fetch, websocket });
console.log(`[golive] signaling backend on ${config.baseUrl}`);
console.log(`[golive] auth mode: ${isDevAuth ? 'DEV (instant login as Dev User)' : 'Discord OAuth'}`);
if (config.turn) console.log('[golive] TURN configured — ice-servers will include it');

process.on('SIGINT', () => server.stop(true));
process.on('SIGTERM', () => server.stop(true));