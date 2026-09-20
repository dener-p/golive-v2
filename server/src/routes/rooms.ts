import { Hono } from 'hono';
import { requireUser } from '../http';
import { createRoom, getRoom, toRoomInfo } from '../store';

export const roomsApp = new Hono();

roomsApp.post('/', (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const room = createRoom(user);
  return c.json({ room: toRoomInfo(room) }, 201);
});

roomsApp.get('/:roomId', (c) => {
  const room = getRoom(c.req.param('roomId'));
  if (!room) return c.json({ error: 'room_not_found' }, 404);
  return c.json({ room: toRoomInfo(room) });
});