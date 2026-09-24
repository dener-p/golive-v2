import { beforeEach, describe, expect, test } from 'bun:test';
import './setup';
import type { PublicUser } from '@golive/shared';
import {
  consumePairingCode,
  createPairingCode,
  helperTokensFor,
  issueHelperToken,
  MAX_HELPER_TOKENS_PER_USER,
  resetTokensForTests,
  revokeBearerToken,
  revokeHelperToken,
  userForHelperToken,
} from '../src/tokens';

const USER: PublicUser = { id: 'u1', username: 'Dev', avatar: null };

beforeEach(() => resetTokensForTests());

describe('pairing codes', () => {
  test('mints unique, single-use codes bound to the user', () => {
    const a = createPairingCode(USER);
    const b = createPairingCode(USER);
    expect(a.code).not.toBe(b.code);
    expect(a.expiresInSeconds).toBeGreaterThan(0);

    const consumed = consumePairingCode(a.code);
    expect(consumed?.id).toBe('u1');
    // Second attempt must fail — codes are single-use.
    expect(consumePairingCode(a.code)).toBeNull();
    // Unrelated code untouched.
    expect(consumePairingCode(b.code)?.id).toBe('u1');
  });

  test('accepts codes with surrounding whitespace / lowercase', () => {
    const { code } = createPairingCode(USER);
    expect(consumePairingCode(`  ${code.toLowerCase()}  `)?.id).toBe('u1');
  });

  test('rejects unknown codes', () => {
    expect(consumePairingCode('ZZZZZZ')).toBeNull();
  });

  test('expired codes are rejected', () => {
    const { code } = createPairingCode(USER);
    // Redeem with a "now" past the code's expiry.
    expect(consumePairingCode(code, Date.now() + 6 * 60_000)).toBeNull();
  });
});

describe('helper tokens', () => {
  test('issues a token resolvable back to the user; raw token never stored', () => {
    const issued = issueHelperToken(USER, 'laptop');
    expect(issued).not.toBeNull();
    const { token, id } = issued!;
    expect(token.length).toBeGreaterThan(30);
    expect(token).not.toContain(id);

    expect(userForHelperToken(token)?.id).toBe('u1');
    expect(userForHelperToken(`Bearer ${token}`)?.id).toBe('u1');
    expect(userForHelperToken('nope')).toBeNull();
    expect(userForHelperToken(null)).toBeNull();
  });

  test('lists and revokes devices per user', () => {
    const host2: PublicUser = { id: 'u2', username: 'Other', avatar: null };
    const mine = issueHelperToken(USER, 'desk')!;
    issueHelperToken(host2, 'someone-else');

    const mineList = helperTokensFor('u1');
    expect(mineList).toHaveLength(1);
    expect(mineList[0].deviceName).toBe('desk');
    expect(helperTokensFor('u2')).toHaveLength(1);

    expect(revokeHelperToken('u1', mine.id)).toBe(true);
    expect(revokeHelperToken('u1', mine.id)).toBe(false);
    expect(userForHelperToken(mine.token)).toBeNull();
  });

  test('cannot revoke another user device by id', () => {
    const mine = issueHelperToken(USER, 'a')!;
    expect(revokeHelperToken('someone-else', mine.id)).toBe(false);
    expect(userForHelperToken(mine.token)?.id).toBe('u1');
  });

  test('revokeBearerToken removes the presented token', () => {
    const issued = issueHelperToken(USER, 'x')!;
    expect(revokeBearerToken(`Bearer ${issued.token}`)).toBe(true);
    expect(userForHelperToken(issued.token)).toBeNull();
    expect(revokeBearerToken('Bearer garbage')).toBe(false);
    expect(revokeBearerToken(undefined)).toBe(false);
  });

  test('enforces the per-user device cap', () => {
    for (let i = 0; i < MAX_HELPER_TOKENS_PER_USER; i++) {
      expect(issueHelperToken(USER, `d${i}`)).not.toBeNull();
    }
    expect(issueHelperToken(USER, 'overflow')).toBeNull();
  });
});