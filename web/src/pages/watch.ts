import type { IceCandidateMessage, ServerSignal } from '@golive/shared';
import { connectSignaling, type SignalingClient } from '../signaling';
import { api } from '../api';
import { ensureUser } from '../session';
import { samplePeerStats, summarizeStats, pathLabel, type StatsState } from '../stats';
import {
  AV1_FIRST,
  createPeer,
  flushCandidateQueue,
  iceConfig,
  preferCodecs,
  queueCandidate,
} from '../webrtc';
import { loginCard, nav, qs, esc, watchLink } from '../ui';

export async function renderWatch(root: HTMLElement, roomId: string): Promise<void> {
  if (!roomId) {
    root.innerHTML = `${nav()}<div class="card">Missing room id. <a href="#/">Home</a></div>`;
    return;
  }

  const user = await ensureUser();
  const meta = await api.meta();

  if (!user) {
    root.innerHTML = `
      ${nav()}
      <h1>Watch ${esc(roomId)}</h1>
      <p class="subtitle">Sign in to join this room.</p>`;
    root.appendChild(loginCard(meta.auth));
    root.querySelector('#dev-login')?.addEventListener('click', async () => {
      const { devLogin } = await import('../session');
      await devLogin();
      void renderWatch(root, roomId);
    });
    return;
  }

  // Validate the room exists before opening a socket.
  try {
    await api.getRoom(roomId);
  } catch {
    root.innerHTML = `
      ${nav()}
      <div class="card">
        <h2>Room not found</h2>
        <p class="muted">“${esc(roomId)}” doesn’t exist (or you’re signed in as the wrong account).
        Ask the host for the correct link.</p>
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
      <video id="player" class="hidden" autoplay playsinline></video>
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

  const peerId = crypto.randomUUID();

  const stopStats = (): void => {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
  };

  const renderStats = async (): Promise<void> => {
    if (!pc || pc.connectionState !== 'connected') return;
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
    pc?.close();
    pc = null;
  };

  const ensurePeer = async (): Promise<RTCPeerConnection | null> => {
    if (pc) return pc;
    try {
      const config = await iceConfig();
      const newPc = createPeer(config, {
        onIceCandidate: (candidate) => {
          client.send({ type: 'ice', roomId, candidate });
        },
        onTrack: (evt) => {
          video.srcObject = evt.streams[0] ?? null;
          video.classList.remove('hidden');
          waiting.style.display = 'none';
          streamStatus.textContent = 'Receiving live media.';
          streamStatus.className = 'statusline ok';
        },
        onStateChange: (state) => {
          connStatus.textContent = `Peer ${state}.`;
          connStatus.className = state === 'connected' ? 'statusline ok' : 'statusline muted';
          if (state === 'connected') {
            startStats();
          } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
            stopStats();
            statsLine.hidden = true;
            pathBadge.hidden = true;
          }
        },
      });
      // Recv-only video; AV1 preferred when available.
      newPc.addTransceiver('video', { direction: 'recvonly' });
      preferCodecs(newPc, 'video', AV1_FIRST);
      pc = newPc;
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