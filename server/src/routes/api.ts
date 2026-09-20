import { Hono } from 'hono';
import type { CommandRequest } from '@golive/shared';
import { requireUser } from '../http';
import { helperStatus, sendCommand } from '../helperRegistry';
import { iceServers, isDevAuth } from '../config';

export const apiApp = new Hono();

apiApp.get('/meta', (c) =>
  c.json({ name: 'golive', auth: isDevAuth ? 'dev' : 'discord' }),
);

apiApp.get('/ice-servers', (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ iceServers: iceServers() });
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