import { describe, expect, test } from 'bun:test';
import { createRoom, setRoomTurn, getRoomTurn } from '../src/store';
import type { PublicUser } from '@golive/shared';

const HOST: PublicUser = { id: 'host-1', username: 'Hosti', avatar: null };

describe('room TURN config', () => {
  test('set and get TURN config for a room', () => {
    const room = createRoom(HOST);
    const turn = {
      urls: ['turn:turn.example.com:3478'],
      username: 'user',
      credential: 'pass',
    };

    expect(setRoomTurn(room.roomId, turn)).toBe(true);
    expect(getRoomTurn(room.roomId)).toEqual(turn);
  });

  test('clear TURN config', () => {
    const room = createRoom(HOST);
    setRoomTurn(room.roomId, {
      urls: ['turn:turn.example.com:3478'],
      username: 'user',
      credential: 'pass',
    });

    expect(setRoomTurn(room.roomId, null)).toBe(true);
    expect(getRoomTurn(room.roomId)).toBeUndefined();
  });

  test('set TURN config for unknown room returns false', () => {
    expect(setRoomTurn('nonexistent', {
      urls: ['turn:turn.example.com:3478'],
      username: 'user',
      credential: 'pass',
    })).toBe(false);
  });

  test('get TURN config for room without TURN returns undefined', () => {
    const room = createRoom(HOST);
    expect(getRoomTurn(room.roomId)).toBeUndefined();
  });

  test('TURN config is per-room (different rooms have different configs)', () => {
    const room1 = createRoom(HOST);
    const room2 = createRoom(HOST);

    setRoomTurn(room1.roomId, {
      urls: ['turn:turn1.example.com:3478'],
      username: 'user1',
      credential: 'pass1',
    });

    setRoomTurn(room2.roomId, {
      urls: ['turn:turn2.example.com:3478'],
      username: 'user2',
      credential: 'pass2',
    });

    expect(getRoomTurn(room1.roomId)?.urls).toEqual(['turn:turn1.example.com:3478']);
    expect(getRoomTurn(room2.roomId)?.urls).toEqual(['turn:turn2.example.com:3478']);
  });

  test('set TURN config replaces existing config', () => {
    const room = createRoom(HOST);
    setRoomTurn(room.roomId, {
      urls: ['turn:old.example.com:3478'],
      username: 'old',
      credential: 'old',
    });

    setRoomTurn(room.roomId, {
      urls: ['turn:new.example.com:3478'],
      username: 'new',
      credential: 'new',
    });

    expect(getRoomTurn(room.roomId)).toEqual({
      urls: ['turn:new.example.com:3478'],
      username: 'new',
      credential: 'new',
    });
  });
});
