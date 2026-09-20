import { api } from '../api';
import { currentUser, devLogin, ensureUser, setUser } from '../session';
import { nav, qs, esc, watchLink } from '../ui';

export async function renderHome(root: HTMLElement): Promise<void> {
  const user = await ensureUser();
  const meta = await api.meta();

  root.innerHTML = `
    ${nav()}
    <h1>golive</h1>
    <p class="subtitle">AV1 live streaming for small audiences — shared signaling skeleton (M0).</p>

    <div class="card">
      <h2>Identity</h2>
      ${
        user
          ? `<div class="row">
              <span class="grow">Signed in as <strong>${esc(user.username)}</strong>
              <span class="muted mono">(${esc(user.id)})</span></span>
              <button id="logout" class="small">Sign out</button>
            </div>`
          : `<div class="muted">Sign in to create or join rooms.</div>
             <div class="row">
               ${
                 meta.auth === 'dev'
                   ? `<button id="dev-login" class="primary">Dev login</button>`
                   : `<a class="btn primary" href="/auth/login">Log in with Discord</a>`
               }
             </div>`
      }
    </div>

    ${
      user
        ? `
    <div class="card">
      <h2>Create a room</h2>
      <p class="muted">A room is owned by you; only you can connect as its host.</p>
      <button id="create-room" class="primary">Create room</button>
      <div class="statusline muted" id="create-status"></div>
    </div>`
        : ''
    }

    <div class="card">
      <h2>Watch a room</h2>
      <div class="row">
        <input id="room-input" type="text" placeholder="room id (e.g. ab3x9k)" class="grow" />
        <button id="join-room" class="primary">Watch</button>
      </div>
    </div>
  `;

  const devLoginBtn = root.querySelector('#dev-login');
  devLoginBtn?.addEventListener('click', async () => {
    await devLogin();
    renderHome(root);
  });

  const logoutBtn = root.querySelector('#logout');
  logoutBtn?.addEventListener('click', async () => {
    await api.logout();
    setUser(null);
    renderHome(root);
  });

  const createBtn = root.querySelector('#create-room');
  createBtn?.addEventListener('click', async () => {
    const status = qs(root, '#create-status');
    createBtn.setAttribute('disabled', 'true');
    status.textContent = 'Creating room…';
    try {
      const { room } = await api.createRoom();
      status.textContent = '';
      root.innerHTML = `
        ${nav()}
        <div class="card">
          <h2>Room created</h2>
          <div class="mono-box">${esc(room.roomId)}</div>
          <p class="muted">Share this link with viewers:</p>
          <div class="mono-box" id="watch-url">${esc(window.location.origin + '/' + watchLink(room.roomId))}</div>
          <div class="row" style="margin-top:12px">
            <a class="btn primary" href="#/host?room=${esc(room.roomId)}">Open host page</a>
            <button id="copy-link" class="small">Copy link</button>
          </div>
        </div>`;
      const copyBtn = root.querySelector('#copy-link');
      copyBtn?.addEventListener('click', () => {
        const urlEl = qs(root, '#watch-url');
        void navigator.clipboard?.writeText(urlEl.textContent ?? '').catch(() => {});
      });
    } catch (err) {
      status.textContent = `Failed to create room: ${err instanceof Error ? err.message : err}`;
      status.className = 'statusline error';
      createBtn.removeAttribute('disabled');
    }
  });

  const joinBtn = root.querySelector('#join-room');
  const roomInput = root.querySelector('#room-input') as HTMLInputElement | null;
  const go = (): void => {
    const id = roomInput?.value.trim().toLowerCase() ?? '';
    if (id) window.location.hash = watchLink(id);
  };
  joinBtn?.addEventListener('click', go);
  roomInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });
}