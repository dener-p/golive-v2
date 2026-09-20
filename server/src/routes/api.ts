import { Hono } from 'hono';
import type { CommandRequest, TurnConfigRequest } from '@golive/shared';
import { requireUser } from '../http';
import { helperStatus, sendCommand } from '../helperRegistry';
import { iceServers, isDevAuth, config } from '../config';
import { getRoom, getRoomTurn, setRoomTurn } from '../store';

export const apiApp = new Hono();

apiApp.get('/meta', (c) =>
  c.json({ name: 'golive', auth: isDevAuth ? 'dev' : 'discord' }),
);

apiApp.get('/ice-servers', (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const roomId = c.req.query('roomId');
  let servers = iceServers();
  let turnConfigured = !!config.turn;

  // If a roomId is provided, include room-specific TURN if available
  if (roomId) {
    const roomTurn = getRoomTurn(roomId);
    if (roomTurn) {
      // Room-specific TURN overrides global TURN
      servers = [
        ...config.stunServers.map((url) => ({ urls: url })),
        { urls: roomTurn.urls, username: roomTurn.username, credential: roomTurn.credential },
      ];
      turnConfigured = true;
    }
  }

  return c.json({ iceServers: servers, turnConfigured });
});

apiApp.post('/rooms/:roomId/turn', async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  const roomId = c.req.param('roomId');
  const room = getRoom(roomId);
  if (!room) return c.json({ error: 'room_not_found' }, 404);
  if (room.hostId !== user.id) return c.json({ error: 'not_room_host' }, 403);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request' }, 400);
  }

  const turn = body as TurnConfigRequest | null;
  if (!turn || !turn.urls?.length) {
    // Clear TURN config
    setRoomTurn(roomId, null);
    return c.json({ ok: true, turnConfigured: false });
  }

  // Validate
  if (!Array.isArray(turn.urls) || turn.urls.some((u) => typeof u !== 'string')) {
    return c.json({ error: 'invalid_urls' }, 400);
  }
  if (typeof turn.username !== 'string' || typeof turn.credential !== 'string') {
    return c.json({ error: 'invalid_credentials' }, 400);
  }

  setRoomTurn(roomId, {
    urls: turn.urls.filter(Boolean),
    username: turn.username,
    credential: turn.credential,
  });
  return c.json({ ok: true, turnConfigured: true });
});

apiApp.get('/helper/status', (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ status: helperStatus(user.id) });
});

apiApp.post('/helper/command', async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request' }, 400);
  }

  const { command, payload } = (body ?? {}) as CommandRequest;
  if (typeof command !== 'string' || !command.trim()) {
    return c.json({ error: 'missing_command' }, 400);
  }
  const trimmed = command.trim();
  if (trimmed.length > 64) return c.json({ error: 'command_too_long' }, 400);

  const delivered = sendCommand(user.id, trimmed, payload);
  if (!delivered.delivered) return c.json({ delivered: false, reason: 'helper_offline' }, 409);
  return c.json({ delivered: true, id: delivered.id });
});