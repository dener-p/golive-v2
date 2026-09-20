/**
 * Helper stub — stands in for the future native helper.
 *
 * Opens the persistent outbound WebSocket to the signaling backend,
 * authenticates as the host account, and reports presence + acknowledges
 * relayed commands. No capture, no encoding.
 *
 * Usage: bun run helper:stub   (server must be in dev-auth mode, or pass a
 * real session cookie via SESSION_COOKIE env — e.g. from a browser login).
 */
import type { HelperMessage, ServerHelperMessage } from '@golive/shared';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const WS_URL = BASE_URL.replace(/^http/, 'ws');
const VERSION = 'golive-helper-stub/0.1';

async function obtainCookie(): Promise<string> {
  if (process.env.SESSION_COOKIE) return `session=${process.env.SESSION_COOKIE}`;

  // Dev mode: POST /auth/dev, grab the Set-Cookie session token.
  const res = await fetch(`${BASE_URL}/auth/dev`, { method: 'POST' });
  if (!res.ok) throw new Error(`dev login failed: HTTP ${res.status}`);
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('session='));
  if (!cookie) throw new Error('no session cookie returned — is the server in dev-auth mode? (unset DISCORD_*)');
  return cookie;
}

let attempt = 0;
let ws: WebSocket | null = null;
let shuttingDown = false;

function log(...args: unknown[]): void {
  console.log('[helper-stub]', ...args);
}

function connect(): void {
  log(`connecting to ${WS_URL}/ws/helper…`);
  ws = new WebSocket(`${WS_URL}/ws/helper`, { headers: { cookie: SESSION_COOKIE } });

  ws.onopen = () => {
    attempt = 0;
    log('connected — sending hello');
    const hello: HelperMessage = { type: 'hello', version: VERSION };
    ws?.send(JSON.stringify(hello));
  };

  ws.onmessage = (evt) => {
    let msg: ServerHelperMessage;
    try {
      msg = JSON.parse(String(evt.data)) as ServerHelperMessage;
    } catch {
      return;
    }
    if (msg.type === 'hello-ack') {
      log(`acknowledged (server time ${msg.serverTime}) — presence registered`);
    } else if (msg.type === 'command') {
      handleCommand(msg);
    } else if (msg.type === 'ping') {
      const status: HelperMessage = { type: 'status', state: 'idle', detail: 'stub alive' };
      ws?.send(JSON.stringify(status));
    }
  };

  ws.onerror = (evt) => {
    log('websocket error', String(evt));
  };

  ws.onclose = (evt) => {
    log(`connection closed (code ${evt.code} ${evt.reason || ''})`);
    ws = null;
    if (!shuttingDown) scheduleReconnect();
  };
}

function handleCommand(msg: ServerHelperMessage & { type: 'command' }): void {
  log(`command received: "${msg.command}"${msg.payload ? ` ${JSON.stringify(msg.payload)}` : ''}`);
  const state: HelperMessage['state'] = msg.command === 'start' ? 'live' : 'idle';
  const status: HelperMessage = { type: 'status', state, detail: `stub handled "${msg.command}"` };
  ws?.send(JSON.stringify(status));
  log(`reported status -> ${state}`);
}

function scheduleReconnect(): void {
  const delay = Math.min(1000 * 2 ** attempt, 15_000);
  attempt += 1;
  log(`reconnecting in ${delay}ms (attempt ${attempt})…`);
  setTimeout(connect, delay);
}

const SESSION_COOKIE = await obtainCookie();

process.on('SIGINT', () => {
  shuttingDown = true;
  log('shutting down');
  ws?.close();
  process.exit(0);
});

connect();