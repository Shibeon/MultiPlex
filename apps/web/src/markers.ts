import { imdbIdOf, segmentsToMarkers, type MediaServer, type Metadata } from '@multiplex/core';
import { native } from './native';
import { settings } from './settings';

const skippable = (it: Metadata) => (it.Marker ?? []).some((m) => m.type === 'intro' || m.type === 'credits');

/**
 * Plex ne donne ses repères d'intro et de générique qu'aux comptes Plex Pass. Quand
 * un épisode arrive sans repère, on demande ceux de la base communautaire IntroDB.
 * Renvoie l'élément complété, ou le même élément s'il n'y a rien à ajouter.
 */
export async function withCommunityMarkers(srv: MediaServer, it: Metadata): Promise<Metadata> {
  if (!native?.segments || !settings.value.communityMarkers || it.type !== 'episode' || skippable(it)) return it;
  if (!it.grandparentRatingKey || it.parentIndex == null || it.index == null) return it;
  try {
    const imdb = imdbIdOf(await srv.metadata(it.grandparentRatingKey));
    if (!imdb) return it;
    const found = segmentsToMarkers(await native.segments(imdb, it.parentIndex, it.index));
    return found.length ? { ...it, Marker: [...(it.Marker ?? []), ...found] } : it;
  } catch {
    return it;
  }
}
