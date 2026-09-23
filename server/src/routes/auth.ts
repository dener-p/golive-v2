import { Hono } from 'hono';
import { setCookie, deleteCookie, getCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import { createSession, destroySession } from '../sessions';
import { requireUser } from '../http';
import { config, isDevAuth } from '../config';
import { rateLimit } from '../rateLimit';
import { DEV_USER, discordAuthorizeUrl, exchangeCodeForToken, fetchDiscordUser } from '../discord';

export const authApp = new Hono();

const SESSION_COOKIE = 'session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
}

// --- Login ---------------------------------------------------------------

authApp.post(
  '/login',
  rateLimit({ scope: 'auth:login', limit: 20, windowMs: 60_000 }),
  (c) => {
    if (isDevAuth) {
      setSessionCookie(c, createSession(DEV_USER));
      return c.json({ user: DEV_USER, dev: true });
    }
    const state = randomBytes(16).toString('hex');
    setCookie(c, 'oauth_state', state, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });
    return c.redirect(discordAuthorizeUrl(state));
  },
);

authApp.post(
  '/dev',
  rateLimit({ scope: 'auth:dev', limit: 20, windowMs: 60_000 }),
  (c) => {
    if (!isDevAuth) return c.json({ error: 'dev_auth_disabled' }, 403);
    setSessionCookie(c, createSession(DEV_USER));
    return c.json({ user: DEV_USER });
  },
);

// --- OAuth callback ------------------------------------------------------

authApp.get('/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const expected = getCookie(c, 'oauth_state');

  if (!code || !state || !expected || state !== expected) {
    return c.text('OAuth state mismatch. Try logging in again.', 400);
  }
  deleteCookie(c, 'oauth_state', { path: '/' });

  try {
    const accessToken = await exchangeCodeForToken(code);
    const user = await fetchDiscordUser(accessToken);
    setSessionCookie(c, createSession(user));
    return c.redirect(`${config.baseUrl}/#/host`);
  } catch (err) {
    console.error('[auth] OAuth callback failed:', err);
    return c.text('Login failed. Please try again.', 500);
  }
});

// --- Session -------------------------------------------------------------

authApp.get('/me', (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ user });
});

authApp.post('/logout', (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) destroySession(token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});