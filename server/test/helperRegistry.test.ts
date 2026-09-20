import { describe, expect, test } from 'bun:test';
import {
  handleHelperAck,
  helperStatus,
  sendCommand,
  clearPending,
  pendHelper,
  registerHelper,
  unregisterHelper,
  getHelper,
  pingHelpers,
  sweepStaleHelpers,
  HELPER_HELLO_TIMEOUT_MS,
  HELPER_STALE_AFTER_MS,
  type HelperEntry,
} from '../src/helperRegistry';

function fakeConn() {
  const sent: string[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  return {
    sent,
    closed,
    send: (data: string | Uint8Array | ArrayBuffer) => {
      sent.push(String(data));
    },
    close: (code?: number, reason?: string) => {
      closed.push({ code, reason });
    },
  };
}

function makeEntry(userId: string, connId: string, conn: ReturnType<typeof fakeConn>): HelperEntry {
  return { userId, connId, conn, state: 'idle', version: 'golive-helper-stub/0.1', lastSeenAt: Date.now() };
}

describe('helper registry', () => {
  test('presence counts only after the hello handshake is registered', () => {
    const conn = fakeConn();
    pendHelper('u-handshake', 'c1', conn);
    expect(helperStatus('u-handshake').connected).toBe(false);
    expect(HELPER_HELLO_TIMEOUT_MS).toBeGreaterThan(0);

    registerHelper(makeEntry('u-handshake', 'c1', conn));
    expect(helperStatus('u-handshake').connected).toBe(true);
    expect(helperStatus('u-handshake').helperVersion).toBe('golive-helper-stub/0.1');
    clearPending('c1');
    unregisterHelper('u-handshake', 'c1');
  });

  test('supercedes an older connection for the same account (last wins)', () => {
    const oldConn = fakeConn();
    const newConn = fakeConn();
    registerHelper(makeEntry('u-super', 'c-old', oldConn));
    registerHelper(makeEntry('u-super', 'c-new', newConn));

    expect(oldConn.closed).toEqual([{ code: 1008, reason: 'superseded' }]);
    expect(getHelper('u-super')?.connId).toBe('c-new');
    expect(sendCommand('u-super', 'start').delivered).toBe(true);
    unregisterHelper('u-super', 'c-new');
  });

  test('reports offline and drops helpers that go stale (no frames)', () => {
    const conn = fakeConn();
    registerHelper(makeEntry('u-stale', 'c1', conn));

    // Force the last frame timestamp into the past.
    const past = Date.now() - HELPER_STALE_AFTER_MS - 1000;
    (getHelper('u-stale') as HelperEntry).lastSeenAt = past;

    expect(helperStatus('u-stale').connected).toBe(false);
    expect(helperStatus('u-stale').lastSeenAt).not.toBeNull();

    sweepStaleHelpers();
    expect(getHelper('u-stale')).toBeUndefined();
    expect(conn.closed).toEqual([{ code: 1008, reason: 'stale' }]);
  });

  test('sendCommand does not deliver when offline', () => {
    const res = sendCommand('u-ghost', 'start');
    expect(res.delivered).toBe(false);
    expect(res.id).toBeTruthy();
  });

  test('relays a command and records the helper ack with join by id', () => {
    const conn = fakeConn();
    registerHelper(makeEntry('u-ack', 'c1', conn));

    const res = sendCommand('u-ack', 'start', { quality: '720p' });
    expect(res.delivered).toBe(true);

    const sentMsg = JSON.parse(conn.sent[0]) as { type: string; id: string; command: string; payload?: unknown };
    expect(sentMsg.type).toBe('command');
    expect(sentMsg.id).toBe(res.id);
    expect(sentMsg.command).toBe('start');

    const ok = handleHelperAck('u-ack', 'c1', { type: 'ack', id: res.id, ok: true, state: 'live', detail: 'stub handled "start"' });
    expect(ok).toBe(true);

    const status = helperStatus('u-ack');
    expect(status.state).toBe('live');
    expect(status.lastCommand).toEqual({
      id: res.id,
      command: 'start',
      ok: true,
      detail: 'stub handled "start"',
      state: 'live',
      at: expect.any(String) as string,
    });
    unregisterHelper('u-ack', 'c1');
  });

  test('records a rejected command ack', () => {
    const conn = fakeConn();
    registerHelper(makeEntry('u-reject', 'c1', conn));
    const res = sendCommand('u-reject', 'pick-source', { source: 'nonexistent' });
    expect(res.delivered).toBe(true);

    handleHelperAck('u-reject', 'c1', { type: 'ack', id: res.id, ok: false, detail: 'no such source' });
    const status = helperStatus('u-reject');
    expect(status.lastCommand?.ok).toBe(false);
    expect(status.lastCommand?.detail).toBe('no such source');
    expect(status.lastCommand?.state).toBeUndefined();
    unregisterHelper('u-reject', 'c1');
  });

  test('ignores acks from a conn that is not the registered one', () => {
    const conn = fakeConn();
    registerHelper(makeEntry('u-rogue', 'c1', conn));
    const ok = handleHelperAck('u-rogue', 'c-not-mine', { type: 'ack', id: 'x', ok: true });
    expect(ok).toBe(false);
    expect(helperStatus('u-rogue').lastCommand).toBeNull();
    unregisterHelper('u-rogue', 'c1');
  });

  test('pingHelpers sends a ping to registered helpers', () => {
    const conn = fakeConn();
    registerHelper(makeEntry('u-ping', 'c1', conn));
    pingHelpers();
    const sent = conn.sent.map((s) => JSON.parse(s) as { type: string });
    expect(sent.some((m) => m.type === 'ping')).toBe(true);
    unregisterHelper('u-ping', 'c1');
  });
});