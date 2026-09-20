/**
 * Connection diagnostics for the browser host/viewer pages (M0).
 *
 * Samples RTCPeerConnection.getStats() every ~2s and reduces the report to the
 * numbers the UI cares about: ICE state, selected candidate type
 * (host/srflx = direct, relay = relayed), RTT, packet loss, bitrate, FPS, resolution.
 */

export type CandidateKind = 'host' | 'srflx' | 'relay' | 'prflx' | 'unknown';

export type PathKind = 'direct' | 'relayed' | null;

export interface PeerStatsSnapshot {
  connectionState: RTCPeerConnectionState;
  /** Local candidate type of the selected pair; null until a pair is selected. */
  candidateType: CandidateKind | null;
  /** 'direct' (host/srflx/prflx) vs 'relayed' (relay); null until known. */
  path: PathKind;
  rttMs: number | null;
  packetsLost: number | null;
  jitterMs: number | null;
  bitrateKbps: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
}

/** Carry-over state for byte-delta bitrate sampling. */
export interface StatsState {
  key: string;
  bytes: number;
  ts: number;
}

export function classifyCandidateType(type: string | undefined): CandidateKind {
  switch (type) {
    case 'host':
    case 'srflx':
    case 'relay':
    case 'prflx':
      return type;
    default:
      return 'unknown';
  }
}

/** Relay always means a TURN path; everything else is a direct peer path. */
export function pathFor(type: CandidateKind | null): PathKind {
  if (!type || type === 'unknown') return null;
  return type === 'relay' ? 'relayed' : 'direct';
}

export function pathLabel(path: PathKind): string {
  return path === 'relayed' ? 'relayed' : path === 'direct' ? 'direct' : '—';
}

/**
 * Reduce a RTCStatsReport to a PeerStatsSnapshot.
 *
 * @param pc  the peer connection (used for connectionState)
 * @param prev  previous sample state for bitrate; pass the returned state back in.
 */
export async function samplePeerStats(
  pc: RTCPeerConnection,
  prev?: StatsState,
): Promise<{ snapshot: PeerStatsSnapshot; state: StatsState }> {
  const report = await pc.getStats();
  const now = Date.now();

  let snapshot: PeerStatsSnapshot = {
    connectionState: pc.connectionState,
    candidateType: null,
    path: null,
    rttMs: null,
    packetsLost: null,
    jitterMs: null,
    bitrateKbps: null,
    fps: null,
    width: null,
    height: null,
  };

  const entries = [...report.values()];

  // --- selected candidate pair → candidate type + RTT ----------------------
  const transport = entries.find((s) => s.type === 'transport') as RTCTransportStats | undefined;
  const pairId = transport?.selectedCandidatePairId;
  const pair = pairId
    ? (report.get(pairId) as RTCIceCandidatePairStats | undefined)
    : entries
        .filter((s) => s.type === 'candidate-pair')
        .find(
          (s) =>
            (s as RTCIceCandidatePairStats).nominated &&
            (s as RTCIceCandidatePairStats).state === 'succeeded',
        );
  if (pair) {
    const local = report.get((pair as RTCIceCandidatePairStats).localCandidateId) as
      | { candidateType?: string }
      | undefined;
    if (local) {
      snapshot.candidateType = classifyCandidateType(local.candidateType);
      snapshot.path = pathFor(snapshot.candidateType);
    }
    const rtt = (pair as RTCIceCandidatePairStats).currentRoundTripTime;
    if (typeof rtt === 'number' && rtt >= 0) snapshot.rttMs = Math.round(rtt * 1000);
  }

  // --- RTP stats (video) ---------------------------------------------------
  const rtp = entries
    .filter((s) => s.type === 'inbound-rtp' || s.type === 'outbound-rtp')
    .filter((s) => (s as RTCRtpStreamStats).kind === 'video')
    .sort((a, b) => {
      const ba = (a as (typeof a) & { bytesReceived?: number; bytesSent?: number }).bytesReceived ?? (a as any).bytesSent ?? 0;
      const bb = (b as (typeof b) & { bytesReceived?: number; bytesSent?: number }).bytesReceived ?? (b as any).bytesSent ?? 0;
      return bb - ba;
    })[0] as
    | (RTCRtpStreamStats & { bytesReceived?: number; bytesSent?: number; framesPerSecond?: number; frameWidth?: number; frameHeight?: number; packetsLost?: number; jitter?: number; ssrc?: number })
    | undefined;

  if (rtp) {
    const isInbound = rtp.type === 'inbound-rtp';
    const bytes = isInbound ? (rtp.bytesReceived ?? 0) : (rtp.bytesSent ?? 0);
    const key = String(rtp.ssrc);
    if (prev && prev.key === key && bytes >= prev.bytes) {
      const dt = now - prev.ts;
      if (dt > 0) {
        snapshot.bitrateKbps = Math.round(((bytes - prev.bytes) * 8) / dt); // bits per ms → kbps
      }
    }

    if (isInbound) {
      snapshot.packetsLost = rtp.packetsLost ?? null;
      if (typeof rtp.jitter === 'number') snapshot.jitterMs = Math.round(rtp.jitter * 1000);
    } else {
      const ssrc = rtp.ssrc;
      const remote = entries.find(
        (s) => s.type === 'remote-inbound-rtp' && (s as any).ssrc === ssrc,
      ) as any;
      if (remote) {
        snapshot.packetsLost = remote.packetsLost ?? null;
        if (typeof remote.roundTripTime === 'number') snapshot.rttMs ??= Math.round(remote.roundTripTime * 1000);
        if (typeof remote.jitter === 'number') snapshot.jitterMs = Math.round(remote.jitter * 1000);
      }
    }
    snapshot.fps = rtp.framesPerSecond ?? null;
    snapshot.width = rtp.frameWidth ?? null;
    snapshot.height = rtp.frameHeight ?? null;
  }

  const state: StatsState = { key: '', bytes: 0, ts: now };
  if (rtp) {
    state.key = String(rtp.ssrc);
    state.bytes = rtp.type === 'inbound-rtp' ? (rtp.bytesReceived ?? 0) : (rtp.bytesSent ?? 0);
  }
  return { snapshot, state };
}

/** Single-line summary used by the host page test-broadcast card. */
export function summarizeStats(snapshot: PeerStatsSnapshot): string {
  const parts: string[] = [];
  const path = pathLabel(snapshot.path);
  const rtt = snapshot.rttMs != null ? `${snapshot.rttMs}ms` : '—';
  const loss = snapshot.packetsLost != null ? `${snapshot.packetsLost} pkts` : '—';
  const br = snapshot.bitrateKbps != null ? `${formatKbps(snapshot.bitrateKbps)}` : '—';
  const fps = snapshot.fps != null ? `${snapshot.fps}fps` : '—';
  const res =
    snapshot.width && snapshot.height ? `${snapshot.width}×${snapshot.height}` : '—';
  parts.push(`${path} · ${rtt} · loss ${loss} · ${br} · ${fps} · ${res}`);
  return parts.join(' ');
}

export function formatKbps(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}