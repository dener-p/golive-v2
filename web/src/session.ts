import type { PublicUser } from '@golive/shared';
import { api } from './api';

let user: PublicUser | null | undefined; // undefined = not loaded yet

/** Load (and cache) the session user. Returns null when signed out. */
export async function ensureUser(): Promise<PublicUser | null> {
  if (user !== undefined) return user;
  try {
    user = (await api.me()).user;
  } catch {
    user = null;
  }
  return user;
}

export function currentUser(): PublicUser | null {
  return user ?? null;
}

export function setUser(u: PublicUser | null): void {
  user = u;
}

/** Drop the cache and re-read the session (e.g. after login/logout). */
export async function refreshUser(): Promise<PublicUser | null> {
  user = undefined;
  return ensureUser();
}

export async function devLogin(): Promise<PublicUser | null> {
  const res = await api.devLogin();
  setUser(res.user);
  return res.user;
}