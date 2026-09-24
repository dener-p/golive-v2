import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { PublicUser } from '@golive/shared';
import { db } from './db/client';
import { helperTokenTable } from './db/schema';

/**
 * Helper pairing + long-lived device tokens.
 *
 * The native helper cannot hold a browser `session` cookie, so it authenticates
 * with a bearer token it stores locally. Flow:
 *   1. A signed-in host mints a short-lived pairing code (`POST /api/pair`).
 *   2. The helper exchanges it once (`POST /api/pair/exchange`) for a long-lived
 *      random token. Only the SHA-256 of the token is stored.
 *   3. The helper sends `Authorization: Bearer <token>` on every `/ws/helper`
 *      connection until the host revokes it (or the helper unpairs).
 *
 * Pairing codes stay ephemeral (in-memory, 5-min single-use). Helper tokens are
 * persisted in SQLite (Turso in production) so a backend restart does not
 * invalidate every friend's already-paired helper.
 */

/** How long a pairing code stays valid. */
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
/** Upper bound on devices per host, so a stale token list can't grow unbounded. */
export const MAX_HELPER_TOKENS_PER_USER = 12;

/** No ambiguous I/O/0/1 — codes are typed by hand from the host page. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

interface PairingCodeEntry {
  userId: string;
  user: PublicUser;
  expiresAt: number;
}

export interface HelperTokenRecord {
  id: string;
  userId: string;
  user: PublicUser;
  deviceName: string;
  createdAt: number;
}

interface StoredToken extends HelperTokenRecord {
  tokenHash: string;
}

const pairingCodes = new Map<string, PairingCodeEntry>();
/** Key: sha256(raw token). In-memory mirror of `helperTokenTable`. */
const helperTokens = new Map<string, StoredToken>();

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Rebuild the in-memory mirror from the database (startup). */
export async function loadHelperTokens(): Promise<void> {
  const rows = await db.select().from(helperTokenTable).all();
  helperTokens.clear();
  for (const row of rows) {
    helperTokens.set(row.tokenHash, {
      tokenHash: row.tokenHash,
      id: row.id,
      userId: row.userId,
      user: { id: row.userId, username: row.username, avatar: row.avatar },
      deviceName: row.deviceName,
      createdAt: row.createdAt,
    });
  }
}

// --- pairing codes ---------------------------------------------------------

/** Mint a short-lived, single-use pairing code for a signed-in user. */
export function createPairingCode(user: PublicUser, now = Date.now()): {
  code: string;
  expiresInSeconds: number;
} {
  const code = Array.from(
    { length: 6 },
    () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
  ).join('');
  pairingCodes.set(hash(code), { userId: user.id, user, expiresAt: now + PAIRING_CODE_TTL_MS });
  return { code, expiresInSeconds: Math.round(PAIRING_CODE_TTL_MS / 1000) };
}

/** Redeem a pairing code. Consumed on first attempt regardless of outcome. */
export function consumePairingCode(code: string, now = Date.now()): PublicUser | null {
  const key = hash(code.trim().toUpperCase());
  const entry = pairingCodes.get(key);
  if (!entry) return null;
  pairingCodes.delete(key);
  if (entry.expiresAt <= now) return null;
  return entry.user;
}

// --- long-lived tokens -----------------------------------------------------

/**
 * Issue a long-lived helper token for a user. Returns `null` when the account
 * is at the per-user device cap (the host should revoke an old device first).
 */
export function issueHelperToken(
  user: PublicUser,
  deviceName?: string,
): { id: string; token: string } | null {
  if (helperTokensFor(user.id).length >= MAX_HELPER_TOKENS_PER_USER) return null;
  const token = randomBytes(32).toString('base64url');
  const id = randomBytes(6).toString('hex');
  const record: StoredToken = {
    tokenHash: hash(token),
    id,
    userId: user.id,
    user,
    deviceName: deviceName?.trim().slice(0, 64) ?? '',
    createdAt: Date.now(),
  };
  helperTokens.set(record.tokenHash, record);
  void db
    .insert(helperTokenTable)
    .values({
      tokenHash: record.tokenHash,
      id,
      userId: user.id,
      username: user.username,
      avatar: user.avatar,
      deviceName: record.deviceName,
      createdAt: record.createdAt,
    })
    .catch((err) => console.error('[golive] helper token persist failed:', err));
  return { id, token };
}

/** Resolve the user behind a raw/`Bearer `-prefixed token, or null. */
export function userForHelperToken(token: string | null | undefined): PublicUser | null {
  if (!token) return null;
  const value = token.trim().replace(/^Bearer\s+/i, '');
  if (!value) return null;
  return helperTokens.get(hash(value))?.user ?? null;
}

/** Revoke a token given the raw `Authorization` header value (helper "unpair"). */
export function revokeBearerToken(authorization: string | null | undefined): boolean {
  if (!authorization) return false;
  const value = authorization.trim().replace(/^Bearer\s+/i, '');
  if (!value) return false;
  const key = hash(value);
  const had = helperTokens.delete(key);
  if (had) {
    void db
      .delete(helperTokenTable)
      .where(eq(helperTokenTable.tokenHash, key))
      .catch((err) => console.error('[golive] helper token revoke failed:', err));
  }
  return had;
}

// --- device management (host UI) ------------------------------------------

export function helperTokensFor(userId: string): HelperTokenRecord[] {
  return [...helperTokens.values()].filter((t) => t.userId === userId);
}

export function revokeHelperToken(userId: string, id: string): boolean {
  for (const [key, record] of helperTokens) {
    if (record.id === id && record.userId === userId) {
      helperTokens.delete(key);
      void db
        .delete(helperTokenTable)
        .where(and(eq(helperTokenTable.id, id), eq(helperTokenTable.userId, userId)))
        .catch((err) => console.error('[golive] helper token revoke failed:', err));
      return true;
    }
  }
  return false;
}

/** Test hook: clear all pairing state between tests. */
export function resetTokensForTests(): void {
  pairingCodes.clear();
  helperTokens.clear();
  void db.delete(helperTokenTable);
}