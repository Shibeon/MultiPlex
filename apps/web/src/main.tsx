import { render } from 'preact';
import { App } from './app';
import { initNav } from './nav';
import { initSettings } from './settings';
import { boot, status } from './store';
import './styles.css';

initSettings();
initNav();
render(<App />, document.getElementById('app')!);
boot().catch(() => (status.value = 'login'));

if (import.meta.env.PROD && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
