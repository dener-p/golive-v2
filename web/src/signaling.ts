import type { ClientSignal, Role, ServerSignal } from '@golive/shared';

export interface SignalingClient {
  send(msg: ClientSignal): void;
  close(): void;
}

export interface SignalingOptions {
  roomId: string;
  role: Role;
  peerId: string;
  onOpen?: () => void;
  onMessage: (msg: ServerSignal) => void;
  onClose?: (code: number, reason: string) => void;
}

/**
 * Connect to the room signaling channel.
 * The host must join as `host` with the session's account; the joined `peerId`
 * returned by the server is the authoritative address for this connection.
 */
export function connectSignaling(opts: SignalingOptions): SignalingClient {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

  ws.onopen = () => {
    opts.onOpen?.();
    const join: ClientSignal = { type: 'join', roomId: opts.roomId, role: opts.role, peerId: opts.peerId };
    ws.send(JSON.stringify(join));
  };
  ws.onmessage = (evt: MessageEvent<string>) => {
    let msg: ServerSignal;
    try {
      msg = JSON.parse(evt.data) as ServerSignal;
    } catch {
      return;
    }
    opts.onMessage(msg);
  };
  ws.onclose = (evt) => opts.onClose?.(evt.code, evt.reason);

  const client: SignalingClient = {
    send: (msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close: () => {
      try {
        client.send({ type: 'leave' });
      } finally {
        ws.close();
      }
    },
  };
  return client;
}