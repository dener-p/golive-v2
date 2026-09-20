import { renderHome } from './pages/home';
import { renderHost } from './pages/host';
import { renderWatch } from './pages/watch';

export function renderPage(root: HTMLElement, hash: string): void {
  const raw = (hash || '/').split('?')[0] || '/';
  const query = new URLSearchParams((hash.split('?')[1] ?? '').toString());
  const path = decodeURIComponent(raw);

  root.innerHTML = '';

  if (path === '/host') {
    renderHost(root, query);
    return;
  }
  if (path.startsWith('/watch/')) {
    renderWatch(root, path.slice('/watch/'.length));
    return;
  }
  renderHome(root);
}