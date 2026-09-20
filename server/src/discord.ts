import type { PublicUser } from '@golive/shared';
import { config, isDevAuth } from './config';

/** Dev-mode identity used when Discord OAuth is not configured. */
export const DEV_USER: PublicUser = {
  id: 'dev-user',
  username: 'Dev User',
  avatar: null,
};

interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

interface DiscordUserResponse {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export function discordAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.discordClientId!,
    redirect_uri: `${config.baseUrl}/auth/callback`,
    response_type: 'code',
    scope: 'identify',
    state,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** Exchange the OAuth `code` for a Discord access token. */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.discordClientId!,
      client_secret: config.discordClientSecret!,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${config.baseUrl}/auth/callback`,
    }),
  });
  if (!res.ok) throw new Error(`Discord token exchange failed: HTTP ${res.status}`);
  const data = (await res.json()) as DiscordTokenResponse;
  return data.access_token;
}

/** Fetch the current user's public identity from Discord. */
export async function fetchDiscordUser(accessToken: string): Promise<PublicUser> {
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Discord user fetch failed: HTTP ${res.status}`);
  const u = (await res.json()) as DiscordUserResponse;
  return {
    id: u.id,
    username: u.global_name ?? u.username,
    avatar: u.avatar,
  };
}

export function devAuthEnabled(): boolean {
  return isDevAuth;
}