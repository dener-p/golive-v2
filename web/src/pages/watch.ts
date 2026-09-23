import type { IceCandidateMessage, ServerSignal } from '@golive/shared';
import { connectSignaling, type SignalingClient } from '../signaling';
import { api } from '../api';
import { samplePeerStats, stallDiagnosis, summarizeStats, pathInfo, type StatsState } from '../stats';
import {
  AV1_FIRST,
  createPeerWithRetry,
  flushCandidateQueue,
  iceConfig,
  preferCodecs,
  queueCandidate,
} from '../webrtc';
import { nav, qs, esc, watchLink } from '../ui';
import { t } from '../i18n';

export async function renderWatch(root: HTMLElement, roomId: string): Promise<void> {
  if (!roomId) {
    root.innerHTML = `${nav()}<div class="card">${t('watch.missingRoom')} <a href="#/">${t('nav.home')}</a></div>`;
    return;
  }

  // Watching needs no login: validate the room exists before opening a socket.
  try {
    await api.getRoom(roomId);
  } catch {
    root.innerHTML = `
      ${nav()}
      <div class="card">
        <h2>${t('watch.roomNotFound')}</h2>
        <p class="muted">${t('watch.notFoundSub', { id: esc(roomId) })}</p>
        <a class="btn" href="#/">${t('nav.home')}</a>
      </div>`;
    return;
  }

  root.innerHTML = `
    ${nav()}
    <h1>${t('watch.title', { id: esc(roomId) })}</h1>
    <p class="subtitle">
      <a id="copy-watch-link" href="#">${t('watch.copyLink')}</a>
      <span id="host-state"></span>
    </p>

    <div class="card">
      <video id="player" class="hidden" autoplay playsinline muted></video>
      <div id="waiting">
        <div class="row">
          <span class="mono" id="waiting-text">${t('watch.waiting')}</span>
        </div>
      </div>
    </div>

    <div class="statusline muted" id="stream-status"></div>
    <div class="row">
      <span id="path-badge" class="badge" hidden></span>
      <span class="statusline muted" id="conn-status"></span>
    </div>
    <div class="statusline muted" id="stats-line" hidden></div>
    <div class="statusline error" id="diag-line" hidden></div>
  `;

  root.querySelector('#copy-watch-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    const url = `${window.location.origin}/${watchLink(roomId)}`;
    void navigator.clipboard?.writeText(url).catch(() => {});
  });

  const video = qs(root, '#player') as HTMLVideoElement;
  const waiting = qs(root, '#waiting');
  const waitingText = qs(root, '#waiting-text');
  const streamStatus = qs(root, '#stream-status');
  const connStatus = qs(root, '#conn-status');
  const hostState = qs(root, '#host-state');
  const statsLine = qs(root, '#stats-line');
  const diagLine = qs(root, '#diag-line') as HTMLDivElement;
  const pathBadge = qs(root, '#path-badge');

  const setWaiting = (text: string): void => {
    waitingText.textContent = text;
  };

  let pc: RTCPeerConnection | null = null;
  let iceQueue: IceCandidateMessage[] = [];
  let answered = false;
  let gotHostSignal = false;
  let wsClosed = false;
  let statsTimer: ReturnType<typeof setInterval> | null = null;
  let statsState: StatsState | undefined;
  let mediaLive = false;
  let mediaCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** When the video track was wired up — used to give the decoder a grace period. */
  let trackAt = 0;
  /** M7 timing metrics: answer (local description) set ≈ ICE gathering start. */
  let tLocalDesc = 0;
  /** M7 timing metrics: ICE gathering reported 'complete'. */
  let tGatherComplete = 0;
  /** M7 timing metrics: first 'checking' state. */
  let tChecking = 0;
  /** M7 timing metrics: first 'connected' state. */
  let tConnected = 0;
  /** M7 timing metrics: first terminal state after being connected (disconnect reason). */
  let tTerminal = 0;
  /** M7 timing metrics: first presented video frame. */
  let tFirstFrame = 0;
  let av1ProbeResult: string | null | undefined;

  /** Best-effort AV1 decode capability probe, cached after the first call. */
  const av1Probe = async (): Promise<string> => {
    if (av1ProbeResult !== undefined) return av1ProbeResult ?? '';
    try {
      const mc = (navigator as Navigator & { mediaCapabilities?: MediaCapabilities })
        .mediaCapabilities;
      if (!mc?.decodingInfo) {
        av1ProbeResult = null;
        return '';
      }
      const res = await mc.decodingInfo({
        type: 'file',
        video: {
          contentType: 'video/webm; codecs="av01.0.04M.08"',
          width: 1280,
          height: 720,
          framerate: 30,
          bitrate: 2_000_000,
        },
      });
      av1ProbeResult = res.supported && res.smooth ? t('watch.av1Ok') : t('watch.av1Slow');
    } catch {
      av1ProbeResult = null;
    }
    return av1ProbeResult ?? '';
  };

  const peerId = crypto.randomUUID();

  const stopStats = (): void => {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
  };

  // "Receiving live media." is only claimed once the browser has actually
  // presented a decoded video frame. A track event fires as soon as the
  // transceiver is wired up, which on a stalled stream (the black-screen bug)
  // happens with zero decodable frames — so the connection alone is not proof
  // that media is live.
  const markMediaLive = (): void => {
    if (mediaLive) return;
    const presented = video.getVideoPlaybackQuality?.()?.totalVideoFrames ?? 0;
    if (presented > 0) {
      mediaLive = true;
      if (!tFirstFrame) tFirstFrame = performance.now();
      if (mediaCheckTimer) {
        clearInterval(mediaCheckTimer);
        mediaCheckTimer = null;
      }
      streamStatus.textContent = t('watch.receiving');
      streamStatus.className = 'statusline ok';
    }
  };

  const startMediaCheck = (): void => {
    if (mediaCheckTimer) return;
    markMediaLive();
    mediaCheckTimer = setInterval(markMediaLive, 1000);
  };

  const stopMediaCheck = (): void => {
    if (mediaCheckTimer) clearInterval(mediaCheckTimer);
    mediaCheckTimer = null;
  };

  const renderStats = async (): Promise<void> => {
    if (!pc || (pc.connectionState !== 'connected' && pc.connectionState !== 'failed')) return;
    try {
      const { snapshot, state } = await samplePeerStats(pc, statsState);
      statsState = state;
      if (snapshot.path) {
        pathBadge.hidden = false;
        pathBadge.textContent = pathInfo(snapshot);
        pathBadge.className = `badge ${snapshot.path === 'relayed' ? 'warn' : 'ok'}`;
      }
      statsLine.hidden = false;
      statsLine.textContent = [timingSummary(), summarizeStats(snapshot)].filter(Boolean).join(' · ');
      const iceFailed = pc.connectionState === 'failed';
      if (mediaLive) {
        diagLine.hidden = true;
      } else if (iceFailed || (trackAt > 0 && performance.now() - trackAt > 5_000)) {
        const stall = stallDiagnosis(snapshot);
        if (stall) {
          diagLine.hidden = false;
          diagLine.textContent = `${stall}${iceFailed ? '' : await av1Probe()}`;
        } else {
          diagLine.hidden = true;
        }
      } else {
        diagLine.hidden = true;
      }
    } catch {
      /* transient */
    }
  };

  const startStats = (): void => {
    if (statsTimer) return;
    void renderStats();
    statsTimer = setInterval(() => void renderStats(), 2000);
  };

  /** M7: connection-establishment timeline for the stats line. */
  const timingSummary = (): string => {
    const parts: string[] = [];
    const gather =
      tGatherComplete && tLocalDesc ? Math.round(tGatherComplete - tLocalDesc) : null;
    const checkStart = tChecking || tLocalDesc || 0;
    const checkEnd = tConnected || tTerminal;
    const check = checkStart && checkEnd ? Math.round(Math.max(0, checkEnd - checkStart)) : null;
    const first =
      tFirstFrame ? Math.round(tFirstFrame - (trackAt || tLocalDesc || 0)) : null;
    if (gather != null) parts.push(t('watch.gather', { ms: gather }));
    if (check != null) parts.push(t('watch.check', { ms: check }));
    if (first != null) parts.push(t('watch.firstFrame', { ms: first }));
    return parts.join(' · ');
  };

  /** Record when ICE gathering completes (per peer, so retries are covered too). */
  const attachGatheringListener = (p: RTCPeerConnection): void => {
    p.addEventListener('icegatheringstatechange', () => {
      if (p.iceGatheringState === 'complete' && !tGatherComplete) {
        tGatherComplete = performance.now();
      }
    });
  };

  const tearDown = (): void => {
    stopStats();
    stopMediaCheck();
    pc?.close();
    pc = null;
  };

  const ensurePeer = async (): Promise<RTCPeerConnection | null> => {
    if (pc) return pc;
    try {
      const iceConfigResult = await api.iceServers(roomId);
      const turnAvailable = iceConfigResult.turnConfigured;
      const config: RTCConfiguration = { iceServers: iceConfigResult.iceServers };

      const { pc: newPc, abort } = createPeerWithRetry(
        config,
        {
          onIceCandidate: (candidate) => {
            client.send({ type: 'ice', roomId, candidate });
          },
          onTrack: (evt) => {
            const stream = evt.streams[0] ?? new MediaStream([evt.track]);
            video.srcObject = stream;
            video.muted = true;
            void video.play().catch(() => {});
            video.classList.remove('hidden');
            waiting.style.display = 'none';
            mediaLive = false; // re-verify this track actually renders frames
            trackAt = performance.now();
            streamStatus.textContent = t('watch.connectedWaiting');
            streamStatus.className = 'statusline muted';
            startMediaCheck();
          },
          onStateChange: (state) => {
            const now = performance.now();
            if (state === 'connecting' && !tChecking) tChecking = now;
            connStatus.textContent = t('watch.peerState', { state });
            connStatus.className = state === 'connected' ? 'statusline ok' : 'statusline muted';
            if (state === 'connected') {
              if (!tConnected) tConnected = now;
              startStats();
              startMediaCheck();
            } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
              stopStats();
              stopMediaCheck();
              if (state === 'failed') void renderStats(); // render the NO PATH diagnosis once
              statsLine.hidden = true;
              pathBadge.hidden = true;
              if (state !== 'disconnected') mediaLive = false;
              if (tConnected && !tTerminal) {
                // disconnect reason: how long the session was up before dying
                tTerminal = now;
                connStatus.textContent = t('watch.peerStateAfter', {
                  state,
                  s: ((now - tConnected) / 1000).toFixed(1),
                });
              }
            }
          },
          onRetryNewPeer: (newPeer) => {
            pc = newPeer;
            newPeer.addTransceiver('video', { direction: 'recvonly' });
            preferCodecs(newPeer, 'video', AV1_FIRST);
            attachGatheringListener(newPeer);
          },
        },
        {
          maxAttempts: 2,
          onRetryAttempt: (attempt, reason) => {
            streamStatus.textContent = t('watch.attempt', { n: attempt, reason });
            streamStatus.className = 'statusline muted';
          },
          onRetryExhausted: (reason) => {
            streamStatus.textContent = reason;
            streamStatus.className = 'statusline error';
          },
        },
        turnAvailable,
      );

      // Recv-only video; AV1 preferred when available.
      newPc.addTransceiver('video', { direction: 'recvonly' });
      preferCodecs(newPc, 'video', AV1_FIRST);
      attachGatheringListener(newPc);
      pc = newPc;

      // Store abort function for cleanup
      window.addEventListener('pagehide', () => abort());

      return newPc;
    } catch (err) {
      streamStatus.textContent = t('watch.setupFailed', {
        err: err instanceof Error ? err.message : String(err),
      });
      streamStatus.className = 'statusline error';
      return null;
    }
  };

  const handleOffer = async (sdp: RTCSessionDescriptionInit): Promise<void> => {
    const peer = await ensurePeer();
    if (!peer || answered) return;
    answered = true;
    try {
      await peer.setRemoteDescription(sdp);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      tLocalDesc = performance.now();
      if (peer.localDescription) {
        client.send({
          type: 'sdp',
          roomId,
          sdp: {
            type: peer.localDescription.type as 'answer',
            sdp: peer.localDescription.sdp,
          },
        });
      }
      flushCandidateQueue(peer, iceQueue);
    } catch (err) {
      answered = false;
      streamStatus.textContent = t('watch.joinFailed', {
        err: err instanceof Error ? err.message : String(err),
      });
      streamStatus.className = 'statusline error';
    }
  };

  const client: SignalingClient = connectSignaling({
    roomId,
    role: 'viewer',
    peerId,
    onMessage: (m: ServerSignal) => handleSignal(m),
    onClose: () => {
      wsClosed = true;
      hostState.textContent = t('watch.sigLost');
      if (!gotHostSignal) setWaiting(t('watch.sigLostBeforeHost'));
    },
  });

  const handleSignal = (m: ServerSignal): void => {
    switch (m.type) {
      case 'joined':
        hostState.textContent = t('watch.joined', {
          n: `${m.viewerCount} ${m.viewerCount === 1 ? t('watch.viewer') : t('watch.viewers')}`,
        });
        break;
      case 'sdp':
        if (m.from === 'host') {
          gotHostSignal = true;
          setWaiting(
            m.sdp.type === 'offer' ? t('watch.hostPresentConnecting') : t('watch.hostPresent'),
          );
          void handleOffer(m.sdp);
        }
        break;
      case 'ice':
        if (m.from === 'host') {
          if (pc) queueCandidate(pc, iceQueue, m.candidate);
          else iceQueue.push(m.candidate);
        }
        break;
      case 'peer-joined':
        hostState.textContent = t('watch.hostConnected');
        break;
      case 'peer-left':
        hostState.textContent = t('watch.hostLeft');
        if (pc && pc.connectionState !== 'connected') {
          setWaiting(t('watch.hostOffline'));
        }
        break;
      case 'error':
        streamStatus.textContent = t('watch.serverError', {
          code: m.code,
          message: m.message,
        });
        streamStatus.className = 'statusline error';
        break;
    }
  };

  // Safety: if nothing arrived within a minute, prompt the host situation.
  setTimeout(() => {
    if (!gotHostSignal && !wsClosed) {
      hostState.textContent = t('watch.noHost');
      setWaiting(t('watch.noHostBroadcasting'));
    }
  }, 60_000);

  window.addEventListener('pagehide', () => {
    tearDown();
    client.close();
  });
}