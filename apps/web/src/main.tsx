import { render } from 'preact';
import { App } from './app';
import { isOverlayWindow } from './native';
import { initNav } from './nav';
import { NativeOverlay } from './pages/NativeOverlay';
import { initSettings } from './settings';
import { boot, status } from './store';
import './styles.css';

initSettings();

if (isOverlayWindow) {
  // Fenêtre transparente posée sur la vidéo du lecteur natif : uniquement les commandes,
  // sans connexion au serveur (la fenêtre principale s'en charge).
  document.documentElement.classList.add('overlay-window');
  render(<NativeOverlay />, document.getElementById('app')!);
} else {
  initNav();
  render(<App />, document.getElementById('app')!);
  boot().catch(() => (status.value = 'login'));

  if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}
