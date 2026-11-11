import { signal } from '@preact/signals';

export interface Route {
  hash: string;
  parts: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const hash = location.hash.slice(1) || '/';
  const [path, qs = ''] = hash.split('?');
  return { hash, parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs) };
}

/** Routage par fragment (#/…) : fonctionne aussi en file:// et dans les paquets TV. */
export const route = signal<Route>(parse());

const scrollPos = new Map<string, number>();
let restoring = false;

addEventListener('popstate', () => (restoring = true));
addEventListener('hashchange', (e) => {
  scrollPos.set(new URL(e.oldURL).hash.slice(1) || '/', scrollY);
  route.value = parse();
  const y = restoring ? (scrollPos.get(route.value.hash) ?? 0) : 0;
  restoring = false;
  // Après le rendu : les pages se réaffichent depuis le cache mémoire.
  requestAnimationFrame(() => scrollTo(0, y));
});

export function go(path: string, replace = false): void {
  if (replace) location.replace(`#${path}`);
  else location.hash = path;
}

export function back(): void {
  if (history.length > 1) history.back();
  else go('/');
}

/**
 * Appelée par la coque native (bouton Retour d'Android) : revient en arrière
 * dans l'app et renvoie false à la racine, pour que le système ferme l'app.
 */
(window as unknown as { multiplexBack: () => boolean }).multiplexBack = () => {
  if (route.value.hash === '/') return false;
  back();
  return true;
};
