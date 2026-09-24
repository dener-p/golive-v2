import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PublicUser, RoomInfo } from '@golive/shared';
import { config } from './config';
import { db } from './db/client';
import { roomTable } from './db/schema';

/**
 * Rooms — persisted in SQLite (Turso in production), mirrored in-memory so the
 * signaling layer (synchronous WebSocket code) keeps reading without awaits.
 *
 * Watch links expire: `createRoom` stamps `expiresAt = now + TTL`; reads and a
 * periodic sweep (`sweepExpiredRooms`) drop expired rooms.
 */

/** Ambiguity-free alphabet (no l, o, 0, 1). */
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** 10 chars over a 32-symbol alphabet ≈ 50 bits — room links are unguessable. */
export const ROOM_ID_LENGTH = 10;

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
  /** Epoch ms after which the watch link stops working. Internal (not exposed). */
  expiresAt: number;
  turn?: TurnConfig;
}

const rooms = new Map<string, Room>();

function generateRoomId(length = ROOM_ID_LENGTH): string {
  let id = '';
  for (let i = 0; i < length; i++) {
    id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return id;
}

function roomTtlMs(): number {
  return config.roomTtlHours * 3_600_000;
}

/** Rebuild the in-memory mirror from the database (startup). */
export async function loadRooms(): Promise<void> {
  const rows = await db.select().from(roomTable).all();
  rooms.clear();
  for (const row of rows) {
    rooms.set(row.roomId, rowToRoom(row));
  }
}

function rowToRoom(row: {
  roomId: string;
  hostId: string;
  hostName: string;
  createdAt: number;
  expiresAt: number;
  turnUrls: string | null;
  turnUsername: string | null;
  turnCredential: string | null;
}): Room {
  const room: Room = {
    roomId: row.roomId,
    hostId: row.hostId,
    hostName: row.hostName,
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: row.expiresAt,
  };
  if (row.turnUrls) {
    room.turn = {
      urls: JSON.parse(row.turnUrls) as string[],
      username: row.turnUsername ?? '',
      credential: row.turnCredential ?? '',
    };
  }
  return room;
}

function roomToRow(room: Room) {
  return {
    roomId: room.roomId,
    hostId: room.hostId,
    hostName: room.hostName,
    createdAt: Date.parse(room.createdAt),
    expiresAt: room.expiresAt,
    turnUrls: room.turn?.urls ? JSON.stringify(room.turn.urls) : null,
    turnUsername: room.turn?.username ?? null,
    turnCredential: room.turn?.credential ?? null,
  };
}

export function createRoom(user: PublicUser): Room {
  let roomId: string;
  do {
    roomId = generateRoomId();
  } while (rooms.has(roomId));

  const now = Date.now();
  const room: Room = {
    roomId,
    hostId: user.id,
    hostName: user.username,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + roomTtlMs(),
  };
  rooms.set(room.roomId, room);
  void db
    .insert(roomTable)
    .values(roomToRow(room))
    .onConflictDoNothing()
    .catch((err) => console.error('[golive] room persist failed:', err));
  return room;
}

export function getRoom(roomId: string, now = Date.now()): Room | undefined {
  const id = roomId.trim().toLowerCase();
  const room = rooms.get(id);
  if (!room) return undefined;
  if (room.expiresAt <= now) {
    rooms.delete(id);
    void db
      .delete(roomTable)
      .where(eq(roomTable.roomId, id))
      .catch((err) => console.error('[golive] room expiry delete failed:', err));
    return undefined;
  }
  return room;
}

/** Delete every room past its expiry (periodic housekeeping, boot interval). */
export function sweepExpiredRooms(now = Date.now()): void {
  const expired: string[] = [];
  for (const [id, room] of rooms) {
    if (room.expiresAt <= now) expired.push(id);
  }
  for (const id of expired) {
    rooms.delete(id);
    void db
      .delete(roomTable)
      .where(eq(roomTable.roomId, id))
      .catch((err) => console.error('[golive] room sweep delete failed:', err));
  }
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
  const id = roomId.trim().toLowerCase();
  const room = rooms.get(id);
  if (!room) return false;
  if (turn) {
    room.turn = turn;
  } else {
    delete room.turn;
  }
  void db
    .update(roomTable)
    .set({
      turnUrls: room.turn?.urls ? JSON.stringify(room.turn.urls) : null,
      turnUsername: room.turn?.username ?? null,
      turnCredential: room.turn?.credential ?? null,
    })
    .where(eq(roomTable.roomId, id))
    .catch((err) => console.error('[golive] room turn persist failed:', err));
  return true;
}

export function getRoomTurn(roomId: string): TurnConfig | undefined {
  return rooms.get(roomId.trim().toLowerCase())?.turn;
}