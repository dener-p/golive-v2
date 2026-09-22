import type { HelperStatus, IceServersResponse, PublicUser, RoomInfo, TurnConfigRequest } from '@golive/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  if (res.status === 401) throw new ApiError('unauthorized', 401);
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body?.error === 'string') message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

export interface MetaInfo {
  name: string;
  auth: 'dev' | 'discord';
  /** API origin — used to build the `golive-helper.exe pair <base> <code>` command. */
  baseUrl: string;
}

export interface PairedDevice {
  id: string;
  deviceName: string;
  createdAt: string;
}

export interface PairCodeResponse {
  code: string;
  expiresInSeconds: number;
}

export interface HelperCommandResult {
  delivered: boolean;
  reason?: string;
  /** Command id; the helper echoes it in its ack (surfaced via helper status). */
  id?: string;
}

export interface HelperLatest {
  available: boolean;
  version?: string;
  file?: string;
  sha256?: string;
  url?: string;
}

export const api = {
  meta(): Promise<MetaInfo> {
    return request('/api/meta');
  },
  me(): Promise<{ user: PublicUser }> {
    return request('/auth/me');
  },
  devLogin(): Promise<{ user: PublicUser }> {
    return request('/auth/dev', { method: 'POST' });
  },
  logout(): Promise<{ ok: boolean }> {
    return request('/auth/logout', { method: 'POST' });
  },
  createRoom(): Promise<{ room: RoomInfo }> {
    return request('/api/rooms', { method: 'POST' });
  },
  getRoom(roomId: string): Promise<{ room: RoomInfo }> {
    return request(`/api/rooms/${encodeURIComponent(roomId)}`);
  },
  helperStatus(): Promise<{ status: HelperStatus }> {
    return request('/api/helper/status');
  },
  helperLatest(): Promise<HelperLatest> {
    return request('/api/helper/latest');
  },
  /** Mint a short-lived pairing code for the (signed-in) caller. */
  pairCode(): Promise<PairCodeResponse> {
    return request('/api/pair', { method: 'POST' });
  },
  pairedDevices(): Promise<{ tokens: PairedDevice[] }> {
    return request('/api/pair/tokens');
  },
  revokeDevice(deviceId: string): Promise<{ ok: boolean }> {
    return request(`/api/pair/tokens/${deviceId}`, { method: 'DELETE' });
  },
  helperCommand(command: string, payload?: unknown): Promise<HelperCommandResult> {
    return request('/api/helper/command', {
      method: 'POST',
      body: JSON.stringify({ command, payload }),
    });
  },
  iceServers(roomId?: string): Promise<IceServersResponse> {
    const params = roomId ? `?roomId=${encodeURIComponent(roomId)}` : '';
    return request(`/api/ice-servers${params}`);
  },
  setTurnConfig(roomId: string, config: TurnConfigRequest | null): Promise<{ ok: boolean; turnConfigured: boolean }> {
    return request(`/api/rooms/${encodeURIComponent(roomId)}/turn`, {
      method: 'POST',
      body: JSON.stringify(config),
    });
  },
};
