import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { PublicUser } from '@golive/shared';
import { getUser } from './sessions';

/** User for the current request, from the `session` cookie. */
export function currentUser(c: Context): PublicUser | null {
  return getUser(getCookie(c, 'session'));
}

/** `currentUser` or null (routes decide 401 handling). */
export function requireUser(c: Context): PublicUser | null {
  return currentUser(c);
}

/** Parse a raw Cookie header into a map (used for WebSocket upgrades). */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

export function userFromCookieHeader(header: string | null | undefined): PublicUser | null {
  return getUser(parseCookies(header).session);
}