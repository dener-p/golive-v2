import type { IceCandidateMessage, IceServersResponse } from '@golive/shared';
import { api } from './api';

/** Cache keyed by roomId (or 'global' for roomId-less fetches). */
const iceConfigCache = new Map<string, Promise<RTCConfiguration>>();

/** Fetch ICE servers from the backend (STUN always; TURN when configured). */
export function iceConfig(roomId?: string): Promise<RTCConfiguration> {
  const key = roomId ?? 'global';
  let cached = iceConfigCache.get(key);
  if (!cached) {
    cached = api.iceServers(roomId).then((res) => ({ iceServers: res.iceServers }));
    iceConfigCache.set(key, cached);
  }
  return cached;
}

/** Invalidate the ice-servers cache for a room (e.g. after TURN config changes). */
export function invalidateIceConfig(roomId?: string): void {
  iceConfigCache.delete(roomId ?? 'global');
}

export interface IceRetryConfig {
  /** Maximum number of ICE attempts (1 = no retry). Default: 2 */
  maxAttempts?: number;
  /** Delay in ms before retrying with TURN after STUN-only failure. Default: 2000 */
  retryDelayMs?: number;
  /** Called when an attempt fails and a retry is planned. */
  onRetryAttempt?: (attempt: number, reason: string) => void;
  /** Called when all attempts are exhausted. */
  onRetryExhausted?: (lastReason: string) => void;
}

/**
 * Create a peer connection with ICE retry logic.
 *
 * Flow:
 * 1. Try with the ice servers returned by the backend (STUN + optional TURN).
 * 2. If connection fails and turnConfigured is false, surface a clear error.
 * 3. If connection fails and TURN is available, retry with a fresh peer.
 */
export function createPeerWithRetry(
  baseConfig: RTCConfiguration,
  handlers: PeerHandlers,
  retryConfig?: IceRetryConfig,
  turnAvailable?: boolean,
): { pc: RTCPeerConnection; abort: () => void } {
  const maxAttempts = retryConfig?.maxAttempts ?? 2;
  const retryDelayMs = retryConfig?.retryDelayMs ?? 2000;
  let attempt = 0;
  let currentPc: RTCPeerConnection | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let aborted = false;

  const cleanup = (): void => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const createAttempt = (): RTCPeerConnection => {
    attempt++;
    const pc = createPeer(baseConfig, {
      onIceCandidate: handlers.onIceCandidate,
      onTrack: handlers.onTrack,
      onStateChange: (state) => {
        handlers.onStateChange(state);

        // Handle connection failure with retry logic
        if ((state === 'failed' || state === 'disconnected') && !aborted) {
          if (attempt < maxAttempts && turnAvailable) {
            retryConfig?.onRetryAttempt?.(attempt, `connection ${state}, retrying with TURN`);
            cleanup();
            retryTimer = setTimeout(() => {
              if (aborted) return;
              try {
                currentPc?.close();
              } catch {
                /* ignore */
              }
              currentPc = createAttempt();
              handlers.onRetryNewPeer?.(currentPc);
            }, retryDelayMs);
          } else if (state === 'failed') {
            if (!turnAvailable) {
              retryConfig?.onRetryExhausted?.(
                'Direct connection failed. The host needs to configure a TURN server for this network.',
              );
            } else {
              retryConfig?.onRetryExhausted?.(
                `Connection failed after ${attempt} attempt${attempt === 1 ? '' : 's'}.`,
              );
            }
          }
        }
      },
    });
    currentPc = pc;
    return pc;
  };

  const pc = createAttempt();

  return {
    pc,
    abort: () => {
      aborted = true;
      cleanup();
      try {
        currentPc?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/** Prefer codecs by MIME type (best-effort; only called before offer/answer). */
export function preferCodecs(
  pc: RTCPeerConnection,
  kind: 'audio' | 'video',
  preferred: string[],
): void {
  const sender = RTCRtpSender;
  if (typeof sender.getCapabilities !== 'function') return;
  const caps = sender.getCapabilities(kind);
  if (!caps) return;

  const wanted = preferred.map((m) => m.toLowerCase());
  const ordered = caps.codecs.filter((c) => wanted.includes(c.mimeType.toLowerCase()));
  const rest = caps.codecs.filter((c) => !wanted.includes(c.mimeType.toLowerCase()));
  const codecs = [...ordered, ...rest];

  for (const transceiver of pc.getTransceivers()) {
    // Use receiver.track.kind — sender.track is null on recvonly transceivers.
    const trackKind = transceiver.receiver.track.kind;
    if (trackKind === kind) {
      try {
        transceiver.setCodecPreferences(codecs);
      } catch {
        /* codec preferences unsupported — ignore */
      }
    }
  }
}

export const AV1_FIRST = ['video/AV1', 'video/VP9', 'video/VP8', 'video/H264'];

/** Pretty connection state label for the UI. */
export function connectionLabel(state: RTCPeerConnectionState | undefined): string {
  switch (state) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting…';
    case 'disconnected':
    case 'failed':
    case 'closed':
      return state;
    case 'new':
      return 'waiting for peer';
    default:
      return String(state ?? 'new');
  }
}

export interface PeerHandlers {
  onIceCandidate(candidate: IceCandidateMessage): void;
  onTrack(event: RTCTrackEvent): void;
  onStateChange(state: RTCPeerConnectionState): void;
  onRetryNewPeer?: (newPc: RTCPeerConnection) => void;
}

export function createPeer(config: RTCConfiguration, handlers: PeerHandlers): RTCPeerConnection {
  const pc = new RTCPeerConnection(config);

  pc.onicecandidate = (evt) => {
    if (evt.candidate) {
      handlers.onIceCandidate({
        candidate: evt.candidate.candidate,
        sdpMid: evt.candidate.sdpMid,
        sdpMLineIndex: evt.candidate.sdpMLineIndex,
        usernameFragment: evt.candidate.usernameFragment,
      });
    }
  };
  pc.ontrack = handlers.onTrack;
  pc.onconnectionstatechange = () => handlers.onStateChange(pc.connectionState);
  return pc;
}

/** Add events that arrive before the remote description is known. */
export function queueCandidate(
  pc: RTCPeerConnection,
  queue: IceCandidateMessage[],
  candidate: IceCandidateMessage,
): void {
  if (!pc.remoteDescription) {
    queue.push(candidate);
    return;
  }
  pc.addIceCandidate(candidate).catch((err) => console.warn('addIceCandidate failed', err));
}

export function flushCandidateQueue(pc: RTCPeerConnection, queue: IceCandidateMessage[]): void {
  for (const candidate of queue.splice(0)) {
    pc.addIceCandidate(candidate).catch((err) => console.warn('addIceCandidate failed', err));
  }
}
