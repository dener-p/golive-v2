import type { IceServerInfo } from '@golive/shared';

export interface Config {
  port: number;
  baseUrl: string;
  sessionSecret: string;
  discordClientId?: string;
  discordClientSecret?: string;
  stunServers: string[];
  turn: { urls: string[]; username: string; credential: string } | null;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const port = Number(process.env.PORT ?? 3000);
const baseUrl = (process.env.BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');

export const config: Config = {
  port,
  baseUrl,
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',
  discordClientId: process.env.DISCORD_CLIENT_ID?.trim() || undefined,
  discordClientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() || undefined,
  stunServers: splitList(
    process.env.STUN_SERVERS ??
      'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun.cloudflare.com:3478',
  ),
  turn: process.env.TURN_URLS
    ? {
        urls: splitList(process.env.TURN_URLS),
        username: process.env.TURN_USERNAME ?? '',
        credential: process.env.TURN_CREDENTIAL ?? '',
      }
    : null,
};

/** True when Discord OAuth is not configured → instant dev-auth mode. */
export const isDevAuth = !config.discordClientId || !config.discordClientSecret;

/** ICE servers handed to browsers (`RTCIceServer[]`). */
export function iceServers(): IceServerInfo[] {
  const servers: IceServerInfo[] = config.stunServers.map((url) => ({ urls: url }));
  if (config.turn) {
    servers.push({
      urls: config.turn.urls,
      username: config.turn.username,
      credential: config.turn.credential,
    });
  }
  return servers;
}
