import type { Library, Metadata } from './types';

/**
 * Disponibilité d'un titre de la liste de suivi sur le serveur Plex de l'utilisateur
 * (sa bibliothèque, pas les services de streaming) :
 * - `available` : il est dans la bibliothèque, on peut le lire ;
 * - `missing` : toutes les vérifications ont abouti et il n'y est pas ;
 * - `unknown` : on n'a pas pu le vérifier (serveur injoignable, erreur, aucun identifiant).
 *
 * La correspondance se fait par identifiants, jamais par titre :
 * 1. l'identifiant Plex (`plex://movie/…`, `plex://show/…`), que le serveur cherche lui-même
 *    (`/library/all?guid=`, ce que fait python-plexapi : `library.search(guid=item.guid)`) ;
 * 2. à défaut, les identifiants externes (`imdb://`, `tmdb://`, `tvdb://`) que le titre porte
 *    dans son tableau `Guid`. Le serveur ne sait pas filtrer sur eux : comme le recommande
 *    python-plexapi (`LibrarySection.getGuid`), on les compare à un index de la bibliothèque
 *    lu avec `includeGuids=1`. Les anciens agents (`com.plexapp.agents.imdb://tt…?lang=fr`)
 *    y sont ramenés à la même forme.
 */
export type Availability = 'available' | 'missing' | 'unknown';

export interface AvailabilityResult {
  state: Availability;
  /** L'élément du serveur, quand le titre est disponible. */
  local?: Metadata;
}

const PLEX = /^plex:\/\/(movie|show)\/[0-9a-z]+$/i;
const LEGACY: [RegExp, string][] = [
  [/^com\.plexapp\.agents\.imdb:\/\/(tt\d+)/i, 'imdb://'],
  [/^com\.plexapp\.agents\.themoviedb:\/\/(\d+)/i, 'tmdb://'],
  [/^com\.plexapp\.agents\.thetvdb:\/\/(\d+)/i, 'tvdb://'],
];

/** Forme commune d'un identifiant (`imdb://tt…`, `tmdb://…`, `tvdb://…`, `plex://…`), ou null. */
export function normalizeGuid(id: string | undefined): string | null {
  if (!id) return null;
  const s = id.trim();
  if (PLEX.test(s)) return s.toLowerCase();
  const ext = /^(imdb|tmdb|tvdb):\/\/([0-9a-z]+)$/i.exec(s);
  if (ext) return `${ext[1].toLowerCase()}://${ext[2].toLowerCase()}`;
  for (const [re, scheme] of LEGACY) {
    const m = re.exec(s);
    if (m) return scheme + m[1].toLowerCase();
  }
  return null;
}

/** Identifiant Plex d'un titre (`plex://movie/…`), s'il en a un. */
export function plexGuid(item: Metadata): string | null {
  const g = normalizeGuid(item.guid);
  return g?.startsWith('plex://') ? g : null;
}

/** Identifiants externes d'un titre (IMDb, TMDB, TVDB), sans doublon. */
export function externalIds(item: Metadata): string[] {
  const ids = [item.guid, ...(item.Guid ?? []).map((g) => g?.id)].map(normalizeGuid);
  return [...new Set(ids.filter((g): g is string => !!g && !g.startsWith('plex://')))];
}

/** Index de la bibliothèque : chaque identifiant (Plex et externes) → l'élément du serveur. */
export function buildGuidIndex(items: Metadata[]): Map<string, Metadata> {
  const index = new Map<string, Metadata>();
  for (const m of items) {
    const plex = plexGuid(m);
    for (const k of [...(plex ? [plex] : []), ...externalIds(m)]) if (!index.has(k)) index.set(k, m);
  }
  return index;
}

/**
 * Ce que les vérifications ont donné :
 * - `byGuid` : recherche par identifiant Plex sur le serveur ; l'élément trouvé, `null` si le
 *   serveur répond qu'il n'y en a pas, une `Error` si la recherche a échoué, absent si elle n'a
 *   pas eu lieu (pas d'identifiant Plex) ;
 * - `index` : index de la bibliothèque (identifiants externes) ; une `Error` s'il n'a pas pu
 *   être lu, absent s'il n'a pas été consulté.
 */
export interface AvailabilityProbe {
  byGuid?: Metadata | null | Error;
  index?: Map<string, Metadata> | Error;
}

/** Faut-il consulter l'index de la bibliothèque (le titre n'a pas été trouvé par son identifiant Plex) ? */
export function needsIndex(item: Metadata, byGuid: AvailabilityProbe['byGuid']): boolean {
  return !(byGuid && !(byGuid instanceof Error)) && externalIds(item).length > 0;
}

export function resolveAvailability(item: Metadata, probe: AvailabilityProbe): AvailabilityResult {
  const { byGuid, index } = probe;
  if (byGuid && !(byGuid instanceof Error)) return { state: 'available', local: byGuid };
  const ext = externalIds(item);
  if (index instanceof Map) {
    for (const id of ext) {
      const hit = index.get(id);
      if (hit) return { state: 'available', local: hit };
    }
  }
  const plex = plexGuid(item);
  // Rien d'autre à vérifier : sans aucun identifiant, on ne peut pas savoir.
  if (!plex && !ext.length) return { state: 'unknown' };
  // Une vérification a échoué, ou n'a pas eu lieu : on ne peut pas affirmer l'absence.
  if (plex && byGuid !== null) return { state: 'unknown' };
  if (ext.length && !(index instanceof Map)) return { state: 'unknown' };
  return { state: 'missing' };
}

/** Rang pour le tri « par disponibilité » : disponibles, puis à vérifier, puis absents. */
const RANK: Record<Availability, number> = { available: 0, unknown: 1, missing: 2 };

/**
 * Filtre « disponibles uniquement » et tri « par disponibilité » de la liste de suivi. Le tri
 * est stable : à disponibilité égale, l'ordre de la liste (celui de l'utilisateur) est gardé.
 * Sans filtre ni tri, la liste revient telle quelle. Un titre encore en cours de vérification
 * (`undefined`) compte comme « à vérifier ».
 */
export function arrangeByAvailability<T>(items: T[], stateOf: (item: T) => Availability | undefined, opts: { onlyAvailable?: boolean; byAvailability?: boolean }): T[] {
  let out = opts.onlyAvailable ? items.filter((m) => stateOf(m) === 'available') : items.slice();
  if (opts.byAvailability) {
    const rank = (m: T) => RANK[stateOf(m) ?? 'unknown'];
    out = out.map((m, i) => ({ m, i, r: rank(m) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.m);
  }
  return out;
}

/**
 * Empreinte des bibliothèques de films et de séries : elle change quand le serveur les analyse
 * ou que leur contenu change (horodatages de `/library/sections`). Quand elle change, les
 * disponibilités déjà vérifiées sont à revoir.
 */
export function libraryStamp(libraries: Library[]): string {
  return libraries
    .filter((l) => l.type === 'movie' || l.type === 'show')
    .map((l) => `${l.key}:${l.updatedAt ?? ''}:${l.scannedAt ?? ''}:${l.contentChangedAt ?? ''}`)
    .sort()
    .join('|');
}
