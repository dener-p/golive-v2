import { describe, expect, test } from 'bun:test';
import './setup';
import { createRoom } from '../src/store';
import { handleSignal, joinSignaling, leaveSignaling, type SignalingSocket } from '../src/signaling';
import { attachHelperToRoom, helloAck, helperSignalingSocket } from '../src/helperSignaling';
import type { PublicUser, ServerHelperMessage, ServerSignal } from '@golive/shared';

const HOST: PublicUser = { id: 'host-1', username: 'Hosti', avatar: null };
const VIEWER: PublicUser = { id: 'viewer-1', username: 'Viewy', avatar: null };
const OTHER: PublicUser = { id: 'other-1', username: 'Intruder', avatar: null };

/** Wraps the helperSignalingSocket translation to capture what a helper would read. */
function helperWire(connId: string): SignalingSocket & { received: ServerHelperMessage[] } {
  const received: ServerHelperMessage[] = [];
  const socket = helperSignalingSocket(connId, (raw) => received.push(JSON.parse(raw) as ServerHelperMessage));
  return Object.assign(socket, { received });
}

function socket(id: string): SignalingSocket & { sent: ServerSignal[] } {
  const sent: ServerSignal[] = [];
  return {
    id,
    sent,
    send: (raw) => sent.push(JSON.parse(raw) as ServerSignal),
  };
}

describe('helper-as-host signaling (over /ws/helper)', () => {
  test('hello-ack carries the ICE server list (STUN; TURN when configured)', () => {
    const ack = helloAck();
    if (ack.type !== 'hello-ack') throw new Error(`expected hello-ack, got: ${ack.type}`);
    expect(Array.isArray(ack.iceServers)).toBe(true);
    expect((ack.iceServers ?? []).length).toBeGreaterThan(0);
    // STUN entries appear as url strings; at least one Google STUN by default.
    const stunUrls = (ack.iceServers ?? []).flatMap((s) =>
      Array.isArray(s.urls) ? s.urls : [s.urls],
    );
    expect(stunUrls.length).toBeGreaterThan(0);
    expect(stunUrls.some((u) => u.startsWith('stun:'))).toBe(true);
  });

  test('attach-acks with viewer count; viewers appear as peer-joined', () => {
    const room = createRoom(HOST);
    const helper = helperWire('helper-1');

    const join = attachHelperToRoom(helper, room.roomId, HOST.id);
    expect(join.ok).toBe(true);
    expect(helper.received[0]).toMatchObject({ type: 'attach-ack', ok: true, viewerCount: 0 });

    const viewer = socket('v1');
    joinSignaling(viewer, room.roomId, 'viewer', VIEWER.id);
    expect(helper.received.at(-1)).toMatchObject({
      type: 'peer-joined',
      roomId: room.roomId,
      peerId: 'v1',
    });
  });

  test('viewer SDP/ICE reach the helper as room-sdp/room-ice', () => {
    const room = createRoom(HOST);
    const helper = helperWire('helper-1');
    attachHelperToRoom(helper, room.roomId, HOST.id);
    const viewer = socket('v1');
    joinSignaling(viewer, room.roomId, 'viewer', VIEWER.id);
    helper.received.length = 0;

    const answer = { sdp: 'ANSWER', type: 'answer' as const };
    handleSignal(viewer, { type: 'sdp', roomId: room.roomId, sdp: answer });
    expect(helper.received.at(-1)).toEqual({
      type: 'room-sdp',
      roomId: room.roomId,
      peerId: 'v1',
      sdp: answer,
    });

    const candidate = { candidate: 'candidate:1 1 udp 1.2.3.4', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null };
    handleSignal(viewer, { type: 'ice', roomId: room.roomId, candidate });
    expect(helper.received.at(-1)).toEqual({
      type: 'room-ice',
      roomId: room.roomId,
      peerId: 'v1',
      candidate,
    });
  });

  test('helper SDP/ICE targets exactly one viewer (per-viewer negotiation)', () => {
    const room = createRoom(HOST);
    const helper = helperWire('helper-1');
    attachHelperToRoom(helper, room.roomId, HOST.id);
    const viewerA = socket('vA');
    const viewerB = socket('vB');
    joinSignaling(viewerA, room.roomId, 'viewer', VIEWER.id);
    joinSignaling(viewerB, room.roomId, 'viewer', OTHER.id);
    viewerA.sent.length = 0;
    viewerB.sent.length = 0;

    handleSignal(helper, { type: 'sdp', roomId: room.roomId, sdp: { type: 'offer', sdp: 'OFFER-A' }, target: 'vA' });
    expect(viewerA.sent).toContainEqual({ type: 'sdp', roomId: room.roomId, from: 'host', peerId: 'helper-1', sdp: { type: 'offer', sdp: 'OFFER-A' } });
    expect(viewerB.sent).not.toContainEqual(expect.objectContaining({ type: 'sdp' }) as never);

    const candidate = { candidate: 'candidate:2 1 udp 5.6.7.8', sdpMid: '1', sdpMLineIndex: 1, usernameFragment: null };
    handleSignal(helper, { type: 'ice', roomId: room.roomId, candidate, target: 'vB' });
    expect(viewerB.sent).toContainEqual({ type: 'ice', roomId: room.roomId, from: 'host', peerId: 'helper-1', candidate });
    expect(viewerA.sent).not.toContainEqual(expect.objectContaining({ type: 'ice' }) as never);
  });

  test('untargeted host SDP still broadcasts (back-compat with the browser test host)', () => {
    const room = createRoom(HOST);
    const host = socket('h1');
    const viewer = socket('v1');
    joinSignaling(host, room.roomId, 'host', HOST.id);
    joinSignaling(viewer, room.roomId, 'viewer', VIEWER.id);
    viewer.sent.length = 0;

    handleSignal(host, { type: 'sdp', roomId: room.roomId, sdp: { type: 'offer', sdp: 'OFFER' } });
    expect(viewer.sent).toContainEqual({ type: 'sdp', roomId: room.roomId, from: 'host', peerId: 'h1', sdp: { type: 'offer', sdp: 'OFFER' } });
  });

  test('attach fails for non-owners and when another host is present', () => {
    const room = createRoom(HOST);
    const helper = helperWire('helper-1');

    expect(attachHelperToRoom(helper, room.roomId, OTHER.id)).toMatchObject({
      ok: false,
      code: 'not_room_host',
    });

    const browserHost = socket('h1');
    expect(joinSignaling(browserHost, room.roomId, 'host', HOST.id).ok).toBe(true);
    expect(attachHelperToRoom(helper, room.roomId, HOST.id)).toMatchObject({
      ok: false,
      code: 'host_already_connected',
    });
  });

  test('helper leave notifies viewers that the host left', () => {
    const room = createRoom(HOST);
    const helper = helperWire('helper-1');
    attachHelperToRoom(helper, room.roomId, HOST.id);
    const viewer = socket('v1');
    joinSignaling(viewer, room.roomId, 'viewer', VIEWER.id);
    viewer.sent.length = 0;

    leaveSignaling(helper.id);
    expect(viewer.sent.at(-1)).toMatchObject({ type: 'peer-left', role: 'host' });

    // room can now be re-hosted
    expect(joinSignaling(socket('h2'), room.roomId, 'host', HOST.id).ok).toBe(true);
  });

  test('viewer that had already joined is announced to a later helper attach', () => {
    const room = createRoom(HOST);
    const viewer = socket('v1');
    joinSignaling(viewer, room.roomId, 'viewer', VIEWER.id);

    const helper = helperWire('helper-1');
    const join = attachHelperToRoom(helper, room.roomId, HOST.id);
    expect(join.ok).toBe(true);
    expect(helper.received[0]).toMatchObject({ type: 'attach-ack', ok: true, viewerCount: 1 });
    expect(helper.received[0]).toMatchObject({ type: 'attach-ack', viewers: ['v1'] });
  });
});