import './style.css';
import { renderPage } from './router';

function render(): void {
  const root = document.getElementById('app');
  if (!root) return;
  renderPage(root, window.location.hash.slice(1));
}

window.addEventListener('hashchange', render);
render();