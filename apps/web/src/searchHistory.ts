// Historique des recherches. Plex ne publie pas d'historique de recherche lié au compte : il est
// donc gardé sur cet appareil, à part pour chaque utilisateur (Plex Home compris), et partagé
// entre les fenêtres de l'application. Le réglage « searchHistory » permet de ne rien garder.
import { computed, signal } from '@preact/signals';
import { load, save, settings } from './settings';
import { auth } from './store';

const MAX = 12;
const keyOf = () => `mp.searches.${auth.value?.user?.uuid || auth.value?.user?.id || 'local'}`;

const version = signal(0);
addEventListener('storage', (e) => {
  if (e.key?.startsWith('mp.searches.')) version.value++;
});

export const searchHistory = computed<string[]>(() => {
  void version.value;
  if (!settings.value.searchHistory) return [];
  const list = load<unknown>(keyOf());
  return Array.isArray(list) ? list.filter((q): q is string => typeof q === 'string').slice(0, MAX) : [];
});

const write = (list: string[]) => {
  save(keyOf(), list.length ? list.slice(0, MAX) : null);
  version.value++;
};

/** Garde une recherche (la plus récente en tête, sans doublon, sans tenir compte des majuscules). */
export function rememberSearch(query: string): void {
  const q = query.trim().replace(/\s+/g, ' ').slice(0, 100);
  if (q.length < 2 || !settings.value.searchHistory) return;
  write([q, ...searchHistory.value.filter((x) => x.toLowerCase() !== q.toLowerCase())]);
}

export function forgetSearch(query: string): void {
  write(searchHistory.value.filter((x) => x !== query));
}

export function clearSearches(): void {
  write([]);
}
