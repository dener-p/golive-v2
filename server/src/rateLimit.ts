/**
 * Minimal per-IP fixed-window rate limiter (in-memory, single process — same
 * trade-off as sessions.ts). Applied to the sensitive write paths: auth,
 * room creation and helper pairing. Disable globally with `RATE_LIMITS=off`.
 *
 * Expired buckets are pruned lazily when the map grows, so memory stays
 * bounded without a timer.
 */

import type { Context, Next } from 'hono';
import { config } from './config';

export interface RateLimitOptions {
  /** Scope name — distinct endpoints share nothing. */
  scope: string;
  /** Max requests per window from one IP. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const PRUNE_AT = 4_096;

/**
 * Best-effort client IP: trust the forwarding headers when a proxy
 * (cloudflared) is in front, otherwise ask Bun for the socket address.
 * Falls back to a shared `unknown` bucket when neither is available
 * (plain local HTTP) — still enforces a per-host cap.
 */
export function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim() || 'unknown';
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return cf.trim();
  const env = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
  const ip = env?.requestIP?.(c.req.raw);
  if (ip?.address) return ip.address;
  return 'unknown';
}

/** Core fixed-window logic, injectable for tests. */
export function take(
  ip: string,
  opts: RateLimitOptions,
  now = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  const key = `${ip}|${opts.scope}`;
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + opts.windowMs };
    buckets.set(key, bucket);
    if (buckets.size > PRUNE_AT) pruneExpired(now);
  }
  bucket.count += 1;
  if (bucket.count > opts.limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

function pruneExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/** Hono middleware (per-route). */
export function rateLimit(opts: RateLimitOptions) {
  return async (c: Context, next: Next) => {
    if (!config.rateLimitsEnabled) {
      await next();
      return;
    }
    const { allowed, retryAfterSeconds } = take(clientIp(c), opts);
    if (!allowed) {
      c.header('Retry-After', String(retryAfterSeconds));
      return c.json({ error: 'rate_limited', retryAfter: retryAfterSeconds }, 429);
    }
    await next();
  };
}

/** Test hook: clear all buckets. */
export function resetRateLimitsForTests(): void {
  buckets.clear();
}