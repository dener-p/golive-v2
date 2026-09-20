import { randomBytes } from 'node:crypto';
import type { PublicUser } from '@golive/shared';

interface Session {
  token: string;
  user: PublicUser;
  createdAt: number;
}

/** In-memory session store. Single process for now — see docs/milestones.md. */
const sessions = new Map<string, Session>();

export function createSession(user: PublicUser): string {
  const token = randomBytes(24).toString('base64url');
  sessions.set(token, { token, user, createdAt: Date.now() });
  return token;
}

export function getSession(token: string | undefined | null): Session | null {
  if (!token) return null;
  return sessions.get(token) ?? null;
}

export function getUser(token: string | undefined | null): PublicUser | null {
  return getSession(token)?.user ?? null;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}