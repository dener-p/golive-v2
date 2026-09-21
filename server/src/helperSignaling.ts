import type { ServerHelperMessage, ServerSignal } from '@golive/shared';
import { joinSignaling, type SignalingSocket } from './signaling';
import { iceServers } from './config';

/**
 * The native helper acts as a room's *host* but only ever speaks on its
 * persistent `/ws/helper` channel. This module adapts the room signaling
 * layer to that channel:
 *
 * - Helper→room requests (`attach-room`, `room-sdp`, `room-ice`, `detach-room`)
 *   are fed into the shared room state machine through a SignalingSocket whose
 *   id matches the helper's connection id.
 * - Room→helper events (viewer join/leave, viewer SDP/ICE) are dispatched to
 *   the helper as `ServerHelperMessage` frames.
 */

/** The `hello-ack` frame: carries the global ICE server list (M6: multiple
 * STUN servers instead of a helper-side hardcoded single endpoint). TURN, when
 * configured globally, rides along for later milestones. */
export function helloAck(): ServerHelperMessage {
  return {
    type: 'hello-ack',
    serverTime: new Date().toISOString(),
    iceServers: iceServers(),
  };
}

/** Translate one room signaling frame into the helper vocabulary. */
export function translateServerSignal(msg: ServerSignal): ServerHelperMessage | null {
  switch (msg.type) {
    case 'joined':
      return {
        type: 'attach-ack',
        ok: true,
        roomId: msg.roomId,
        viewerCount: msg.viewerCount,
        viewers: msg.viewers,
      };
    case 'peer-joined':
      return { type: 'peer-joined', roomId: msg.roomId, peerId: msg.peerId };
    case 'peer-left':
      return { type: 'peer-left', roomId: msg.roomId, peerId: msg.peerId };
    case 'sdp':
      return { type: 'room-sdp', roomId: msg.roomId, peerId: msg.peerId, sdp: msg.sdp };
    case 'ice':
      return { type: 'room-ice', roomId: msg.roomId, peerId: msg.peerId, candidate: msg.candidate };
    case 'error':
      return { type: 'attach-ack', ok: false, error: { code: msg.code, message: msg.message } };
  }
}

/**
 * Wrap the helper's raw send as a room SignalingSocket. Outbound room frames
 * are translated to the helper vocabulary before hitting the wire.
 */
export function helperSignalingSocket(
  connId: string,
  sendRaw: (raw: string) => void,
): SignalingSocket {
  return {
    id: connId,
    send: (raw: string) => {
      let msg: ServerSignal;
      try {
        msg = JSON.parse(raw) as ServerSignal;
      } catch {
        return;
      }
      const out = translateServerSignal(msg);
      if (out) sendRaw(JSON.stringify(out));
    },
  };
}

/** Attach the helper as the room host. Returns the raw JoinResult (the caller
 * translates a failure into an attach-ack). */
export function attachHelperToRoom(
  socket: SignalingSocket,
  roomId: string,
  userId: string,
): ReturnType<typeof joinSignaling> {
  return joinSignaling(socket, roomId, 'host', userId, socket.id);
}