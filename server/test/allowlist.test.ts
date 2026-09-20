import { describe, expect, test } from 'bun:test';
import {
  createRoom,
  addToAllowlist,
  removeFromAllowlist,
  getAllowlist,
  clearAllowlist,
  isViewerAllowed,
} from '../src/store';
import { joinSignaling, type SignalingSocket } from '../src/signaling';
import type { PublicUser } from '@golive/shared';

const HOST: PublicUser = { id: 'host-1', username: 'Hosti', avatar: null };
const VIEWER: PublicUser = { id: 'viewer-1', username: 'Viewy', avatar: null };
const OTHER: PublicUser = { id: 'viewer-2', username: 'Other', avatar: null };

function socket(id: string): SignalingSocket & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { id, sent, send: (raw) => sent.push(JSON.parse(raw)) };
}

describe('viewer allowlist', () => {
  test('open room allows any viewer', () => {
    const room = createRoom(HOST);
    expect(isViewerAllowed(room.roomId, VIEWER.id)).toBe(true);
    expect(isViewerAllowed(room.roomId, OTHER.id)).toBe(true);
  });

  test('adding a viewer to the allowlist restricts access', () => {
    const room = createRoom(HOST);
    addToAllowlist(room.roomId, VIEWER.id);

    expect(isViewerAllowed(room.roomId, VIEWER.id)).toBe(true);
    expect(isViewerAllowed(room.roomId, OTHER.id)).toBe(false);
  });

  test('removing a viewer revokes access (when other viewers remain)', () => {
    const room = createRoom(HOST);
    addToAllowlist(room.roomId, VIEWER.id);
    addToAllowlist(room.roomId, OTHER.id);
    removeFromAllowlist(room.roomId, VIEWER.id);

    expect(isViewerAllowed(room.roomId, VIEWER.id)).toBe(false);
    expect(isViewerAllowed(room.roomId, OTHER.id)).toBe(true);
  });

  test('removing the last viewer makes the room open again', () => {
    const room = createRoom(HOST);
    addToAllowlist(room.roomId, VIEWER.id);
    removeFromAllowlist(room.roomId, VIEWER.id);

    // Empty allowlist = open room
    expect(isViewerAllowed(room.roomId, VIEWER.id)).toBe(true);
  });

  test('clearing the allowlist makes the room open again', () => {
    const room = createRoom(HOST);
    addToAllowlist(room.roomId, VIEWER.id);
    addToAllowlist(room.roomId, OTHER.id);
    clearAllowlist(room.roomId);

    expect(isViewerAllowed(room.roomId, VIEWER.id)).toBe(true);
    expect(isViewerAllowed(room.roomId, OTHER.id)).toBe(true);
  });

  test('getAllowlist returns all added viewers', () => {
    const room = createRoom(HOST);
    addToAllowlist(room.roomId, VIEWER.id);
    addToAllowlist(room.roomId, OTHER.id);

    const list = getAllowlist(room.roomId);
    expect(list).toContain(VIEWER.id);
    expect(list).toContain(OTHER.id);
    expect(list).toHaveLength(2);
  });

  test('signaling rejects viewers not on the allowlist', () => {
    const room = createRoom(HOST);
    addToAllowlist(room.roomId, VIEWER.id);

    const allowed = socket('v1');
    const denied = socket('v2');

    expect(joinSignaling(allowed, room.roomId, 'viewer', VIEWER.id).ok).toBe(true);
    expect(joinSignaling(denied, room.roomId, 'viewer', OTHER.id)).toMatchObject({
      ok: false,
      code: 'not_allowed',
    });
  });

  test('signaling allows host even with allowlist active', () => {
    const room = createRoom(HOST);
    addToAllowlist(room.roomId, VIEWER.id);

    const host = socket('h1');
    expect(joinSignaling(host, room.roomId, 'host', HOST.id).ok).toBe(true);
  });

  test('operations on unknown room return false/empty', () => {
    expect(addToAllowlist('nope', VIEWER.id)).toBe(false);
    expect(removeFromAllowlist('nope', VIEWER.id)).toBe(false);
    expect(clearAllowlist('nope')).toBe(false);
    expect(getAllowlist('nope')).toEqual([]);
    expect(isViewerAllowed('nope', VIEWER.id)).toBe(false);
  });
});
