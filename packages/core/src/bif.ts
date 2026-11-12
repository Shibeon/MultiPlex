// Vignettes d'aperçu de Plex (« aperçus vidéo » générés par le serveur) : un fichier BIF par
// film, servi sous /library/parts/<id>/indexes/sd. Format : un en-tête de 64 octets, un index
// de paires (instant, position) sur 32 bits little-endian, puis les images JPEG bout à bout.

export interface BifIndex {
  /** Instant de chaque image, en secondes, croissant. */
  times: number[];
  /** Position de chaque image dans le fichier : l'image i va de offsets[i] à offsets[i + 1]. */
  offsets: number[];
}

const MAGIC = [0x89, 0x42, 0x49, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
export const BIF_HEADER = 64;

/** Nombre d'images annoncé par l'en-tête (pour savoir quelle longueur d'index lire). */
export function bifCount(head: ArrayBuffer): number {
  const b = new Uint8Array(head);
  if (b.length < BIF_HEADER || MAGIC.some((m, i) => b[i] !== m)) throw new Error('fichier BIF invalide');
  return new DataView(head).getUint32(12, true);
}

/** Lit l'index d'un BIF (au moins l'en-tête et l'index, le reste peut manquer). */
export function parseBifIndex(buf: ArrayBuffer): BifIndex {
  const count = bifCount(buf);
  const view = new DataView(buf);
  // Intervalle entre deux images en millisecondes ; 0 signifie 1000.
  const unit = view.getUint32(16, true) || 1000;
  const times: number[] = [];
  const offsets: number[] = [];
  for (let i = 0; i <= count; i++) {
    const at = BIF_HEADER + i * 8;
    if (at + 8 > buf.byteLength) break;
    const t = view.getUint32(at, true);
    const off = view.getUint32(at + 4, true);
    // La dernière entrée (0xFFFFFFFF) ne porte que la fin de la dernière image.
    if (t === 0xffffffff || i === count) {
      offsets.push(off);
      break;
    }
    times.push((t * unit) / 1000);
    offsets.push(off);
  }
  if (offsets.length !== times.length + 1) throw new Error('index BIF incomplet');
  return { times, offsets };
}

/** Image la plus proche avant `time` (secondes), ou -1. */
export function bifFrameAt(index: BifIndex, time: number): number {
  let lo = 0;
  let hi = index.times.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.times[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
