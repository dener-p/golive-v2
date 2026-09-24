import { beforeEach, describe, expect, test } from 'bun:test';
import type { PublicUser } from '@golive/shared';
import { resetAllForTests } from './setup';
import {
  createRoom,
  getRoom,
  getRoomTurn,
  loadRooms,
  setRoomTurn,
  sweepExpiredRooms,
} from '../src/store';
import { createSession, destroySession, getSession, getUser, loadSessions } from '../src/sessions';
import { issueHelperToken, loadHelperTokens, userForHelperToken } from '../src/tokens';

const USER: PublicUser = { id: 'u1', username: 'Dev', avatar: null };

beforeEach(async () => resetAllForTests());

/** Let the fire-and-forget persistence writes land. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe('persistence (server restarts no longer lose state)', () => {
  test('rooms persist across a simulated restart', async () => {
    const room = createRoom(USER);
    await flush();
    await loadRooms(); // rebuild mirror from the database
    expect(getRoom(room.roomId)).toMatchObject({
      roomId: room.roomId,
      hostId: 'u1',
      hostName: 'Dev',
    });
  });

  test('room TURN config persists', async () => {
    const room = createRoom(USER);
    setRoomTurn(room.roomId, { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' });
    await flush();
    await loadRooms();
    expect(getRoomTurn(room.roomId)).toEqual({
      urls: ['turn:turn.example.com:3478'],
      username: 'u',
      credential: 'p',
    });
  });

  test('sessions persist across a simulated restart', async () => {
    const token = createSession(USER);
    await flush();
    await loadSessions();
    expect(getSession(token)?.user).toEqual(USER);
    expect(getUser(token)?.id).toBe('u1');
  });

  test('helper tokens persist across a simulated restart', async () => {
    const issued = issueHelperToken(USER, 'desk')!;
    await flush();
    await loadHelperTokens();
    expect(userForHelperToken(issued.token)?.id).toBe('u1');
  });

  test('destroySession removes the row too', async () => {
    const token = createSession(USER);
    destroySession(token);
    await flush();
    expect(getSession(token)).toBeNull();
    await loadSessions();
    expect(getSession(token)).toBeNull();
  });
});

describe('room expiry (watch links have a TTL)', () => {
  test('expired rooms are rejected lazily on read', () => {
    const room = createRoom(USER);
    expect(getRoom(room.roomId)).toBeDefined();
    room.expiresAt = Date.now() - 1; // simulate TTL passing
    expect(getRoom(room.roomId)).toBeUndefined();
    expect(getRoom(room.roomId)).toBeUndefined(); // gone for good
  });

  test('sweepExpiredRooms removes only expired rooms', () => {
    const keep = createRoom(USER);
    const expire = createRoom(USER);
    expire.expiresAt = Date.now() - 1;

    sweepExpiredRooms(Date.now());

    expect(getRoom(keep.roomId)).toBeDefined();
    expect(getRoom(expire.roomId)).toBeUndefined();
  });
});

describe('session expiry', () => {
  test('sessions older than 30 days are rejected', () => {
    const past = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const token = createSession(USER, past);
    expect(getSession(token)).toBeNull();
  });
});