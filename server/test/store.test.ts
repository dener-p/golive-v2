import { describe, expect, test } from 'bun:test';
import { createRoom, getRoom, toRoomInfo } from '../src/store';
import type { PublicUser } from '@golive/shared';

const USER: PublicUser = { id: 'u1', username: 'alice', avatar: null };

describe('room store', () => {
  test('creates rooms with unique short ids', () => {
    const a = createRoom(USER);
    const b = createRoom(USER);
    expect(a.roomId).not.toEqual(b.roomId);
    expect(a.roomId).toHaveLength(6);
    expect(a.hostId).toBe('u1');
  });

  test('lookups are case-insensitive', () => {
    const room = createRoom(USER);
    expect(getRoom(room.roomId.toLowerCase())?.roomId).toBe(room.roomId);
    expect(getRoom(room.roomId.toUpperCase())?.roomId).toBe(room.roomId);
  });

  test('unknown room returns undefined', () => {
    expect(getRoom('zzzzzz')).toBeUndefined();
  });

  test('toRoomInfo exposes public shape only', () => {
    const room = createRoom(USER);
    expect(toRoomInfo(room)).toEqual({
      roomId: room.roomId,
      hostId: 'u1',
      hostName: 'alice',
      createdAt: expect.any(String) as string,
    });
  });
});