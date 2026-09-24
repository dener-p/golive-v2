import { api } from '../api';
import { ensureUser } from '../session';
import { loginCard, nav, qs, esc, watchLink } from '../ui';
import { invalidateIceConfig } from '../webrtc';
import { t } from '../i18n';
import { DEFAULT_PRESET_ID, presetById, QUALITY_PRESETS } from '../quality';

export async function renderHost(root: HTMLElement, query: URLSearchParams): Promise<void> {
  const user = await ensureUser();
  const meta = await api.meta();
  /** Latest published helper (version + sha256) from the backend; null if unpublished. */
  const latest = await api.helperLatest().catch(() => null);

  if (!user) {
    root.innerHTML = `
      ${nav()}
      <h1>${t('host.title')}</h1>
      <p class="subtitle">${t('host.unauthed')}</p>`;
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
  let pairExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** Command id we most recently sent; used to report its ack (or staleness). */
  let lastSentId: string | null = null;
  /** In-flight Start/Stop; the toggle button shows a progress state while set. */
  let pendingToggle: 'starting' | 'stopping' | null = null;
  let toggleTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Last helper status snapshot, for re-rendering the toggle outside polls. */
  let lastStatus: { connected: boolean; state: string | null } = { connected: false, state: null };

  const cleanup = (): void => {
    disposed = true;
    if (pollTimer) clearInterval(pollTimer);
    if (pairExpiryTimer) clearTimeout(pairExpiryTimer);
    if (toggleTimeout) clearTimeout(toggleTimeout);
  };
  window.addEventListener('pagehide', cleanup);

  // --- render ------------------------------------------------------------
  const render = (): void => {
    root.innerHTML = `
      ${nav('golive · host')}
      <h1>${t('host.title')}</h1>
      <p class="subtitle">${t('host.subtitle')}</p>

      <div class="card">
        <h2>${t('host.roomCard')}</h2>
        ${
          roomId
            ? `
          <div class="row">
            <span class="grow mono room-id">${esc(roomId)}</span>
            <a class="btn small" href="${watchLink(roomId)}">${t('host.watchLink')}</a>
            <button class="small" id="copy-watch">${t('host.copy')}</button>
            <button class="small" id="leave-room">${t('host.leave')}</button>
          </div>
          <div class="statusline muted" id="room-creator"></div>`
            : `
          <p class="muted">${t('host.noRoom')}</p>
          <button id="create-room" class="primary">${t('host.createRoom')}</button>
          <div class="statusline muted" id="room-status"></div>`
        }
      </div>

      <div class="card">
        <h2>${t('host.helperCard')}</h2>
        <div class="row">
          <span id="helper-badge" class="badge warn">${t('host.helperChecking')}</span>
          <span id="helper-version" class="muted"></span>
          <span class="muted" id="helper-last-seen"></span>
        </div>
        <p class="muted">
          ${t('host.helperDesc')}
        </p>
        <div class="statusline" id="helper-dl"></div>
        <div class="row quality-row">
          <label for="quality-select">${t('host.quality')}</label>
          <select id="quality-select" disabled>
            ${QUALITY_PRESETS.map(
              (p) =>
                `<option value="${p.id}"${p.id === DEFAULT_PRESET_ID ? ' selected' : ''}>${p.label}</option>`,
            ).join('')}
          </select>
        </div>
        <div class="row">
          <button id="cmd-toggle" class="primary" disabled>${t('host.startLive')}</button>
          <button id="cmd-nat-test" class="small" disabled>${t('host.natTest')}</button>
          <button id="cmd-nat-map" class="small" disabled>${t('host.natMap')}</button>
        </div>
        <div class="statusline muted" id="command-result"></div>
      </div>

      <div class="card">
        <h2>${t('host.pairCard')} <span class="muted">${t('host.pairSkip')}</span></h2>
        <p class="muted">
          ${t('host.pairSub')}
        </p>
        <div class="row">
          <button id="pair-get" class="primary">${t('host.pairGet')}</button>
          <span class="statusline muted" id="pair-status"></span>
        </div>
        <div id="pair-box" hidden>
          <p class="mono big" id="pair-code"></p>
          <p id="pair-cmd-line"></p>
          <p class="muted">${t('host.pairExpiry', { n: '<span id="pair-expiry">5</span>' })}</p>
        </div>
        <div id="pair-devices"></div>
      </div>

      <div class="card">
        <h2>${t('host.turnCard')}</h2>
        <p class="muted">
          ${t('host.turnDesc')}
        </p>
        <div class="row" style="margin-bottom:8px">
          <input id="turn-urls" type="text" placeholder="turn:your-server:3478" class="grow" />
        </div>
        <div class="row" style="margin-bottom:8px">
          <input id="turn-username" type="text" placeholder="${t('host.turnUsername')}" style="width:45%" />
          <input id="turn-credential" type="password" placeholder="${t('host.turnCredential')}" style="width:45%" />
        </div>
        <div class="row">
          <button id="turn-save" class="primary" ${roomId ? '' : 'disabled'}>${t('host.turnSave')}</button>
          <button id="turn-clear" ${roomId ? '' : 'disabled'}>${t('host.turnClear')}</button>
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
        status.textContent = t('host.creating');
        try {
          const { room } = await api.createRoom();
          roomId = room.roomId;
          setRoomCreator();
          poll();
          render();
        } catch (err) {
          status.className = 'statusline error';
          status.textContent = t('host.failed', {
            err: err instanceof Error ? err.message : String(err),
          });
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
    root.querySelector('#cmd-toggle')?.addEventListener('click', () => {
      const live = pendingToggle === 'stopping' || lastStatus.state === 'live';
      if (live) {
        pendingToggle = 'stopping';
        void sendCommand('stop');
      } else {
        if (!roomId) return;
        const sel = root.querySelector('#quality-select') as HTMLSelectElement | null;
        const preset = presetById(sel?.value);
        pendingToggle = 'starting';
        void sendCommand('start', {
          roomId,
          width: preset.width,
          height: preset.height,
          fps: preset.fps,
        });
      }
      armToggleTimeout();
      applyToggleButton(lastStatus);
    });
    root.querySelector('#cmd-nat-test')?.addEventListener('click', () => void sendCommand('nat-test'));
    root.querySelector('#cmd-nat-map')?.addEventListener('click', () => void sendCommand('nat-map'));

    // TURN config
    root.querySelector('#turn-save')?.addEventListener('click', async () => {
      if (!roomId) return;
      const urls = (root.querySelector('#turn-urls') as HTMLInputElement)?.value.trim();
      const username = (root.querySelector('#turn-username') as HTMLInputElement)?.value.trim();
      const credential = (root.querySelector('#turn-credential') as HTMLInputElement)?.value.trim();
      const status = qs(root, '#turn-status');

      if (!urls) {
        status.textContent = t('host.turnUrlRequired');
        status.className = 'statusline error';
        return;
      }

      try {
        const res = await api.setTurnConfig(roomId, {
          urls: urls.split(',').map((s) => s.trim()).filter(Boolean),
          username,
          credential,
        });
        status.textContent = res.turnConfigured ? t('host.turnSaved') : t('host.turnCleared');
        status.className = 'statusline ok';
        invalidateIceConfig(roomId);
      } catch (err) {
        status.textContent = t('host.failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        status.className = 'statusline error';
      }
    });

    root.querySelector('#turn-clear')?.addEventListener('click', async () => {
      if (!roomId) return;
      const status = qs(root, '#turn-status');
      try {
        await api.setTurnConfig(roomId, null);
        status.textContent = t('host.turnCleared');
        status.className = 'statusline ok';
        invalidateIceConfig(roomId);
        const urls = root.querySelector('#turn-urls') as HTMLInputElement | null;
        const username = root.querySelector('#turn-username') as HTMLInputElement | null;
        const credential = root.querySelector('#turn-credential') as HTMLInputElement | null;
        if (urls) urls.value = '';
        if (username) username.value = '';
        if (credential) credential.value = '';
      } catch (err) {
        status.textContent = t('host.failed', {
          err: err instanceof Error ? err.message : String(err),
        });
        status.className = 'statusline error';
      }
    });

    // pairing (device tokens for the native helper)
    const pairStatus = qs(root, '#pair-status');
    const pairBox = root.querySelector('#pair-box') as HTMLElement | null;
    let refreshDevices: () => Promise<void> = async () => {};

    root.querySelector('#pair-get')?.addEventListener('click', async () => {
      const btn = root.querySelector('#pair-get') as HTMLButtonElement | null;
      if (btn) btn.disabled = true;
      pairStatus.className = 'statusline muted';
      pairStatus.textContent = t('host.minting');
      try {
        const { code, expiresInSeconds } = await api.pairCode();
        if (pairBox) pairBox.hidden = false;
        const codeEl = root.querySelector('#pair-code');
        if (codeEl) codeEl.textContent = code;
        const cmdLine = root.querySelector('#pair-cmd-line');
        if (cmdLine) {
          cmdLine.innerHTML = `${t('host.pairCmdPref')} <code>golive-helper.exe pair ${esc(meta.baseUrl)} ${esc(code)}</code>`;
        }
        const expiry = root.querySelector('#pair-expiry');
        if (expiry) expiry.textContent = String(expiresInSeconds);
        pairStatus.className = 'statusline ok';
        pairStatus.textContent = t('host.codeReady');
        if (pairExpiryTimer) clearTimeout(pairExpiryTimer);
        pairExpiryTimer = setTimeout(() => {
          pairStatus.className = 'statusline';
          pairStatus.textContent = t('host.codeExpired');
        }, expiresInSeconds * 1000);
      } catch (err) {
        pairStatus.className = 'statusline error';
        pairStatus.textContent = t('host.failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    refreshDevices = async (): Promise<void> => {
      const el = root.querySelector('#pair-devices');
      if (!el) return;
      try {
        const { tokens } = await api.pairedDevices();
        if (!tokens.length) {
          el.textContent = t('host.noDevices');
          return;
        }
        el.innerHTML =
          `<div class="muted" style="margin:10px 0 4px">${t('host.devicesHeader')}</div>` +
          tokens
            .map(
              (dev) =>
                `<div class="row" style="margin-bottom:4px"><span class="grow">${esc(dev.deviceName || dev.id)} <span class="muted">· paired ${esc(new Date(dev.createdAt).toLocaleDateString())}</span></span><button class="small" data-revoke="${esc(dev.id)}">${t('host.revoke')}</button></div>`,
            )
            .join('');
        el.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              await api.revokeDevice(btn.dataset.revoke ?? '');
              void refreshDevices();
            } catch (err) {
              btn.disabled = false;
              pairStatus.className = 'statusline error';
              pairStatus.textContent = t('host.revokeFailed', {
                err: err instanceof Error ? err.message : String(err),
              });
            }
          });
        });
      } catch {
        el.textContent = '';
      }
    };
    void refreshDevices();
  };

  const setRoomCreator = (): void => {
    if (!roomId) return;
    const el = root.querySelector('#room-creator');
    if (el) {
      void api
        .getRoom(roomId)
        .then(({ room }) => {
          el.textContent = t('host.createdBy', { name: room.hostName ?? room.hostId });
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

  // --- start/stop toggle -----------------------------------------------------
  const clearPendingToggle = (): void => {
    pendingToggle = null;
    if (toggleTimeout) {
      clearTimeout(toggleTimeout);
      toggleTimeout = null;
    }
  };

  const armToggleTimeout = (): void => {
    if (toggleTimeout) clearTimeout(toggleTimeout);
    toggleTimeout = setTimeout(() => {
      clearPendingToggle();
      applyToggleButton(lastStatus);
    }, 15_000);
  };

  /**
   * One button that reflects what the helper is doing:
   * offline → disabled "Start live"; idle/error → enabled "Start live";
   * live → enabled danger "Stop live"; in-flight command → disabled progress label.
   */
  const applyToggleButton = (s: { connected: boolean; state: string | null }): void => {
    const btn = root.querySelector('#cmd-toggle') as HTMLButtonElement | null;
    const qualitySel = root.querySelector('#quality-select') as HTMLSelectElement | null;
    if (!btn) return;
    const live = s.state === 'live' || pendingToggle === 'stopping';
    if (qualitySel) qualitySel.disabled = !s.connected || live || pendingToggle === 'starting';
    if (pendingToggle === 'starting' || pendingToggle === 'stopping') {
      btn.disabled = true;
      btn.className = pendingToggle === 'starting' ? 'primary' : 'danger';
      btn.textContent = t(pendingToggle === 'starting' ? 'host.starting' : 'host.stopping');
      return;
    }
    if (live) {
      btn.disabled = false;
      btn.className = 'danger';
      btn.textContent = t('host.stopLive');
      return;
    }
    btn.disabled = !s.connected;
    btn.className = 'primary';
    btn.textContent = t('host.startLive');
  };

  /** Fill the download card / version hint under the helper badge. */
  const fillHelperDl = (connected = false, helperVersion?: string | null): void => {
    const dl = root.querySelector('#helper-dl');
    if (!dl) return;
    if (connected && latest?.available) {
      const running = helperVersion ?? '?';
      if (latest.version && running !== latest.version) {
        dl.innerHTML = t('host.helperUpdate', {
          running: esc(running),
          latest: esc(latest.version),
        });
        dl.className = 'statusline';
      } else {
        dl.textContent = t('host.helperUpToDate', { running });
        dl.className = 'statusline muted';
      }
      return;
    }
    if (connected) {
      dl.textContent = t('host.helperConnected');
      dl.className = 'statusline muted';
      return;
    }
    if (latest?.available) {
      const short = latest.sha256 ? latest.sha256.slice(0, 16) : '';
      dl.innerHTML = t('host.noHelperDownload', {
        ver: esc(latest.version ?? ''),
        sha: esc(short),
      });
      dl.className = 'statusline';
    } else {
      dl.textContent = t('host.noHelperBuild');
      dl.className = 'statusline muted';
    }
  };

  const refreshHelper = async (): Promise<void> => {
    if (disposed) return;
    try {
      const { status } = await api.helperStatus();
      const badge = root.querySelector('#helper-badge');
      const version = root.querySelector('#helper-version');
      const seen = root.querySelector('#helper-last-seen');
      const out = root.querySelector('#command-result') as HTMLElement | null;
      const natBtn = root.querySelector('#cmd-nat-test') as HTMLButtonElement | null;
      if (!badge || !seen) return;
      lastStatus = { connected: status.connected, state: status.state ?? null };
      const mapBtn = root.querySelector('#cmd-nat-map') as HTMLButtonElement | null;
      if (status.connected) {
        badge.textContent = t('host.helperConnectedState', { state: status.state ?? 'idle' });
        badge.className = 'badge ok';
        if (version) version.textContent = status.helperVersion ? String(status.helperVersion) : '';
        seen.textContent = t('host.lastSeen', {
          time: new Date(status.lastSeenAt!).toLocaleTimeString(),
        });
        if (natBtn) natBtn.disabled = false;
        if (mapBtn) mapBtn.disabled = false;
        fillHelperDl(true, status.helperVersion ? String(status.helperVersion) : undefined);
      } else {
        badge.textContent = t('host.helperOffline');
        badge.className = 'badge warn';
        if (version) version.textContent = '';
        seen.textContent = '';
        if (natBtn) natBtn.disabled = true;
        if (mapBtn) mapBtn.disabled = true;
        fillHelperDl(false);
      }
      applyToggleButton(lastStatus);

      // Report the ack for the command we sent (or the latest one from this helper).
      const last = status.lastCommand;
      if (last && (!lastSentId || last.id === lastSentId) && out) {
        if (last.ok) {
          const detail = last.detail ? ` — ${last.detail}` : '';
          out.textContent = t('host.cmdAccepted', {
            command: last.command,
            state: last.state ?? 'idle',
            detail,
            time: new Date(last.at).toLocaleTimeString(),
          });
          out.className = 'statusline ok';
        } else {
          const detail = last.detail ? ` — ${last.detail}` : '';
          out.textContent = t('host.cmdRejected', { command: last.command, detail });
          out.className = 'statusline error';
        }
        if (lastSentId === last.id) {
          lastSentId = null;
          clearPendingToggle();
          // The ack carries the helper's new state — re-render the toggle now
          // instead of waiting for the next poll.
          applyToggleButton({ connected: true, state: last.state ?? lastStatus.state });
        }
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
        out.textContent = t('host.cmdNotDelivered', { command });
        out.className = 'statusline error';
        clearPendingToggle();
        applyToggleButton(lastStatus);
        return;
      }
      lastSentId = res.id ?? null;
      out.textContent = t('host.cmdRelayed', { command });
      out.className = 'statusline';
    } catch (err) {
      out.textContent = t('host.failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      out.className = 'statusline error';
      clearPendingToggle();
      applyToggleButton(lastStatus);
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
  fillHelperDl(false);
  setRoomCreator();
  if (roomId) poll();

  // Keep the helper badge live while the page is shown.
  const onVisible = (): void => {
    if (!disposed && roomId) void refreshHelper();
  };
  document.addEventListener('visibilitychange', onVisible);
}