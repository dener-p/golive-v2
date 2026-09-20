import { randomBytes } from 'node:crypto';
import type { PublicUser, RoomInfo } from '@golive/shared';

/** Ambiguity-free alphabet (no l, o, 0, 1). */
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export interface Room {
  roomId: string;
  hostId: string;
  hostName: string;
  createdAt: string;
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