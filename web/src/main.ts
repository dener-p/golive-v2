import './style.css';
import { renderPage } from './router';
import { locale, otherLocale, setLocale } from './i18n';

document.documentElement.lang = locale();

// Nav locale toggle → persist + re-render everything in the new language. The
// toggle lives in `nav()`, which re-renders on every route change, so listen
// on the document instead of binding a fresh listener per render.
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement | null)?.closest?.('#locale-toggle')) {
    e.preventDefault();
    setLocale(otherLocale());
    window.location.reload();
  }
});

function render(): void {
  const root = document.getElementById('app');
  if (!root) return;
  renderPage(root, window.location.hash.slice(1));
}

window.addEventListener('hashchange', render);
render();