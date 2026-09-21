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
  return `
    <nav class="top">
      <span class="brand">${title}</span>
      <span><a href="#/">home</a> · <a href="#/host">host</a></span>
    </nav>`;
}

export function loginCard(metaAuth: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <h2>Sign in to host</h2>
    <p class="muted">Only hosts sign in — it identifies the room owner. Viewers just open the room link.</p>
    <div class="row">
      ${
        metaAuth === 'dev'
          ? `<button class="primary" id="dev-login">Dev login (no Discord configured)</button>`
          : `<a class="btn primary" href="/auth/login">Log in with Discord</a>`
      }
    </div>`;
  return card;
}

export function watchLink(roomId: string): string {
  return `#/watch/${encodeURIComponent(roomId)}`;
}