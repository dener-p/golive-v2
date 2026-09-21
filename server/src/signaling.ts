import type {
  ClientSignal,
  IceCandidateMessage,
  Role,
  ServerErrorCode,
  ServerSignal,
  SdpMessage,
} from '@golive/shared';
import { getRoom } from './store';

/** Minimal socket surface so the module stays testable without a real WS. */
export interface SignalingSocket {
  readonly id: string;
  send(raw: string): void;
}

interface Member {
  socket: SignalingSocket;
  userId: string;
  role: Role;
  roomId: string;
  peerId: string;
}

const byRoom = new Map<string, Map<string, Member>>();
const byId = new Map<string, Member>();

export type JoinResult =
  | { ok: true; roomId: string; role: Role; viewerCount: number }
  | { ok: false; code: ServerErrorCode; message: string };

function membersOf(roomId: string): Member[] {
  return [...(byRoom.get(roomId)?.values() ?? [])];
}

function hostOf(roomId: string): Member | undefined {
  return membersOf(roomId).find((m) => m.role === 'host');
}

function send(member: Member, msg: ServerSignal): void {
  member.socket.send(JSON.stringify(msg));
}

function broadcast(roomId: string, msg: ServerSignal, exceptId?: string): void {
  for (const m of membersOf(roomId)) {
    if (m.socket.id !== exceptId) send(m, msg);
  }
}

/**
 * Register a socket in a room under a role. Returns the `joined` info or a
 * typed error (the caller is responsible for closing the socket on error).
 */
export function joinSignaling(
  socket: SignalingSocket,
  roomId: string,
  role: Role,
  userId: string,
  peerId?: string,
): JoinResult {
  const room = getRoom(roomId);
  if (!room) {
    return { ok: false, code: 'room_not_found', message: `Room "${roomId}" does not exist` };
  }
  if (role === 'host' && room.hostId !== userId) {
    return {
      ok: false,
      code: 'not_room_host',
      message: 'Sign in as the room owner to connect as host',
    };
  }
  if (role === 'host' && membersOf(room.roomId).some((m) => m.role === 'host')) {
    return {
      ok: false,
      code: 'host_already_connected',
      message: 'A host is already connected to this room',
    };
  }
  // Viewers are anonymous: the room link is the only requirement (no allowlist).

  // Replace any stale registration for the same socket id.
  leaveSignaling(socket.id);

  const member: Member = {
    socket,
    userId,
    role,
    roomId: room.roomId,
    peerId: peerId ?? socket.id,
  };
  if (!byRoom.has(room.roomId)) byRoom.set(room.roomId, new Map());
  byRoom.get(room.roomId)!.set(socket.id, member);
  byId.set(socket.id, member);

  const viewerCount = membersOf(room.roomId).filter((m) => m.role === 'viewer').length;
  const viewers =
    role === 'host'
      ? membersOf(room.roomId).filter((m) => m.role === 'viewer').map((m) => m.peerId)
      : undefined;
  send(member, {
    type: 'joined',
    roomId: room.roomId,
    role,
    peerId: member.peerId,
    viewerCount,
    ...(viewers ? { viewers } : {}),
  });

  if (role === 'host') {
    broadcast(
      room.roomId,
      { type: 'peer-joined', roomId: room.roomId, role: 'host', peerId: member.peerId },
      socket.id,
    );
  } else {
    const host = hostOf(room.roomId);
    if (host) {
      send(host, {
        type: 'peer-joined',
        roomId: room.roomId,
        role: 'viewer',
        peerId: member.peerId,
      });
    }
  }

  return { ok: true, roomId: room.roomId, role, viewerCount };
}

/**
 * Handle an inbound signaling message (sdp/ice/leave) from a live member.
 * Non-member messages are ignored.
 */
export function handleSignal(socket: SignalingSocket, msg: ClientSignal): void {
  const member = byId.get(socket.id);
  if (!member) return;

  if (msg.type === 'sdp') {
    relaySdp(member, msg.sdp, msg.target);
    return;
  }
  if (msg.type === 'ice') {
    relayIce(member, msg.candidate, msg.target);
    return;
  }
  if (msg.type === 'leave') {
    leaveSignaling(socket.id);
  }
}

/**
 * Relay a host→viewer frame to a single viewer. `target` is that viewer's
 * `peerId` (each host connection is per-viewer, like the native helper's fan-out).
 */
function relayToViewer(roomId: string, targetPeerId: string, msg: ServerSignal): boolean {
  const target = membersOf(roomId).find(
    (m) => m.role === 'viewer' && m.peerId === targetPeerId,
  );
  if (target) {
    send(target, msg);
    return true;
  }
  return false;
}

function relaySdp(member: Member, sdp: SdpMessage, target?: string): void {
  if (member.role === 'host') {
    const msg: ServerSignal = { type: 'sdp', roomId: member.roomId, from: 'host', peerId: member.peerId, sdp };
    if (target) {
      relayToViewer(member.roomId, target, msg);
    } else {
      broadcast(member.roomId, msg, member.socket.id);
    }
  } else {
    const host = hostOf(member.roomId);
    if (host) send(host, { type: 'sdp', roomId: member.roomId, from: 'viewer', peerId: member.peerId, sdp });
  }
}

function relayIce(member: Member, candidate: IceCandidateMessage, target?: string): void {
  if (member.role === 'host') {
    const msg: ServerSignal = { type: 'ice', roomId: member.roomId, from: 'host', peerId: member.peerId, candidate };
    if (target) {
      relayToViewer(member.roomId, target, msg);
    } else {
      broadcast(member.roomId, msg, member.socket.id);
    }
  } else {
    const host = hostOf(member.roomId);
    if (host) send(host, { type: 'ice', roomId: member.roomId, from: 'viewer', peerId: member.peerId, candidate });
  }
}

export function leaveSignaling(socketId: string): void {
  const member = byId.get(socketId);
  if (!member) return;

  byRoom.get(member.roomId)?.delete(socketId);
  byId.delete(socketId);

  const msg: ServerSignal = {
    type: 'peer-left',
    roomId: member.roomId,
    role: member.role,
    peerId: member.peerId,
  };
  if (member.role === 'host') {
    broadcast(member.roomId, msg);
  } else {
    const host = hostOf(member.roomId);
    if (host) send(host, msg);
  }
}

export function viewerCount(roomId: string): number {
  return membersOf(roomId).filter((m) => m.role === 'viewer').length;
}

export function memberCount(roomId: string): number {
  return membersOf(roomId).length;
}