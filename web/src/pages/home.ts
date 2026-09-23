import { api } from '../api';
import { devLogin, ensureUser, setUser } from '../session';
import { nav, qs, esc, watchLink } from '../ui';
import { t } from '../i18n';

export async function renderHome(root: HTMLElement): Promise<void> {
  const user = await ensureUser();
  const meta = await api.meta();

  root.innerHTML = `
    ${nav()}
    <h1>golive</h1>
    <p class="subtitle">${t('home.subtitle')}</p>

    <div class="card">
      <h2>${t('home.identity')}</h2>
      ${
        user
          ? `<div class="row">
              <span class="grow">${t('home.signedInAs')} <strong>${esc(user.username)}</strong>
              <span class="muted mono">(${esc(user.id)})</span></span>
              <button id="logout" class="small">${t('home.signOut')}</button>
            </div>`
          : `<div class="muted">${t('home.signedOutHint')}</div>
             <div class="row">
               ${
                 meta.auth === 'dev'
                   ? `<button id="dev-login" class="primary">${t('home.devLogin')}</button>`
                   : `<a class="btn primary" href="/auth/login">${t('home.discordLogin')}</a>`
               }
             </div>`
      }
    </div>

    ${
      user
        ? `
    <div class="card">
      <h2>${t('home.hostTitle')}</h2>
      <p class="muted">${t('home.hostSub')}</p>
      <button id="create-room" class="primary">${t('home.createRoom')}</button>
      <div class="statusline muted" id="create-status"></div>
    </div>`
        : ''
    }

    <div class="card">
      <h2>${t('home.watchTitle')}</h2>
      <div class="row">
        <input id="room-input" type="text" placeholder="${t('home.roomPlaceholder')}" class="grow" />
        <button id="join-room" class="primary">${t('home.watch')}</button>
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
    status.textContent = t('home.creating');
    try {
      const { room } = await api.createRoom();
      status.textContent = '';
      root.innerHTML = `
        ${nav()}
        <div class="card">
          <h2>${t('home.roomCreated')}</h2>
          <div class="mono-box room-code">${esc(room.roomId)}</div>
          <p class="muted">${t('home.shareLink')}</p>
          <div class="mono-box" id="watch-url">${esc(window.location.origin + '/' + watchLink(room.roomId))}</div>
          <div class="row" style="margin-top:12px">
            <a class="btn primary" href="#/host?room=${esc(room.roomId)}">${t('home.openHostPage')}</a>
            <button id="copy-link" class="small">${t('home.copyLink')}</button>
          </div>
        </div>`;
      const copyBtn = root.querySelector('#copy-link');
      copyBtn?.addEventListener('click', () => {
        const urlEl = qs(root, '#watch-url');
        void navigator.clipboard?.writeText(urlEl.textContent ?? '').catch(() => {});
      });
    } catch (err) {
      status.textContent = t('home.createFailed', {
        err: err instanceof Error ? err.message : String(err),
      });
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