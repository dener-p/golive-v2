import { Hono } from 'hono';
import { resolve } from 'node:path';
import type { CommandRequest, TurnConfigRequest } from '@golive/shared';
import { requireUser } from '../http';
import { helperStatus, sendCommand } from '../helperRegistry';
import { iceServers, isDevAuth, config } from '../config';
import { getRoom, getRoomTurn, setRoomTurn } from '../store';
import {
  consumePairingCode,
  createPairingCode,
  helperTokensFor,
  issueHelperToken,
  revokeBearerToken,
  revokeHelperToken,
} from '../tokens';

export const apiApp = new Hono();

/** Directory the release script publishes helper binaries + latest.json into. */
const HELPER_DIR = resolve(import.meta.dir, '../../public/helper');

apiApp.get('/meta', (c) =>
  c.json({ name: 'golive', auth: isDevAuth ? 'dev' : 'discord', baseUrl: config.baseUrl }),
);

// ---------------------------------------------------------------------------
// Helper pairing (host browser mint → helper exchange → long-lived token)
// ---------------------------------------------------------------------------

apiApp.post('/pair', (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const { code, expiresInSeconds } = createPairingCode(user);
  return c.json({ code, expiresInSeconds });
});

apiApp.post('/pair/exchange', async (c) => {
  let body: unknown = null;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request' }, 400);
  }
  const { code, deviceName } = (body ?? {}) as { code?: unknown; deviceName?: unknown };
  if (typeof code !== 'string' || code.length > 12) {
    return c.json({ error: 'invalid_code' }, 400);
  }
  const user = consumePairingCode(code);
  if (!user) return c.json({ error: 'code_invalid_or_expired' }, 410);
  const issued = issueHelperToken(user, typeof deviceName === 'string' ? deviceName : undefined);
  if (!issued) return c.json({ error: 'too_many_devices' }, 409);
  return c.json({ token: issued.token, userId: user.id, deviceId: issued.id });
});

apiApp.get('/pair/tokens', (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({
    tokens: helperTokensFor(user.id).map((t) => ({
      id: t.id,
      deviceName: t.deviceName,
      createdAt: new Date(t.createdAt).toISOString(),
    })),
  });
});

apiApp.delete('/pair/tokens/:id', (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ ok: revokeHelperToken(user.id, c.req.param('id')) });
});

// The helper revokes its own stored token on "unpair": presented via Bearer.
apiApp.post('/pair/revoke', (c) =>
  c.json({ ok: revokeBearerToken(c.req.header('authorization')) }),
);

// ---------------------------------------------------------------------------
// Helper download (public — an end user with no helper is pointed here by the
// host page; no session required, same as the viewer room link).
// ---------------------------------------------------------------------------

interface HelperMeta {
  version: string;
  file: string;
  sha256: string;
}

async function helperMeta(): Promise<HelperMeta | null> {
  const file = Bun.file(resolve(HELPER_DIR, 'latest.json'));
  if (!(await file.exists())) return null;
  try {
    const meta = (await file.json()) as HelperMeta;
    if (typeof meta?.version !== 'string' || typeof meta?.file !== 'string') return null;
    return meta;
  } catch {
    return null;
  }
}

apiApp.get('/helper/latest', async (c) => {
  const meta = await helperMeta();
  if (!meta) return c.json({ available: false });
  return c.json({
    available: true,
    version: meta.version,
    file: meta.file,
    sha256: meta.sha256,
    url: `/helper/${encodeURIComponent(meta.file)}`,
  });
});

apiApp.get('/helper/download', async (c) => {
  const meta = await helperMeta();
  if (!meta) return c.json({ error: 'helper_not_published' }, 404);
  return c.redirect(`/helper/${encodeURIComponent(meta.file)}`, 302);
});

// Public: viewers are anonymous, so ICE config is not gated by a session.
// A room's host-provided TURN, when configured, overrides the global fallback.
apiApp.get('/ice-servers', (c) => {
  const roomId = c.req.query('roomId');
  let servers = iceServers();
  let turnConfigured = !!config.turn;

  if (roomId) {
    const roomTurn = getRoomTurn(roomId);
    if (roomTurn) {
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

// ---------------------------------------------------------------------------
// Helper presence + control relay (host-only; the helper is the room host)
// ---------------------------------------------------------------------------

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