import type { HelperState, HelperStatus, ServerHelperMessage } from '@golive/shared';

/** Minimal socket surface so the registry doesn't depend on the WS impl. */
export interface SocketLike {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close?(code?: number, reason?: string): void;
}

export interface HelperEntry {
  userId: string;
  connId: string;
  state: HelperState;
  detail?: string;
  lastSeenAt: number;
  conn: SocketLike;
}

/** One helper per host account. Last connection wins (M0). */
const helpers = new Map<string, HelperEntry>();

export function registerHelper(entry: HelperEntry): void {
  helpers.set(entry.userId, entry);
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

export function unregisterHelper(userId: string, connId: string): void {
  const entry = helpers.get(userId);
  if (entry && entry.connId === connId) helpers.delete(userId);
}

export function getHelper(userId: string): HelperEntry | undefined {
  return helpers.get(userId);
}

export function helperStatus(userId: string): HelperStatus {
  const entry = helpers.get(userId);
  if (!entry) return { connected: false, lastSeenAt: null, state: null };
  return {
    connected: true,
    lastSeenAt: new Date(entry.lastSeenAt).toISOString(),
    state: entry.state,
  };
}

/** Relay a host-browser command to the helper's persistent connection. */
export function sendCommand(userId: string, command: string, payload?: unknown): boolean {
  const entry = helpers.get(userId);
  if (!entry) return false;
  const message: ServerHelperMessage = {
    type: 'command',
    id: crypto.randomUUID(),
    command,
    payload,
  };
  try {
    entry.conn.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}