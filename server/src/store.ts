import { randomBytes } from 'node:crypto';
import type { PublicUser, RoomInfo } from '@golive/shared';

/** Ambiguity-free alphabet (no l, o, 0, 1). */
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export interface TurnConfig {
  urls: string[];
  username: string;
  credential: string;
}

export interface Room {
  roomId: string;
  hostId: string;
  hostName: string;
  createdAt: string;
  turn?: TurnConfig;
  /** Viewer allowlist. Empty = open room (anyone can join). */
  allowlist: Set<string>;
}

const rooms = new Map<string, Room>();

function generateRoomId(length = 6): string {
  let id = '';
  for (let i = 0; i < length; i++) {
    id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return id;
}

export function createRoom(user: PublicUser): Room {
  let roomId: string;
  do {
    roomId = generateRoomId();
  } while (rooms.has(roomId));

  const room: Room = {
    roomId,
    hostId: user.id,
    hostName: user.username,
    createdAt: new Date().toISOString(),
    allowlist: new Set(),
  };
  rooms.set(room.roomId, room);
  return room;
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId.trim().toLowerCase());
}

export function toRoomInfo(room: Room): RoomInfo {
  return {
    roomId: room.roomId,
    hostId: room.hostId,
    hostName: room.hostName,
    createdAt: room.createdAt,
  };
}

export function setRoomTurn(roomId: string, turn: TurnConfig | null): boolean {
  const room = rooms.get(roomId.trim().toLowerCase());
  if (!room) return false;
  if (turn) {
    room.turn = turn;
  } else {
    delete room.turn;
  }
  return true;
}

export function getRoomTurn(roomId: string): TurnConfig | undefined {
  return rooms.get(roomId.trim().toLowerCase())?.turn;
}

// ---------------------------------------------------------------------------
// Viewer allowlist
// ---------------------------------------------------------------------------

/**
 * Check if a viewer is allowed to join a room.
 * Returns true if: the room has no allowlist (open) OR the viewer is in it.
 */
export function isViewerAllowed(roomId: string, viewerId: string): boolean {
  const room = rooms.get(roomId.trim().toLowerCase());
  if (!room) return false;
  if (room.allowlist.size === 0) return true; // open room
  return room.allowlist.has(viewerId);
}

export function addToAllowlist(roomId: string, viewerId: string): boolean {
  const room = rooms.get(roomId.trim().toLowerCase());
  if (!room) return false;
  room.allowlist.add(viewerId);
  return true;
}

export function removeFromAllowlist(roomId: string, viewerId: string): boolean {
  const room = rooms.get(roomId.trim().toLowerCase());
  if (!room) return false;
  return room.allowlist.delete(viewerId);
}

export function getAllowlist(roomId: string): string[] {
  const room = rooms.get(roomId.trim().toLowerCase());
  if (!room) return [];
  return [...room.allowlist];
}

/** Clear the allowlist (makes the room open again). */
export function clearAllowlist(roomId: string): boolean {
  const room = rooms.get(roomId.trim().toLowerCase());
  if (!room) return false;
  room.allowlist.clear();
  return true;
}