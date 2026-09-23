import { otherLocale, t } from './i18n';

export function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function qs<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el as T;
}

export function setStatus(el: HTMLElement, text: string, kind: 'ok' | 'error' | 'muted' = 'muted'): void {
  el.textContent = text;
  el.className = `statusline ${kind === 'muted' ? 'muted' : kind}`;
}

export function nav(title = 'golive'): string {
  const toggle = otherLocale() === 'pt-BR' ? 'PT' : 'EN';
  return `
    <nav class="top">
      <span class="brand">${esc(title)}</span>
      <span class="nav-links">
        <a href="#/">${t('nav.home')}</a>
        <span class="sep">·</span>
        <a href="#/host">${t('nav.host')}</a>
        <button class="locale-btn" id="locale-toggle" type="button" title="${t('nav.localeTitle')}">${toggle}</button>
      </span>
    </nav>`;
}

export function loginCard(metaAuth: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>${t('login.title')}</h2>
    <p class="muted">${t('login.sub')}</p>
    <div class="row">
      ${
        metaAuth === 'dev'
          ? `<button class="primary" id="dev-login">${t('login.dev')}</button>`
          : `<a class="btn primary" href="/auth/login">${t('login.discord')}</a>`
      }
    </div>`;
  return card;
}

export function watchLink(roomId: string): string {
  return `#/watch/${encodeURIComponent(roomId)}`;
}