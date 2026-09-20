import type { IceCandidateMessage } from '@golive/shared';
import { api } from './api';

let cachedIceConfig: Promise<RTCConfiguration> | null = null;

/** Fetch ICE servers from the backend (STUN now; TURN when configured / M2). */
export function iceConfig(): Promise<RTCConfiguration> {
  cachedIceConfig ??= api.iceServers().then((res) => ({ iceServers: res.iceServers }));
  return cachedIceConfig;
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
    if (transceiver.sender?.track?.kind === kind) {
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