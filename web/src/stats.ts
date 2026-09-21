/**
 * Connection diagnostics for the browser host/viewer pages (M0).
 *
 * Samples RTCPeerConnection.getStats() every ~2s and reduces the report to the
 * numbers the UI cares about: ICE state, selected candidate type
 * (host/srflx = direct, relay = relayed), RTT, packet loss, bitrate, FPS, resolution.
 */

export type CandidateKind = 'host' | 'srflx' | 'relay' | 'prflx' | 'unknown';

/** Structural view of a candidate report (older TS libs lack RTCIceCandidateStats). */
interface IceStatsLike {
  candidateType?: string;
  ip?: string;
  address?: string;
  port?: number;
}

/** An ICE candidate endpoint (selected pair). `name` is ip:port (may be an mDNS `.local` name on mobile). */
export interface CandidateInfo {
  kind: CandidateKind;
  name: string;
}

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
  /** Inbound RTP bytes received (viewer side) — 0 means nothing is arriving on the ICE path. */
  rxBytes: number | null;
  rxPackets: number | null;
  framesReceived: number | null;
  framesDecoded: number | null;
  keyFramesDecoded: number | null;
  /** PLI (keyframe-request) count sent by this side. */
  pliCount: number | null;
  /** Negotiated video codec MIME type (e.g. "video/AV1"). */
  codec: string | null;
  /** Selected candidate pair endpoints; null until a pair is selected. */
  localCandidate: CandidateInfo | null;
  remoteCandidate: CandidateInfo | null;
  /** All gathered candidate types (local then remote), for path diagnostics. */
  localKinds: CandidateKind[];
  remoteKinds: CandidateKind[];
  /** Host-type candidate IP addresses (own side) — used for CGNAT detection. */
  localHostIps: string[];
  /** Host-type candidate IP addresses (remote side). */
  remoteHostIps: string[];
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
 * Granular transport path for M7 diagnostics: `direct host`, `direct srflx`,
 * `direct prflx`, or `TURN relay` (candidate type of the selected pair).
 */
export function pathInfo(snapshot: PeerStatsSnapshot): string {
  switch (snapshot.candidateType) {
    case 'host':
      return 'direct host';
    case 'srflx':
      return 'direct srflx';
    case 'prflx':
      return 'direct prflx';
    case 'relay':
      return 'TURN relay';
    case 'unknown':
      return 'direct ?';
    default:
      return pathLabel(snapshot.path);
  }
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
    rxBytes: null,
    rxPackets: null,
    framesReceived: null,
    framesDecoded: null,
    keyFramesDecoded: null,
    pliCount: null,
    codec: null,
    localCandidate: null,
    remoteCandidate: null,
    localKinds: [],
    remoteKinds: [],
    localHostIps: [],
    remoteHostIps: [],
  };

  const entries = [...report.values()];
  const byId = new Map(entries.map((s) => [s.id, s]));

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
    const p = pair as RTCIceCandidatePairStats;
    const local = p.localCandidateId
      ? (byId.get(p.localCandidateId) as IceStatsLike | undefined)
      : undefined;
    const remote = p.remoteCandidateId
      ? (byId.get(p.remoteCandidateId) as IceStatsLike | undefined)
      : undefined;
    if (local) {
      snapshot.candidateType = classifyCandidateType(local.candidateType);
      snapshot.path = pathFor(snapshot.candidateType);
      snapshot.localCandidate = {
        kind: classifyCandidateType(local.candidateType),
        name: candidateName(local),
      };
    }
    if (remote) {
      snapshot.remoteCandidate = {
        kind: classifyCandidateType(remote.candidateType),
        name: candidateName(remote),
      };
    }
    const rtt = p.currentRoundTripTime;
    if (typeof rtt === 'number' && rtt >= 0) snapshot.rttMs = Math.round(rtt * 1000);
  }

  // --- gathered candidate types (all, not just the selected pair) ----------
  snapshot.localKinds = collectCandidateKinds(entries, 'local-candidate');
  snapshot.remoteKinds = collectCandidateKinds(entries, 'remote-candidate');
  snapshot.localHostIps = collectHostIps(entries, 'local-candidate');
  snapshot.remoteHostIps = collectHostIps(entries, 'remote-candidate');

  // --- RTP stats (video) ---------------------------------------------------
  const rtp = entries
    .filter((s) => s.type === 'inbound-rtp' || s.type === 'outbound-rtp')
    .filter((s) => (s as RTCRtpStreamStats).kind === 'video')
    .sort((a, b) => {
      const ba = (a as (typeof a) & { bytesReceived?: number; bytesSent?: number }).bytesReceived ?? (a as any).bytesSent ?? 0;
      const bb = (b as (typeof b) & { bytesReceived?: number; bytesSent?: number }).bytesReceived ?? (b as any).bytesSent ?? 0;
      return bb - ba;
    })[0] as
    | (RTCRtpStreamStats & {
        bytesReceived?: number;
        bytesSent?: number;
        packetsReceived?: number;
        framesPerSecond?: number;
        frameWidth?: number;
        frameHeight?: number;
        packetsLost?: number;
        jitter?: number;
        ssrc?: number;
        framesReceived?: number;
        framesDecoded?: number;
        keyFramesDecoded?: number;
        pliCount?: number;
        codecId?: string;
      })
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
      snapshot.rxBytes = rtp.bytesReceived ?? 0;
      snapshot.rxPackets = rtp.packetsReceived ?? 0;
      snapshot.framesReceived = rtp.framesReceived ?? 0;
      snapshot.framesDecoded = rtp.framesDecoded ?? 0;
      snapshot.keyFramesDecoded = rtp.keyFramesDecoded ?? 0;
      snapshot.pliCount = rtp.pliCount ?? 0;
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
    const codec = rtp.codecId ? (byId.get(rtp.codecId) as { mimeType?: string } | undefined) : undefined;
    snapshot.codec = codec?.mimeType ?? null;
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

/** Single-line summary used by the host page test-broadcast card + viewer. */
export function summarizeStats(snapshot: PeerStatsSnapshot): string {
  const parts: string[] = [];
  const path = pathInfo(snapshot);
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

function candidateName(c: IceStatsLike): string {
  const host = c.ip ?? c.address ?? '?';
  const port = c.port != null ? `:${c.port}` : '';
  return `${host}${port}`;
}

/** All gathered candidate types of one side (may repeat; keeps order). */
function collectCandidateKinds(entries: RTCStats[], type: 'local-candidate' | 'remote-candidate'): CandidateKind[] {
  const kinds: CandidateKind[] = [];
  for (const s of entries) {
    if (s.type !== type) continue;
    kinds.push(classifyCandidateType((s as { candidateType?: string }).candidateType));
  }
  return kinds;
}

/** Host-type candidate IP addresses of one side (mDNS `.local` names excluded). */
function collectHostIps(entries: RTCStats[], type: 'local-candidate' | 'remote-candidate'): string[] {
  const ips = new Set<string>();
  for (const s of entries) {
    if (s.type !== type) continue;
    const c = s as IceStatsLike;
    if (c.candidateType !== 'host') continue;
    const ip = c.ip ?? c.address;
    if (ip && !ip.endsWith('.local')) ips.add(ip);
  }
  return [...ips];
}

export function formatBytes(b: number): string {
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}

/** Collapse a candidate-kind list to "host×2, srflx×1". */
function kindsSummary(kinds: CandidateKind[]): string {
  if (kinds.length === 0) return 'none';
  const counts = new Map<string, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}${n > 1 ? `×${n}` : ''}`)
    .join(' ');
}

/** True for the carrier-grade NAT shared-address space 100.64.0.0/10. */
export function isCgnatIp(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\./);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * When a participant sits on a carrier-CGNAT network (100.64.0.0/10), strict
 * (endpoint-dependent/symmetric-style) CGNAT defeats WebRTC srflx traversal —
 * a relay is genuinely required. Surface that honestly instead of a generic
 * "no path".
 */
export function cgnatNote(s: PeerStatsSnapshot): string {
  for (const ip of [...s.localHostIps, ...s.remoteHostIps]) {
    if (isCgnatIp(ip)) {
      return ` Carrier CGNAT (100.64/10) address ${ip} detected — this network typically blocks direct P2P; a TURN server would be required.`;
    }
  }
  return '';
}

/**
 * Black-screen / no-path diagnosis for the watch page. Classifies a session
 * that is not rendering frames into:
 *  * failed — ICE could not connect any candidate pair (no path at all),
 *  * transport — ICE connected but zero RTP bytes arrive on the selected pair
 *    (NAT/CGNAT / dead-interface pair problem),
 *  * decode — bytes arrive but nothing decodes (codec/keyframe problem,
 *    e.g. missing AV1 decode on the device).
 */
export function stallDiagnosis(s: PeerStatsSnapshot): string | null {
  if (s.connectionState === 'failed') {
    const local = kindsSummary(s.localKinds);
    const remote = kindsSummary(s.remoteKinds);
    const pair =
      s.localCandidate && s.remoteCandidate
        ? `${s.localCandidate.kind} ⇄ ${s.remoteCandidate.kind}`
        : 'no pair';
    return `NO PATH: ICE failed · ${pair} · local [${local}] · remote [${remote}]. No candidate pair connected.${cgnatNote(s)}`;
  }
  if (s.connectionState !== 'connected') return null;
  const dec = s.framesDecoded ?? 0;
  if (dec > 0) return null;
  const pair =
    s.localCandidate && s.remoteCandidate
      ? `${s.localCandidate.kind} ⇄ ${s.remoteCandidate.kind}`
      : 'no selected pair';
  const codec = s.codec ?? '—';
  const local = kindsSummary(s.localKinds);
  const remote = kindsSummary(s.remoteKinds);
  const rx = s.rxBytes ?? 0;
  if (rx === 0) {
    return `STALLED: 0 B received · path ${pair} · ${codec} · local [${local}] · remote [${remote}]. No media on the ICE path — transport/NAT problem.`;
  }
  return `STALLED: ${formatBytes(rx)} received, 0 frames decoded · PLI ${s.pliCount ?? 0} · ${codec} · path ${pair} · local [${local}] · remote [${remote}]. Decode or keyframe problem.`;
}