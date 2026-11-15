import { describe, expect, it } from 'vitest';
import {
  DemoDiscover,
  DemoServer,
  arrangeByAvailability,
  buildGuidIndex,
  externalIds,
  libraryStamp,
  needsIndex,
  normalizeGuid,
  plexGuid,
  resolveAvailability,
  type Availability,
  type Metadata,
} from '../src';
import { DEMO_LINKED } from '../src/demo';

const item = (over: Partial<Metadata>): Metadata => ({ ratingKey: 'k', type: 'movie', title: 'T', ...over }) as Metadata;
const local = item({ ratingKey: '42', guid: 'plex://movie/5d776b59ad5437001f79c6f8', Guid: [{ id: 'imdb://tt0111161' }, { id: 'tmdb://278' }] });

describe('identifiants', () => {
  it('ramène les identifiants à une forme commune, anciens agents compris', () => {
    expect(normalizeGuid('plex://movie/5D776B59AD5437001F79C6F8')).toBe('plex://movie/5d776b59ad5437001f79c6f8');
    expect(normalizeGuid('tmdb://278')).toBe('tmdb://278');
    expect(normalizeGuid('IMDB://tt0111161')).toBe('imdb://tt0111161');
    expect(normalizeGuid('com.plexapp.agents.imdb://tt0111161?lang=fr')).toBe('imdb://tt0111161');
    expect(normalizeGuid('com.plexapp.agents.themoviedb://278?lang=en')).toBe('tmdb://278');
    expect(normalizeGuid('com.plexapp.agents.thetvdb://121361?lang=en')).toBe('tvdb://121361');
    expect(normalizeGuid('local://12')).toBeNull();
    expect(normalizeGuid('plex://episode/5d9c')).toBeNull();
    expect(normalizeGuid(undefined)).toBeNull();
  });
  it('sépare l’identifiant Plex des identifiants externes', () => {
    expect(plexGuid(local)).toBe('plex://movie/5d776b59ad5437001f79c6f8');
    expect(externalIds(local)).toEqual(['imdb://tt0111161', 'tmdb://278']);
    expect(externalIds(item({ guid: 'com.plexapp.agents.imdb://tt1?lang=fr', Guid: [{ id: 'imdb://tt1' }] }))).toEqual(['imdb://tt1']);
  });
  it('index de la bibliothèque : chaque identifiant mène à l’élément du serveur', () => {
    const idx = buildGuidIndex([local, item({ ratingKey: '7', guid: 'com.plexapp.agents.thetvdb://121361?lang=en' })]);
    expect(idx.get('tmdb://278')?.ratingKey).toBe('42');
    expect(idx.get('plex://movie/5d776b59ad5437001f79c6f8')?.ratingKey).toBe('42');
    expect(idx.get('tvdb://121361')?.ratingKey).toBe('7');
  });
});

describe('disponibilité d’un titre de la liste de suivi', () => {
  const wanted = item({ guid: 'plex://movie/aaaaaaaaaaaaaaaaaaaaaaaa', Guid: [{ id: 'tmdb://278' }] });
  const plexOnly = item({ guid: 'plex://movie/bbbbbbbbbbbbbbbbbbbbbbbb' });
  const index = buildGuidIndex([local]);

  it('trouvé par identifiant Plex : disponible', () => {
    expect(resolveAvailability(plexOnly, { byGuid: local })).toEqual({ state: 'available', local });
    expect(needsIndex(wanted, local)).toBe(false);
  });
  it('pas trouvé par identifiant Plex, mais par identifiant externe : disponible', () => {
    expect(needsIndex(wanted, null)).toBe(true);
    expect(resolveAvailability(wanted, { byGuid: null, index })).toEqual({ state: 'available', local });
    // Même si la recherche par identifiant Plex a échoué, l’identifiant externe suffit.
    expect(resolveAvailability(wanted, { byGuid: new Error('x'), index }).state).toBe('available');
  });
  it('toutes les vérifications ont abouti sans rien trouver : non disponible', () => {
    expect(resolveAvailability(plexOnly, { byGuid: null })).toEqual({ state: 'missing' });
    expect(resolveAvailability(wanted, { byGuid: null, index: new Map() })).toEqual({ state: 'missing' });
    expect(needsIndex(plexOnly, null)).toBe(false);
  });
  it('erreur ou vérification manquante : à vérifier, jamais « non disponible »', () => {
    expect(resolveAvailability(plexOnly, { byGuid: new Error('injoignable') }).state).toBe('unknown');
    expect(resolveAvailability(plexOnly, {}).state).toBe('unknown');
    expect(resolveAvailability(wanted, { byGuid: null, index: new Error('injoignable') }).state).toBe('unknown');
    expect(resolveAvailability(wanted, { byGuid: null }).state).toBe('unknown');
    expect(resolveAvailability(wanted, { byGuid: new Error('x'), index: new Map() }).state).toBe('unknown');
    // Aucun identifiant exploitable : on ne devine pas d’après le titre.
    expect(resolveAvailability(item({ title: 'Les Évadés' }), { byGuid: null, index }).state).toBe('unknown');
  });
});

describe('filtre et tri de la liste de suivi', () => {
  const list = ['a', 'b', 'c', 'd', 'e', 'f'];
  const states: Record<string, Availability | undefined> = { a: 'missing', b: 'available', c: 'unknown', d: 'available', e: undefined, f: 'missing' };
  const of = (x: string) => states[x];

  it('sans filtre ni tri, l’ordre de la liste est gardé', () => {
    expect(arrangeByAvailability(list, of, {})).toEqual(list);
    expect(arrangeByAvailability(list, of, {})).not.toBe(list);
  });
  it('« disponibles uniquement » garde l’ordre de la liste', () => {
    expect(arrangeByAvailability(list, of, { onlyAvailable: true })).toEqual(['b', 'd']);
  });
  it('tri par disponibilité : disponibles, à vérifier (et en cours), absents ; ordre de la liste à égalité', () => {
    expect(arrangeByAvailability(list, of, { byAvailability: true })).toEqual(['b', 'd', 'c', 'e', 'a', 'f']);
    expect(list).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('empreinte des bibliothèques', () => {
  it('change quand une bibliothèque de films ou de séries est analysée', () => {
    const libs = [
      { key: '1', title: 'Films', type: 'movie', updatedAt: 1, scannedAt: 10 },
      { key: '2', title: 'Musique', type: 'artist', scannedAt: 5 },
    ];
    const a = libraryStamp(libs);
    expect(libraryStamp([libs[1], libs[0]])).toBe(a);
    expect(libraryStamp([{ ...libs[0], scannedAt: 11 }, libs[1]])).not.toBe(a);
    expect(libraryStamp([libs[0], { ...libs[1], scannedAt: 6 }])).toBe(a);
  });
});

describe('liste de suivi de démonstration', () => {
  it('contient un titre disponible par identifiant Plex, un par TMDB, un injoignable et des absents', async () => {
    const d = new DemoDiscover();
    const srv = new DemoServer();
    const { items } = await d.watchlist(0, 50);
    const index = buildGuidIndex(await srv.libraryGuids());
    const states = await Promise.all(
      items.map(async (m) => {
        const byGuid = await srv.findByGuid(m.guid!).then((x) => x ?? null, (e: Error) => e);
        return resolveAvailability(m, { byGuid, index: needsIndex(m, byGuid) ? index : undefined }).state;
      }),
    );
    expect(states).toEqual(['missing', 'available', 'missing', 'unknown', 'available', 'missing']);
    expect(items[3].guid).toBe(DEMO_LINKED.unreachable.guid);
  });
});
