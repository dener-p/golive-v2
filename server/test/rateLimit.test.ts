import { beforeEach, describe, expect, test } from 'bun:test';
import { resetRateLimitsForTests, take, type RateLimitOptions } from '../src/rateLimit';

const OPTS: RateLimitOptions = { scope: 'test', limit: 3, windowMs: 60_000 };

beforeEach(() => resetRateLimitsForTests());

describe('rate limiter', () => {
  test('allows up to the limit, then blocks with a retry hint', () => {
    for (let i = 0; i < 3; i++) {
      expect(take('1.1.1.1', OPTS).allowed).toBe(true);
    }
    const blocked = take('1.1.1.1', OPTS);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  test('buckets are per IP and per scope', () => {
    expect(take('1.1.1.1', OPTS).allowed).toBe(true);
    expect(take('2.2.2.2', OPTS).allowed).toBe(true);
    expect(take('1.1.1.1', { ...OPTS, scope: 'other' }).allowed).toBe(true);

    // 1.1.1.1 has used 1 of 3 in the 'test' scope.
    expect(take('1.1.1.1', OPTS).allowed).toBe(true);
    expect(take('1.1.1.1', OPTS).allowed).toBe(true);
    expect(take('1.1.1.1', OPTS).allowed).toBe(false);
  });

  test('window resets after it expires', () => {
    const t0 = 1_700_000_000_000;
    take('1.1.1.1', OPTS, t0);
    take('1.1.1.1', OPTS, t0);
    take('1.1.1.1', OPTS, t0);
    expect(take('1.1.1.1', OPTS, t0).allowed).toBe(false);
    // Fresh window afterwards.
    expect(take('1.1.1.1', OPTS, t0 + OPTS.windowMs + 1).allowed).toBe(true);
  });

  test('different IPs are tracked independently under the same scope', () => {
    expect(take('203.0.113.5', OPTS).allowed).toBe(true);
    expect(take('203.0.113.5', OPTS).allowed).toBe(true);
    // A different IP is unaffected under the same scope+limit.
    expect(take('203.0.113.99', OPTS).allowed).toBe(true);
  });
});