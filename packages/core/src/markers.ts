import type { Marker, Metadata } from './types';

/**
 * Repères d'intro et de générique venus d'IntroDB (introdb.app), base communautaire
 * libre. Plex ne fournit ses propres repères qu'aux comptes Plex Pass : pour les
 * autres, c'est le seul moyen de proposer « Passer l'intro ».
 */
export interface IntroDbSegment {
  start_sec?: number;
  end_sec?: number;
}
export interface IntroDbSegments {
  intro?: IntroDbSegment | null;
  outro?: IntroDbSegment | null;
}

/** Identifiant IMDb d'un élément (« tt0903747 »), ou null. */
export function imdbIdOf(item: Pick<Metadata, 'Guid' | 'guid'> | undefined): string | null {
  for (const g of [...(item?.Guid ?? []).map((x) => x.id), item?.guid ?? '']) {
    const m = /imdb:\/\/(tt\d{5,10})/.exec(g);
    if (m) return m[1];
  }
  return null;
}

/** Convertit une réponse d'IntroDB en repères au format de Plex (millisecondes). */
export function segmentsToMarkers(seg: IntroDbSegments | null | undefined): Marker[] {
  const out: Marker[] = [];
  const add = (type: string, s: IntroDbSegment | null | undefined) => {
    const start = Number(s?.start_sec);
    const end = Number(s?.end_sec);
    // Un repère d'au moins trois secondes, dans le bon sens : le reste est une erreur de saisie.
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end - start >= 3) out.push({ type, startTimeOffset: Math.round(start * 1000), endTimeOffset: Math.round(end * 1000) });
  };
  add('intro', seg?.intro);
  add('credits', seg?.outro);
  return out;
}
