import { describe, expect, test } from 'bun:test';
import './setup';
import { createRoom } from '../src/store';
import {
  handleSignal,
  joinSignaling,
  leaveSignaling,
  type SignalingSocket,
} from '../src/signaling';
import type { PublicUser, ServerSignal } from '@golive/shared';

const HOST: PublicUser = { id: 'host-1', username: 'Hosti', avatar: null };
const VIEWER: PublicUser = { id: 'viewer-1', username: 'Viewy', avatar: null };
const OTHER: PublicUser = { id: 'other-1', username: 'Intruder', avatar: null };

function socket(id: string): SignalingSocket & { sent: ServerSignal[] } {
  const sent: ServerSignal[] = [];
  return {
    id,
    sent,
    send: (raw) => sent.push(JSON.parse(raw) as ServerSignal),
  };
}

describe('signaling', () => {
  test('viewer can join a room before the host and is notified when host arrives', () => {
    const room = createRoom(HOST);
    const viewer = socket('v1');

    const join = joinSignaling(viewer, room.roomId, 'viewer', VIEWER.id);
    expect(join.ok).toBe(true);
    expect(viewer.sent[0]).toMatchObject({ type: 'joined', role: 'viewer' });

    const host = socket('h1');
    const hostJoin = joinSignaling(host, room.roomId, 'host', HOST.id);
    expect(hostJoin.ok).toBe(true);

    // viewers get told a host joined
    const hostJoinedMsg = viewer.sent.at(-1);
    expect(hostJoinedMsg).toMatchObject({ type: 'peer-joined', role: 'host' });
    // host learns viewer count
    expect(host.sent[0]).toMatchObject({ type: 'joined', viewerCount: 1 });
  });

  test('relays SDP and ICE between host and viewer but not viewer-to-viewer', () => {
    const room = createRoom(HOST);
    const host = socket('h1');
    const viewerA = socket('vA');
    const viewerB = socket('vB');

    joinSignaling(host, room.roomId, 'host', HOST.id);
    joinSignaling(viewerA, room.roomId, 'viewer', VIEWER.id);
    joinSignaling(viewerB, room.roomId, 'viewer', OTHER.id);
    host.sent.length = 0;
    viewerA.sent.length = 0;
    viewerB.sent.length = 0;

    // host offer -> both viewers
    handleSignal(host, { type: 'sdp', roomId: room.roomId, sdp: { type: 'offer', sdp: 'OFFER' } });
    expect(viewerA.sent).toContainEqual({ type: 'sdp', roomId: room.roomId, from: 'host', peerId: 'h1', sdp: { type: 'offer', sdp: 'OFFER' } });
    expect(viewerB.sent).toContainEqual({ type: 'sdp', roomId: room.roomId, from: 'host', peerId: 'h1', sdp: { type: 'offer', sdp: 'OFFER' } });

    // viewerA answer -> host only
    handleSignal(viewerA, { type: 'sdp', roomId: room.roomId, sdp: { type: 'answer', sdp: 'ANSWER-A' } });
    expect(host.sent).toContainEqual({ type: 'sdp', roomId: room.roomId, from: 'viewer', peerId: 'vA', sdp: { type: 'answer', sdp: 'ANSWER-A' } });
    expect(viewerB.sent).not.toContainEqual(
      expect.objectContaining({ from: 'viewer' }) as never,
    );

    // ICE relay both directions
    const candidate = { candidate: 'candidate:1 1 udp', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null };
    handleSignal(host, { type: 'ice', roomId: room.roomId, candidate });
    expect(viewerA.sent).toContainEqual({ type: 'ice', roomId: room.roomId, from: 'host', peerId: 'h1', candidate });
    handleSignal(viewerA, { type: 'ice', roomId: room.roomId, candidate });
    expect(host.sent).toContainEqual({ type: 'ice', roomId: room.roomId, from: 'viewer', peerId: 'vA', candidate });
  });

  test('any viewer may join without being on a list (no allowlist)', () => {
    const room = createRoom(HOST);
    const guest = socket('guest-1');
    // Guest ids are what anonymous viewers get; they join like anyone else.
    expect(joinSignaling(guest, room.roomId, 'viewer', 'guest-abc').ok).toBe(true);
  });

  test('enforces role rules', () => {
    const room = createRoom(HOST);

    // non-owner cannot host
    const intruder = socket('i1');
    expect(joinSignaling(intruder, room.roomId, 'host', OTHER.id)).toMatchObject({
      ok: false,
      code: 'not_room_host',
    });

    // only one host per room
    const host1 = socket('h1');
    const host2 = socket('h2');
    expect(joinSignaling(host1, room.roomId, 'host', HOST.id).ok).toBe(true);
    expect(joinSignaling(host2, room.roomId, 'host', HOST.id)).toMatchObject({
      ok: false,
      code: 'host_already_connected',
    });

    // unknown room
    expect(joinSignaling(socket('x'), 'nope99', 'viewer', VIEWER.id)).toMatchObject({
      ok: false,
      code: 'room_not_found',
    });
  });

  test('notifies viewers when the host leaves', () => {
    const room = createRoom(HOST);
    const host = socket('h1');
    const viewer = socket('v1');
    joinSignaling(host, room.roomId, 'host', HOST.id);
    joinSignaling(viewer, room.roomId, 'viewer', VIEWER.id);
    viewer.sent.length = 0;

    leaveSignaling(host.id);
    expect(viewer.sent.at(-1)).toMatchObject({ type: 'peer-left', role: 'host' });
  });

  test('leave via signal message works too', () => {
    const room = createRoom(HOST);
    const host = socket('h1');
    joinSignaling(host, room.roomId, 'host', HOST.id);
    handleSignal(host, { type: 'leave' });
    // host is gone; viewer can now take over
    const newHost = socket('h2');
    expect(joinSignaling(newHost, room.roomId, 'host', HOST.id).ok).toBe(true);
  });
});