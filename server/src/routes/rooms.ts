import { Hono } from 'hono';
import { requireUser } from '../http';
import { createRoom, getRoom, toRoomInfo } from '../store';
import { rateLimit } from '../rateLimit';

export const roomsApp = new Hono();

// Hosting requires a signed-in owner; watching does not.
roomsApp.post(
  '/',
  rateLimit({ scope: 'room:create', limit: 20, windowMs: 60_000 }),
  (c) => {
    const user = requireUser(c);
    if (!user) return c.json({ error: 'unauthorized' }, 401);
    const room = createRoom(user);
    return c.json({ room: toRoomInfo(room) }, 201);
  },
);

// Public: anonymous viewers validate the room before opening a socket.
roomsApp.get('/:roomId', (c) => {
  const room = getRoom(c.req.param('roomId'));
  if (!room) return c.json({ error: 'room_not_found' }, 404);
  return c.json({ room: toRoomInfo(room) });
});