import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { PublicUser } from '@golive/shared';
import { db } from './db/client';
import { sessionTable } from './db/schema';

/**
 * Browser sessions — persisted in SQLite (Turso in production), mirrored
 * in-memory for synchronous auth paths (cookie parsing in WS upgrades, routes).
 * Expired sessions are rejected and cleaned up on read.
 */

interface Session {
  token: string;
  user: PublicUser;
  createdAt: number;
  expiresAt: number;
}

/** Same lifetime the cookie advertises (30 days), enforced server-side too. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sessions = new Map<string, Session>();

/** Rebuild the in-memory mirror from the database (startup). */
export async function loadSessions(): Promise<void> {
  const rows = await db.select().from(sessionTable).all();
  sessions.clear();
  for (const row of rows) {
    sessions.set(row.token, {
      token: row.token,
      user: {
        id: row.userId,
        username: row.username,
        avatar: row.avatar,
      },
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    });
  }
}

export function createSession(user: PublicUser, now = Date.now()): string {
  const token = randomBytes(24).toString('base64url');
  const session: Session = {
    token,
    user,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(token, session);
  void db
    .insert(sessionTable)
    .values({
      token,
      userId: user.id,
      username: user.username,
      avatar: user.avatar,
      createdAt: now,
      expiresAt: session.expiresAt,
    })
    .onConflictDoNothing()
    .catch((err) => console.error('[golive] session persist failed:', err));
  return token;
}

export function getSession(token: string | undefined | null, now = Date.now()): Session | null {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= now) {
    sessions.delete(token);
    void db
      .delete(sessionTable)
      .where(eq(sessionTable.token, token))
      .catch((err) => console.error('[golive] session expiry delete failed:', err));
    return null;
  }
  return session;
}

export function getUser(token: string | undefined | null): PublicUser | null {
  return getSession(token)?.user ?? null;
}

export function destroySession(token: string): void {
  sessions.delete(token);
  void db
    .delete(sessionTable)
    .where(eq(sessionTable.token, token))
    .catch((err) => console.error('[golive] session delete failed:', err));
}