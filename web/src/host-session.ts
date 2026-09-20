import type { IceCandidateMessage, ServerSignal } from '@golive/shared';
import { connectSignaling, type SignalingClient } from './signaling';
import { samplePeerStats, summarizeStats, type StatsState } from './stats';
import {
  AV1_FIRST,
  createPeer,
  flushCandidateQueue,
  iceConfig,
  preferCodecs,
  queueCandidate,
} from './webrtc';
import { createTestVideoStream, getDisplayStream } from './testStream';

export type StatusFn = (text: string, kind: 'ok' | 'error' | 'muted') => void;

/**
 * Browser-emulated host: opens N peer connections from a single stream — one
 * per viewer, keyed by the viewer's signaling peerId — mirroring the native
 * helper's "tee one encode into N connections" design. Proves the relay.
 */
export class TestHost {
  roomId: string | null = null;
  client: SignalingClient | null = null;
  stream: MediaStream | null = null;
  private peers = new Map<string, RTCPeerConnection>();
  private iceQueues = new Map<string, IceCandidateMessage[]>();
  private statsStates = new Map<string, StatsState>();
  private peerId = crypto.randomUUID();
  running = false;

  constructor(private onUpdate: StatusFn) {}

  get viewerCount(): number {
    return this.peers.size;
  }

  /**
   * Choose the source. `screen` uses getDisplayMedia when available; otherwise
   * falls back to the animated canvas demo stream.
   */
  async pickSource(screen: boolean): Promise<void> {
    if (this.running) return;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (screen) {
      const display = await getDisplayStream();
      if (!display) {
        this.onUpdate('Screen share was dismissed — keeping canvas test signal.', 'muted');
        return;
      }
      this.stream = display;
      this.onUpdate('Screen share source selected — press start to broadcast.', 'muted');
    } else {
      this.stream = createTestVideoStream();
      this.onUpdate('Canvas test signal selected (1280×720, AV1-first).', 'muted');
    }
  }

  async start(roomId: string): Promise<void> {
    if (this.running) return;
    this.roomId = roomId;
    if (!this.stream) {
      this.stream = createTestVideoStream();
    }

    this.running = true;
    this.onUpdate('connecting to signaling as host…', 'muted');

    this.client = connectSignaling({
      roomId,
      role: 'host',
      peerId: this.peerId,
      onMessage: (m) => this.handleMessage(m),
      onClose: () => {
        if (this.running) {
          this.stop();
          this.onUpdate('signaling connection closed', 'muted');
        }
      },
    });
  }

  stop(): void {
    for (const pc of this.peers.values()) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    this.peers.clear();
    this.iceQueues.clear();
    this.statsStates.clear();
    this.client?.close();
    this.client = null;
    this.running = false;
    this.onUpdate('test broadcast stopped', 'muted');
  }

  cleanup(): void {
    this.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private handleMessage(m: ServerSignal): void {
    switch (m.type) {
      case 'joined':
        this.onUpdate(
          `host joined room (${m.viewerCount} viewer${m.viewerCount === 1 ? '' : 's'} waiting).`,
          'ok',
        );
        for (const viewerId of m.viewers ?? []) void this.connectViewer(viewerId);
        break;
      case 'peer-joined':
        if (m.role === 'viewer') void this.connectViewer(m.peerId);
        break;
      case 'peer-left':
        if (m.role === 'viewer') this.dropViewer(m.peerId);
        break;
      case 'sdp':
        if (m.from === 'viewer' && m.sdp.type === 'answer') {
          void this.handleAnswer(m.peerId, m.sdp);
        }
        break;
      case 'ice':
        if (m.from === 'viewer') {
          const pc = this.peers.get(m.peerId);
          if (pc) queueCandidate(pc, this.iceQueues.get(m.peerId) ?? [], m.candidate);
        }
        break;
      case 'error':
        this.onUpdate(`${m.code}: ${m.message}`, 'error');
        this.client?.close();
        this.client = null;
        this.running = false;
        break;
    }
  }

  private async connectViewer(viewerId: string): Promise<void> {
    if (this.peers.has(viewerId)) return;
    if (!this.stream) return;

    try {
      const config = await iceConfig();
      const pc = createPeer(config, {
        onIceCandidate: (candidate) => {
          if (!this.roomId) return;
          this.client?.send({ type: 'ice', roomId: this.roomId, candidate });
        },
        onTrack: () => {
          /* host direction only */
        },
        onStateChange: (state) => {
          if (state === 'failed' || state === 'disconnected') {
            this.onUpdate(`viewer link ${state}`, 'error');
          }
        },
      });

      this.peers.set(viewerId, pc);
      this.iceQueues.set(viewerId, []);

      for (const track of this.stream.getTracks()) {
        pc.addTrack(track, this.stream);
      }
      preferCodecs(pc, 'video', AV1_FIRST);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (pc.localDescription && this.roomId) {
        this.client?.send({
          type: 'sdp',
          roomId: this.roomId,
          sdp: { type: pc.localDescription.type as 'offer', sdp: pc.localDescription.sdp },
          target: viewerId,
        });
      }
      this.onUpdate(this.describe(), 'ok');
    } catch (err) {
      this.onUpdate(`failed to open viewer link: ${err instanceof Error ? err.message : err}`, 'error');
      this.dropViewer(viewerId);
    }
  }

  private async handleAnswer(viewerId: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    const pc = this.peers.get(viewerId);
    if (!pc) return;
    try {
      await pc.setRemoteDescription(sdp);
      flushCandidateQueue(pc, this.iceQueues.get(viewerId) ?? []);
    } catch (err) {
      this.onUpdate(`answer failed: ${err instanceof Error ? err.message : err}`, 'error');
    }
  }

  private dropViewer(viewerId: string): void {
    const pc = this.peers.get(viewerId);
    if (pc) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    this.peers.delete(viewerId);
    this.iceQueues.delete(viewerId);
    if (this.running) this.onUpdate(this.describe(), 'ok');
  }

  private describe(): string {
    const n = this.viewerCount;
    return `${n} viewer connection${n === 1 ? '' : 's'} from one source.`;
  }

  /** Diagnostics line per connected viewer (path, RTT, loss, bitrate, fps, res). */
  async diagnostics(): Promise<string[]> {
    const lines: string[] = [];
    for (const [viewerId, pc] of this.peers) {
      if (pc.connectionState !== 'connected') continue;
      try {
        const { snapshot, state } = await samplePeerStats(pc, this.statsStates.get(viewerId));
        this.statsStates.set(viewerId, state);
        lines.push(`viewer ${viewerId.slice(0, 8)}: ${summarizeStats(snapshot)}`);
      } catch {
        /* transient */
      }
    }
    return lines;
  }
}