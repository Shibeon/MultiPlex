// Aperçus de la barre de lecture du lecteur web, tirés des vignettes que Plex prépare
// (« aperçus vidéo »). Le fichier peut peser plusieurs dizaines de Mo : on n'en lit que
// l'index, puis chaque image survolée, par requêtes partielles (Range). Si le serveur les
// ignore, le fichier est lu une fois en entier.
import { BIF_HEADER, bifCount, bifFrameAt, parseBifIndex, type BifIndex } from '@multiplex/core';

const MAX_CACHED = 300;

export interface Thumbs {
  at(time: number): Promise<string | null>;
  dispose(): void;
}

export function bifThumbs(url: string): Thumbs {
  let index: Promise<BifIndex | null> | null = null;
  let whole: ArrayBuffer | null = null;
  let dead = false;
  const cache = new Map<number, Promise<string | null>>();

  const range = async (from: number, to: number): Promise<ArrayBuffer> => {
    const r = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    // Réponse entière (pas de prise en charge des requêtes partielles) : on la garde.
    if (r.status === 200) whole = buf;
    return r.status === 200 ? buf.slice(from, to + 1) : buf;
  };

  const load = async (): Promise<BifIndex | null> => {
    try {
      let head = await range(0, 65535);
      const need = BIF_HEADER + (bifCount(head) + 1) * 8;
      if (!whole && head.byteLength < need) head = await range(0, need - 1);
      return parseBifIndex(whole ?? head);
    } catch {
      dead = true; // pas de vignettes pour ce fichier : on n'insiste pas
      return null;
    }
  };

  const frame = (idx: BifIndex, i: number): Promise<string | null> => {
    let p = cache.get(i);
    if (p) return p;
    const start = idx.offsets[i];
    const end = idx.offsets[i + 1] - 1;
    p = (whole ? Promise.resolve(whole.slice(start, end + 1)) : range(start, end))
      .then((bytes) => URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })))
      .catch(() => {
        cache.delete(i);
        return null;
      });
    cache.set(i, p);
    if (cache.size > MAX_CACHED) {
      const oldest = cache.keys().next().value!;
      void cache.get(oldest)?.then((u) => u && URL.revokeObjectURL(u));
      cache.delete(oldest);
    }
    return p;
  };

  return {
    async at(time) {
      if (dead) return null;
      const idx = await (index ??= load());
      if (!idx) return null;
      const i = bifFrameAt(idx, time);
      return i < 0 ? null : frame(idx, i);
    },
    dispose() {
      dead = true;
      for (const p of cache.values()) void p.then((u) => u && URL.revokeObjectURL(u));
      cache.clear();
      whole = null;
    },
  };
}
