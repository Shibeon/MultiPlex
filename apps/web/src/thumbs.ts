// Aperçus de la barre de lecture du lecteur web, tirés des vignettes que Plex prépare
// (« aperçus vidéo »). Comme Plex Web : une simple image par instant
// (/library/parts/<id>/indexes/sd/<ms>), chargée comme une <img> — aucune restriction entre
// sites, et seule l'image survolée est téléchargée.

/** Pas des aperçus : deux positions voisines partagent la même image (et le même cache). */
const STEP = 5;
const MAX_CACHED = 300;

export type ThumbsState = 'unknown' | 'ok' | 'missing';

export interface Thumbs {
  at(time: number): Promise<string | null>;
  state(): ThumbsState;
  dispose(): void;
}

export function serverThumbs(urlAt: (ms: number) => string): Thumbs {
  let state: ThumbsState = 'unknown';
  let dead = false;
  const cache = new Map<number, Promise<string | null>>();

  const load = (ms: number) =>
    new Promise<string | null>((resolve) => {
      const src = urlAt(ms);
      const img = new Image();
      img.onload = () => {
        state = 'ok';
        resolve(src);
      };
      img.onerror = () => {
        cache.delete(ms);
        // Première image introuvable : ce fichier n'a pas de vignettes, inutile d'insister.
        if (state !== 'ok') {
          state = 'missing';
          dead = true;
        }
        resolve(null);
      };
      img.src = src;
    });

  return {
    at(time) {
      if (dead) return Promise.resolve(null);
      const ms = Math.max(0, Math.round(time / STEP) * STEP * 1000);
      let p = cache.get(ms);
      if (!p) {
        p = load(ms);
        cache.set(ms, p);
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
      }
      return p;
    },
    state: () => state,
    dispose() {
      dead = true;
      cache.clear();
    },
  };
}
