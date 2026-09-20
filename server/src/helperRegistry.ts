import type {
  HelperMessage,
  HelperState,
  HelperStatus,
  LastCommandResult,
  ServerHelperMessage,
} from '@golive/shared';

/** Minimal socket surface so the registry doesn't depend on the WS impl. */
export interface SocketLike {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close?(code?: number, reason?: string): void;
}

// ---------------------------------------------------------------------------
// Timeouts (see docs/signaling.md)
// ---------------------------------------------------------------------------

/** Server pings helpers this often. */
export const HELPER_PING_INTERVAL_MS = 10_000;
/** No inbound frame for this long ⇒ helper is stale: reported offline + dropped. */
export const HELPER_STALE_AFTER_MS = 30_000;
/** Grace period to complete the `hello` handshake after the socket opens. */
export const HELPER_HELLO_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------

export interface HelperEntry {
  userId: string;
  connId: string;
  state: HelperState;
  detail?: string;
  /** Version string from the `hello` handshake (e.g. "golive-helper-stub/0.1"). */
  version: string;
  /** Timestamp of the last inbound frame of any kind (hello/status/ack). */
  lastSeenAt: number;
  conn: SocketLike;
}

interface PendingEntry {
  connId: string;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingAck {
  id: string;
  command: string;
  sentAt: number;
}

/** One helper per host account. Last registration wins; prior conn is closed. */
const helpers = new Map<string, HelperEntry>();
/** Sockets that connected but haven't completed the `hello` handshake yet. */
const pendingHelpers = new Map<string, PendingEntry>();
/** Commands relayed but not yet acked (id → what we sent). */
const pendingAcks = new Map<string, PendingAck>();
/** Last acked command result per account. */
const lastCommandResults = new Map<string, LastCommandResult>();

export function isStale(entry: HelperEntry, now = Date.now()): boolean {
  return now - entry.lastSeenAt > HELPER_STALE_AFTER_MS;
}

// -- hello handshake ------------------------------------------------------

/** A socket connected; it must send a valid `hello` within the handshake timeout. */
export function pendHelper(userId: string, connId: string, conn: SocketLike): void {
  clearPending(connId);
  const timer = setTimeout(() => {
    pendingHelpers.delete(connId);
    conn.close?.(1008, 'hello_timeout');
  }, HELPER_HELLO_TIMEOUT_MS);
  pendingHelpers.set(connId, { connId, timer });
}

export function clearPending(connId: string): void {
  const p = pendingHelpers.get(connId);
  if (p) {
    clearTimeout(p.timer);
    pendingHelpers.delete(connId);
  }
}

/**
 * Register a helper after a valid handshake. If another connection is already
 * registered for this account, that one is superseded and closed (last wins).
 */
export function registerHelper(entry: HelperEntry): void {
  clearPending(entry.connId);
  const existing = helpers.get(entry.userId);
  if (existing && existing.connId !== entry.connId) {
    existing.conn.close?.(1008, 'superseded');
  }
  helpers.set(entry.userId, entry);
}

export function unregisterHelper(userId: string, connId: string): void {
  const entry = helpers.get(userId);
  if (entry && entry.connId === connId) helpers.delete(userId);
}

export function getHelper(userId: string): HelperEntry | undefined {
  return helpers.get(userId);
}

/** Called on any inbound frame from the helper — refreshes the staleness clock. */
export function touchHelper(userId: string, connId: string): void {
  const entry = helpers.get(userId);
  if (entry && entry.connId === connId) entry.lastSeenAt = Date.now();
}

export function updateHelperState(
  userId: string,
  connId: string,
  state: HelperState,
  detail?: string,
): void {
  const entry = helpers.get(userId);
  if (entry && entry.connId === connId) {
    entry.state = state;
    entry.detail = detail;
    entry.lastSeenAt = Date.now();
  }
}

// -- heartbeat ------------------------------------------------------------

/** Send a heartbeat ping to every registered helper. */
export function pingHelpers(): void {
  const msg: ServerHelperMessage = { type: 'ping' };
  for (const entry of helpers.values()) {
    try {
      entry.conn.send(JSON.stringify(msg));
    } catch {
      // dead socket; sweep() will drop it
    }
  }
}

/** Drop registered helpers that haven't sent a frame within the staleness window. */
export function sweepStaleHelpers(now = Date.now()): void {
  for (const [userId, entry] of helpers) {
    if (isStale(entry, now)) {
      helpers.delete(userId);
      entry.conn.close?.(1008, 'stale');
    }
  }
}

// -- commands -------------------------------------------------------------

export interface SendCommandResult {
  delivered: boolean;
  /** Command id; the helper echoes it back in its `ack`. */
  id: string;
}

/** Relay a host-browser command to the helper's persistent connection. */
export function sendCommand(
  userId: string,
  command: string,
  payload?: unknown,
  now = Date.now(),
): SendCommandResult {
  const id = crypto.randomUUID();
  const entry = helpers.get(userId);
  if (!entry || isStale(entry, now)) return { delivered: false, id };
  const message: ServerHelperMessage = { type: 'command', id, command, payload };
  try {
    entry.conn.send(JSON.stringify(message));
    pendingAcks.set(userId, { id, command, sentAt: Date.now() });
    return { delivered: true, id };
  } catch {
    return { delivered: false, id };
  }
}

/**
 * Record a command acknowledgement from the helper. Joins the ack with the
 * command we actually sent (by id) so `helperStatus` can report a meaningful
 * result. Also applies the ack's `state` transition to the helper entry.
 */
export function handleHelperAck(
  userId: string,
  connId: string,
  ack: Extract<HelperMessage, { type: 'ack' }>,
): boolean {
  const entry = helpers.get(userId);
  if (!entry || entry.connId !== connId) return false;

  entry.lastSeenAt = Date.now();
  if (ack.state) {
    entry.state = ack.state;
    entry.detail = ack.detail;
  }

  const pending = pendingAcks.get(userId);
  const command = pending && pending.id === ack.id ? pending.command : ack.id;
  if (pending && pending.id === ack.id) pendingAcks.delete(userId);

  lastCommandResults.set(userId, {
    id: ack.id,
    command,
    ok: ack.ok,
    detail: ack.detail,
    state: ack.state,
    at: new Date().toISOString(),
  });
  return true;
}

// -- status ---------------------------------------------------------------

export function helperStatus(userId: string, now = Date.now()): HelperStatus {
  const entry = helpers.get(userId);
  const common = {
    lastSeenAt: entry ? new Date(entry.lastSeenAt).toISOString() : null,
    helperVersion: entry?.version ?? null,
    lastCommand: lastCommandResults.get(userId) ?? null,
  };
  if (!entry || isStale(entry, now)) {
    return { connected: false, state: null, ...common };
  }
  return { connected: true, state: entry.state, ...common };
}