import type { IceCandidateMessage, ServerSignal } from '@golive/shared';
import { connectSignaling, type SignalingClient } from '../signaling';
import { api } from '../api';
import { samplePeerStats, stallDiagnosis, summarizeStats, pathLabel, type StatsState } from '../stats';
import {
  AV1_FIRST,
  createPeerWithRetry,
  flushCandidateQueue,
  iceConfig,
  preferCodecs,
  queueCandidate,
} from '../webrtc';
import { nav, qs, esc, watchLink } from '../ui';

export async function renderWatch(root: HTMLElement, roomId: string): Promise<void> {
  if (!roomId) {
    root.innerHTML = `${nav()}<div class="card">Missing room id. <a href="#/">Home</a></div>`;
    return;
  }

  // Watching needs no login: validate the room exists before opening a socket.
  try {
    await api.getRoom(roomId);
  } catch {
    root.innerHTML = `
      ${nav()}
      <div class="card">
        <h2>Room not found</h2>
        <p class="muted">“${esc(roomId)}” doesn’t exist. Ask the host for the correct link.</p>
        <a class="btn" href="#/">Home</a>
      </div>`;
    return;
  }

  root.innerHTML = `
    ${nav()}
    <h1>Watch ${esc(roomId)}</h1>
    <p class="subtitle">
      <a id="copy-watch-link" href="#">copy room link</a>
      <span id="host-state"></span>
    </p>

    <div class="card">
      <video id="player" class="hidden" autoplay playsinline muted></video>
      <div id="waiting">
        <div class="row">
          <span class="mono" id="waiting-text">Waiting for the host to start broadcasting…</span>
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
      av1ProbeResult = res.supported && res.smooth ? ' · AV1 decode OK' : ' · AV1 decode NO/slow';
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
      if (mediaCheckTimer) {
        clearInterval(mediaCheckTimer);
        mediaCheckTimer = null;
      }
      streamStatus.textContent = 'Receiving live media.';
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
        pathBadge.textContent = pathLabel(snapshot.path);
        pathBadge.className = `badge ${snapshot.path === 'relayed' ? 'warn' : 'ok'}`;
      }
      statsLine.hidden = false;
      statsLine.textContent = summarizeStats(snapshot);
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
            streamStatus.textContent = 'Connected to host — waiting for video…';
            streamStatus.className = 'statusline muted';
            startMediaCheck();
          },
          onStateChange: (state) => {
            connStatus.textContent = `Peer ${state}.`;
            connStatus.className = state === 'connected' ? 'statusline ok' : 'statusline muted';
            if (state === 'connected') {
              startStats();
              startMediaCheck();
            } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
              stopStats();
              stopMediaCheck();
              statsLine.hidden = true;
              pathBadge.hidden = true;
              if (state !== 'disconnected') mediaLive = false;
            }
          },
          onRetryNewPeer: (newPeer) => {
            pc = newPeer;
            newPeer.addTransceiver('video', { direction: 'recvonly' });
            preferCodecs(newPeer, 'video', AV1_FIRST);
          },
        },
        {
          maxAttempts: 2,
          onRetryAttempt: (attempt, reason) => {
            streamStatus.textContent = `Attempt ${attempt}: ${reason}`;
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
      pc = newPc;

      // Store abort function for cleanup
      window.addEventListener('pagehide', () => abort());

      return newPc;
    } catch (err) {
      streamStatus.textContent = `Could not set up media: ${err instanceof Error ? err.message : err}`;
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
      streamStatus.textContent = `Join attempt failed: ${err instanceof Error ? err.message : err}`;
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
      hostState.textContent = '(signaling connection lost)';
      if (!gotHostSignal) setWaiting('Signaling lost before the host was seen.');
    },
  });

  const handleSignal = (m: ServerSignal): void => {
    switch (m.type) {
      case 'joined':
        hostState.textContent = `(joined as viewer · ${m.viewerCount} viewer${m.viewerCount === 1 ? '' : 's'})`;
        break;
      case 'sdp':
        if (m.from === 'host') {
          gotHostSignal = true;
          setWaiting(m.sdp.type === 'offer' ? 'Host present — connecting…' : 'Host present.');
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
        hostState.textContent = '(host connected)';
        break;
      case 'peer-left':
        hostState.textContent = '(host left)';
        if (pc && pc.connectionState !== 'connected') {
          setWaiting('Host went offline. Refresh to re-join when they return.');
        }
        break;
      case 'error':
        streamStatus.textContent = `${m.code}: ${m.message}`;
        streamStatus.className = 'statusline error';
        break;
    }
  };

  // Safety: if nothing arrived within a minute, prompt the host situation.
  setTimeout(() => {
    if (!gotHostSignal && !wsClosed) {
      hostState.textContent = '(no host detected)';
      setWaiting('No host is broadcasting this room yet — start the native helper or the test host.');
    }
  }, 60_000);

  window.addEventListener('pagehide', () => {
    tearDown();
    client.close();
  });
}