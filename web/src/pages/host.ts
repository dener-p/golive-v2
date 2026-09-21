import { api } from '../api';
import { ensureUser } from '../session';
import { loginCard, nav, qs, esc, watchLink } from '../ui';
import { invalidateIceConfig } from '../webrtc';

export async function renderHost(root: HTMLElement, query: URLSearchParams): Promise<void> {
  const user = await ensureUser();
  const meta = await api.meta();

  if (!user) {
    root.innerHTML = `
      ${nav()}
      <h1>Host</h1>
      <p class="subtitle">Host mode unlocks once the native helper connects to the backend.</p>`;
    root.appendChild(loginCard(meta.auth));
    root.querySelector('#dev-login')?.addEventListener('click', async () => {
      const { devLogin } = await import('../session');
      await devLogin();
      void renderHost(root, query);
    });
    return;
  }

  // --- state -------------------------------------------------------------
  let roomId: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  /** Command id we most recently sent; used to report its ack (or staleness). */
  let lastSentId: string | null = null;

  const cleanup = (): void => {
    disposed = true;
    if (pollTimer) clearInterval(pollTimer);
  };
  window.addEventListener('pagehide', cleanup);

  // --- render ------------------------------------------------------------
  const render = (): void => {
    root.innerHTML = `
      ${nav('golive · host')}
      <h1>Host mode</h1>
      <p class="subtitle">Controls are driven by the backend; the native helper is reached only through it.</p>

      <div class="card">
        <h2>Room</h2>
        ${
          roomId
            ? `
          <div class="row">
            <span class="grow mono">${esc(roomId)}</span>
            <a class="btn small" href="${watchLink(roomId)}">watch link</a>
            <button class="small" id="copy-watch">copy</button>
            <button class="small" id="leave-room">leave</button>
          </div>
          <div class="statusline muted" id="room-creator"></div>`
            : `
          <p class="muted">No room selected.</p>
          <button id="create-room" class="primary">Create room</button>
          <div class="statusline muted" id="room-status"></div>`
        }
      </div>

      <div class="card">
        <h2>Native helper</h2>
        <div class="row">
          <span id="helper-badge" class="badge warn">checking…</span>
          <span id="helper-version" class="muted"></span>
          <span class="muted" id="helper-last-seen"></span>
        </div>
        <p class="muted">
          Run <code>cargo run</code> in <code>helper/</code> to start the native helper.
          It captures your screen, encodes AV1, and streams to viewers through the backend.
        </p>
        <div class="row">
          <button id="cmd-start" class="primary" disabled>Start live</button>
          <button id="cmd-stop" class="danger" disabled>Stop live</button>
        </div>
        <div class="statusline muted" id="command-result"></div>
      </div>

      <div class="card">
        <h2>TURN configuration (optional)</h2>
        <p class="muted">
          If STUN cannot establish a direct connection, viewers will need a TURN server.
          Configure your own TURN credentials below (e.g. Cloudflare TURN).
        </p>
        <div class="row" style="margin-bottom:8px">
          <input id="turn-urls" type="text" placeholder="turn:your-server:3478" class="grow" />
        </div>
        <div class="row" style="margin-bottom:8px">
          <input id="turn-username" type="text" placeholder="username" style="width:45%" />
          <input id="turn-credential" type="password" placeholder="credential" style="width:45%" />
        </div>
        <div class="row">
          <button id="turn-save" class="primary" ${roomId ? '' : 'disabled'}>Save TURN config</button>
          <button id="turn-clear" ${roomId ? '' : 'disabled'}>Clear</button>
          <span class="statusline muted" id="turn-status"></span>
        </div>
      </div>
    `;

    // room
    if (!roomId) {
      const createBtn = root.querySelector('#create-room') as HTMLButtonElement | null;
      createBtn?.addEventListener('click', async () => {
        const status = qs(root, '#room-status');
        createBtn.disabled = true;
        status.textContent = 'Creating…';
        try {
          const { room } = await api.createRoom();
          roomId = room.roomId;
          setRoomCreator();
          poll();
          render();
        } catch (err) {
          status.className = 'statusline error';
          status.textContent = `Failed: ${err instanceof Error ? err.message : err}`;
          createBtn.disabled = false;
        }
      });
    } else {
      root.querySelector('#copy-watch')?.addEventListener('click', () => {
        const url = `${window.location.origin}/${watchLink(roomId!)}`;
        void navigator.clipboard?.writeText(url).catch(() => {});
      });
      root.querySelector('#leave-room')?.addEventListener('click', () => {
        roomId = null;
        render();
      });
    }

    // helper commands
    root.querySelector('#cmd-start')?.addEventListener('click', () => {
      if (roomId) void sendCommand('start', { roomId });
    });
    root.querySelector('#cmd-stop')?.addEventListener('click', () => void sendCommand('stop'));

    // TURN config
    root.querySelector('#turn-save')?.addEventListener('click', async () => {
      if (!roomId) return;
      const urls = (root.querySelector('#turn-urls') as HTMLInputElement)?.value.trim();
      const username = (root.querySelector('#turn-username') as HTMLInputElement)?.value.trim();
      const credential = (root.querySelector('#turn-credential') as HTMLInputElement)?.value.trim();
      const status = qs(root, '#turn-status');

      if (!urls) {
        status.textContent = 'TURN URL is required.';
        status.className = 'statusline error';
        return;
      }

      try {
        const res = await api.setTurnConfig(roomId, {
          urls: urls.split(',').map((s) => s.trim()).filter(Boolean),
          username,
          credential,
        });
        status.textContent = res.turnConfigured ? 'TURN config saved.' : 'TURN config cleared.';
        status.className = 'statusline ok';
        invalidateIceConfig(roomId);
      } catch (err) {
        status.textContent = `Failed: ${err instanceof Error ? err.message : err}`;
        status.className = 'statusline error';
      }
    });

    root.querySelector('#turn-clear')?.addEventListener('click', async () => {
      if (!roomId) return;
      const status = qs(root, '#turn-status');
      try {
        await api.setTurnConfig(roomId, null);
        status.textContent = 'TURN config cleared.';
        status.className = 'statusline ok';
        invalidateIceConfig(roomId);
        const urls = root.querySelector('#turn-urls') as HTMLInputElement | null;
        const username = root.querySelector('#turn-username') as HTMLInputElement | null;
        const credential = root.querySelector('#turn-credential') as HTMLInputElement | null;
        if (urls) urls.value = '';
        if (username) username.value = '';
        if (credential) credential.value = '';
      } catch (err) {
        status.textContent = `Failed: ${err instanceof Error ? err.message : err}`;
        status.className = 'statusline error';
      }
    });

  };

  const setRoomCreator = (): void => {
    if (!roomId) return;
    const el = root.querySelector('#room-creator');
    if (el) {
      void api
        .getRoom(roomId)
        .then(({ room }) => {
          el.textContent = `Created by ${room.hostName ?? room.hostId}`;
        })
        .catch(() => {});
    }
  };

  // --- helper polling -----------------------------------------------------
  const poll = (): void => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => void refreshHelper(), 3000);
    void refreshHelper();
  };

  const refreshHelper = async (): Promise<void> => {
    if (disposed) return;
    try {
      const { status } = await api.helperStatus();
      const badge = root.querySelector('#helper-badge');
      const version = root.querySelector('#helper-version');
      const seen = root.querySelector('#helper-last-seen');
      const out = root.querySelector('#command-result') as HTMLElement | null;
      const startBtn = root.querySelector('#cmd-start') as HTMLButtonElement | null;
      const stopBtn = root.querySelector('#cmd-stop') as HTMLButtonElement | null;
      if (!badge || !seen) return;
      if (status.connected) {
        badge.textContent = `helper connected · ${status.state ?? 'idle'}`;
        badge.className = 'badge ok';
        if (version) version.textContent = status.helperVersion ? String(status.helperVersion) : '';
        seen.textContent = `last seen ${new Date(status.lastSeenAt!).toLocaleTimeString()}`;
        if (startBtn) startBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = false;
      } else {
        badge.textContent = 'helper offline';
        badge.className = 'badge warn';
        if (version) version.textContent = '';
        seen.textContent = '';
        if (startBtn) startBtn.disabled = true;
        if (stopBtn) stopBtn.disabled = true;
      }

      // Report the ack for the command we sent (or the latest one from this helper).
      const last = status.lastCommand;
      if (last && (!lastSentId || last.id === lastSentId) && out) {
        if (last.ok) {
          out.textContent = `"${last.command}" accepted by helper${last.state ? ` · now ${last.state}` : ''} @ ${new Date(last.at).toLocaleTimeString()}`;
          out.className = 'statusline ok';
        } else {
          out.textContent = `"${last.command}" REJECTED by helper${last.detail ? ` — ${last.detail}` : ''}`;
          out.className = 'statusline error';
        }
        if (lastSentId === last.id) lastSentId = null;
      }
    } catch {
      /* transient */
    }
  };

  const sendCommand = async (command: string, payload?: unknown): Promise<void> => {
    const out = root.querySelector('#command-result');
    if (!out) return;
    try {
      const res = await api.helperCommand(command, payload);
      if (!res.delivered) {
        out.textContent = `Command "${command}" NOT delivered — helper offline.`;
        out.className = 'statusline error';
        return;
      }
      lastSentId = res.id ?? null;
      out.textContent = `Command "${command}" relayed — awaiting helper ack…`;
      out.className = 'statusline';
    } catch (err) {
      out.textContent = `Failed: ${err instanceof Error ? err.message : err}`;
      out.className = 'statusline error';
    }
  };

  // --- boot ---
  const roomParam = (query.get('room') ?? '').trim().toLowerCase();
  if (roomParam) {
    try {
      const { room } = await api.getRoom(roomParam);
      roomId = room.roomId;
    } catch {
      // room unknown; render and let the status line explain
    }
  }
  render();
  setRoomCreator();
  if (roomId) poll();

  // Keep the helper badge live while the page is shown.
  const onVisible = (): void => {
    if (!disposed && roomId) void refreshHelper();
  };
  document.addEventListener('visibilitychange', onVisible);
}