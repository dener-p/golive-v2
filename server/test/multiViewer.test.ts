import { describe, expect, test } from 'bun:test';
import './setup';
import { createRoom } from '../src/store';
import { handleSignal, joinSignaling, leaveSignaling, type SignalingSocket } from '../src/signaling';
import { attachHelperToRoom, helperSignalingSocket } from '../src/helperSignaling';
import type { PublicUser, ServerHelperMessage, ServerSignal } from '@golive/shared';

const HOST: PublicUser = { id: 'host-1', username: 'Hosti', avatar: null };
const VIEWERS: PublicUser[] = Array.from({ length: 5 }, (_, i) => ({
  id: `viewer-${i}`,
  username: `Viewy${i}`,
  avatar: null,
}));

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

describe('multi-viewer fan-out (M4)', () => {
  test('helper receives peer-joined for each of 5 viewers', () => {
    const room = createRoom(HOST);
    const helper = helperWire('helper-1');
    const join = attachHelperToRoom(helper, room.roomId, HOST.id);
    expect(join.ok).toBe(true);
    // attach-ack is first
    expect(helper.received[0]).toMatchObject({ type: 'attach-ack', ok: true, viewerCount: 0 });
    helper.received.length = 0;

    for (let i = 0; i < 5; i++) {
      const s = socket(`v${i}`);
      joinSignaling(s, room.roomId, 'viewer', VIEWERS[i].id, `vp${i}`);
    }

    // Helper should see 5 peer-joined messages
    const joined = helper.received.filter((m) => m.type === 'peer-joined');
    expect(joined).toHaveLength(5);
  });

  test('targeted SDP offer reaches exactly one viewer', () => {
    const room = createRoom(HOST);
    const helper = helperWire('helper-1');
    attachHelperToRoom(helper, room.roomId, HOST.id);

    const viewers = VIEWERS.slice(0, 3).map((v, i) => {
      const s = socket(`v${i}`);
      joinSignaling(s, room.roomId, 'viewer', v.id, `vp${i}`);
      s.sent.length = 0; // clear join messages
      return s;
    });

    // Helper sends targeted offer to viewer 1 only
    handleSignal(helper, {
      type: 'sdp',
      roomId: room.roomId,
      sdp: { type: 'offer', sdp: 'OFFER-TO-V1' },
      target: 'vp1',
    });

    expect(viewers[0].sent).toHaveLength(0); // v0 gets nothing
    expect(viewers[1].sent).toHaveLength(1); // v1 gets the offer
    expect(viewers[1].sent[0]).toMatchObject({
      type: 'sdp',
      roomId: room.roomId,
      from: 'host',
      peerId: 'helper-1',
      sdp: { type: 'offer', sdp: 'OFFER-TO-V1' },
    });
    expect(viewers[2].sent).toHaveLength(0); // v2 gets nothing
  });

  test('each viewer answer reaches the helper as room-sdp', () => {
    const room = createRoom(HOST);
    const helper = helperWire('helper-1');
    attachHelperToRoom(helper, room.roomId, HOST.id);

    const viewers = VIEWERS.slice(0, 3).map((v, i) => {
      const s = socket(`v${i}`);
      joinSignaling(s, room.roomId, 'viewer', v.id, `vp${i}`);
      return s;
    });
    helper.received.length = 0;

    // Each viewer sends an answer
    for (let i = 0; i < 3; i++) {
      handleSignal(viewers[i], {
        type: 'sdp',
        roomId: room.roomId,
        sdp: { type: 'answer', sdp: `ANSWER-FROM-V${i}` },
      });
    }

    const roomSdp = helper.received.filter((m) => m.type === 'room-sdp');
    expect(roomSdp).toHaveLength(3);
    expect(roomSdp[0]).toMatchObject({ peerId: 'vp0', sdp: { sdp: 'ANSWER-FROM-V0' } });
    expect(roomSdp[1]).toMatchObject({ peerId: 'vp1', sdp: { sdp: 'ANSWER-FROM-V1' } });
    expect(roomSdp[2]).toMatchObject({ peerId: 'vp2', sdp: { sdp: 'ANSWER-FROM-V2' } });
  });

  test('targeted ICE candidates reach the correct viewer only', () => {
    const room = createRoom(HOST);
    const helper = helperWire('helper-1');
    attachHelperToRoom(helper, room.roomId, HOST.id);

    const viewers = VIEWERS.slice(0, 3).map((v, i) => {
      const s = socket(`v${i}`);
      joinSignaling(s, room.roomId, 'viewer', v.id, `vp${i}`);
      s.sent.length = 0;
      return s;
    });

    const candidate = {
      candidate: 'candidate:99 1 udp 10.0.0.1',
      sdpMid: '0',
      sdpMLineIndex: 0,
      usernameFragment: null,
    };

    // Helper sends targeted ICE to viewer 2
    handleSignal(helper, {
      type: 'ice',
      roomId: room.roomId,
      candidate,
      target: 'vp2',
    });

    expect(viewers[0].sent).toHaveLength(0);
    expect(viewers[1].sent).toHaveLength(0);
    expect(viewers[2].sent).toHaveLength(1);
    expect(viewers[2].sent[0]).toMatchObject({
      type: 'ice',
      roomId: room.roomId,
      from: 'host',
      peerId: 'helper-1',
      candidate,
    });
  });

  test('viewer leaving notifies the helper and frees the slot', () => {
    const room = createRoom(HOST);
    const helper = helperWire('helper-1');
    attachHelperToRoom(helper, room.roomId, HOST.id);

    const v0 = socket('v0');
    const v1 = socket('v1');
    joinSignaling(v0, room.roomId, 'viewer', VIEWERS[0].id, 'vp0');
    joinSignaling(v1, room.roomId, 'viewer', VIEWERS[1].id, 'vp1');
    helper.received.length = 0;
    v1.sent.length = 0;

    // v0 leaves
    leaveSignaling(v0.id);
    const left = helper.received.filter((m) => m.type === 'peer-left');
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ peerId: 'vp0' });

    // v1 is still connected — helper can reach it
    handleSignal(helper, {
      type: 'sdp',
      roomId: room.roomId,
      sdp: { type: 'offer', sdp: 'STILL-HERE' },
      target: 'vp1',
    });
    expect(v1.sent).toHaveLength(1);
  });

  test('helper detach clears all viewers from the room', () => {
    const room = createRoom(HOST);
    const helper = helperWire('helper-1');
    attachHelperToRoom(helper, room.roomId, HOST.id);

    const viewers = VIEWERS.slice(0, 2).map((v, i) => {
      const s = socket(`v${i}`);
      joinSignaling(s, room.roomId, 'viewer', v.id, `vp${i}`);
      s.sent.length = 0;
      return s;
    });

    // Helper detaches (simulates stop command)
    leaveSignaling(helper.id);

    // Both viewers get host-left
    expect(viewers[0].sent.at(-1)).toMatchObject({ type: 'peer-left', role: 'host' });
    expect(viewers[1].sent.at(-1)).toMatchObject({ type: 'peer-left', role: 'host' });

    // A new host can now take over
    expect(joinSignaling(socket('h2'), room.roomId, 'host', HOST.id).ok).toBe(true);
  });
});
