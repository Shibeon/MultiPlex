import { describe, expect, it } from 'vitest';
import { DemoDiscover, PlexDiscover, matchStrength, nameWords, peopleFromDiscover, peopleFromHubs, rankPeople, type ClientInfo, type PersonHit } from '../src';

const client: ClientInfo = { clientId: 'c', product: 'MultiPlex', version: '0', platform: 'Web', device: 'Test', deviceName: 'Test' };

/** Réponse du catalogue, même forme que l'exemple publié avec python-plexapi (ticket 1158). */
const discoverReply = {
  size: 1,
  SearchResults: [
    {
      id: 'people',
      title: 'People',
      size: 2,
      SearchResult: [
        {
          Directory: {
            bornAt: '1996-09-01',
            key: '/library/people/5d7768d2ebdf2200209c916d',
            metadataId: '5d7768d2ebdf2200209c916d',
            slug: 'zendaya',
            thumb: 'https://metadata-static.plex.tv/8/people/868e9505c5a89efc4477e2d4eb1617fb.jpg',
            title: 'Zendaya',
            type: 'person',
            source: 'provider://tv.plex.provider.metadata',
            CreditType: [
              { type: 'actor', count: 98, title: 'Actor' },
              { type: 'producer', count: 23, title: 'Producer' },
              { type: 'music', count: 18, title: 'Composer' },
              { type: 'writer', count: 1, title: 'Writer' },
            ],
          },
          score: 1,
        },
        // Sans `metadataId` : l'identifiant se lit dans `key`.
        { Directory: { key: '/library/people/5f3fe1b2a3c4d5e6f7a8b9c0', title: 'Zendaya Coleman', type: 'person' }, score: 0.4 },
      ],
    },
  ],
};

describe('personnes : lecture des réponses', () => {
  it('lit les personnes du catalogue (élément Directory)', () => {
    const people = peopleFromDiscover(discoverReply);
    expect(people.map((p) => p.key)).toEqual(['5d7768d2ebdf2200209c916d', '5f3fe1b2a3c4d5e6f7a8b9c0']);
    expect(people[0]).toMatchObject({ name: 'Zendaya', score: 1, thumb: 'https://metadata-static.plex.tv/8/people/868e9505c5a89efc4477e2d4eb1617fb.jpg' });
    expect(people[0].jobs.map((j) => `${j.type}:${j.count}`)).toEqual(['actor:98', 'producer:23', 'music:18', 'writer:1']);
  });

  it('ignore sans erreur ce qui ne ressemble pas à une personne', () => {
    for (const odd of [undefined, null, 42, 'x', [], {}, { SearchResults: 'x' }, { SearchResults: [{ SearchResult: [null, 3, {}] }] }]) expect(peopleFromDiscover(odd)).toEqual([]);
    const strange = {
      SearchResults: [
        {
          SearchResult: [
            { Metadata: { type: 'movie', title: 'Dune', key: '/library/metadata/5d776830880197001ec967c4', ratingKey: '5d776830880197001ec967c4' } },
            { Directory: { type: 'person', title: 'Sans clé' } },
            { Directory: { type: 'person', title: 'Clé étrange', key: '/library/people/../../x' } },
            { Directory: { type: 'person', key: '/library/people/5d7768d2ebdf2200209c916d' } },
            // Image en clair (http) : pas affichée.
            { Directory: [{ type: 'person', title: 'Liste', metadataId: '5d7768d2ebdf2200209c9170', thumb: 'http://x/y.jpg' }] },
          ],
        },
      ],
    };
    expect(peopleFromDiscover(strange)).toEqual([{ key: '5d7768d2ebdf2200209c9170', name: 'Liste', thumb: undefined, jobs: [], score: undefined }]);
  });

  it('lit les rangées de personnes du serveur et fusionne les doublons', () => {
    const tag = (over: Record<string, unknown>) => ({ type: 'tag', tagType: 6, tag: 'Christian Bale', tagKey: '5d77682b54f42c001f8c2a5c', thumb: 'https://x/bale.jpg', ...over });
    const hubs = [
      { type: 'movie', hubIdentifier: 'movie', Metadata: [{ ratingKey: '1', title: 'Christian', type: 'movie' }] },
      // Une même personne dans deux bibliothèques, puis comme réalisateur.
      { type: 'actor', hubIdentifier: 'actor', Directory: [tag({ count: 5, librarySectionID: 1 }), tag({ count: 2, librarySectionID: 3 }), tag({ tag: 'Sans clé', tagKey: undefined })] },
      { type: 'director', hubIdentifier: 'director', Directory: [tag({ count: 1 })] },
      { type: 'genre', hubIdentifier: 'genre', Directory: [{ tag: 'Drame', type: 'tag', tagType: 1 }] },
      { type: 'actor', Directory: 'pas une liste' },
      null,
    ];
    expect(peopleFromHubs(hubs)).toEqual([
      {
        key: '5d77682b54f42c001f8c2a5c',
        name: 'Christian Bale',
        thumb: 'https://x/bale.jpg',
        jobs: [
          { type: 'actor', count: 7 },
          { type: 'director', count: 1 },
        ],
        libraryCount: 7,
      },
    ]);
    expect(peopleFromHubs(undefined)).toEqual([]);
  });

  it('interroge le catalogue avec searchTypes=people', async () => {
    const real = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ MediaContainer: discoverReply }), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const people = await new PlexDiscover('tok', client).searchPeople('zendaya');
      expect(people).toHaveLength(2);
      const u = new URL(urls[0]);
      expect([u.origin + u.pathname, u.searchParams.get('query'), u.searchParams.get('searchTypes')]).toEqual(['https://metadata.provider.plex.tv/library/search', 'zendaya', 'people']);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('personnes : classement', () => {
  it('compare les noms sans casse ni accents', () => {
    expect(nameWords('  Inès MOREL-Duval ')).toEqual(['ines', 'morel', 'duval']);
    expect(matchStrength('ines morel', 'Inès Morel')).toBe(3);
    expect(matchStrength('INÈS   MOREL', 'Inès Morel')).toBe(3);
    expect(matchStrength('bale christian', 'Christian Bale')).toBe(2);
    expect(matchStrength('christian', 'Christian Bale')).toBe(1);
    expect(matchStrength('bale', 'Christian Bale')).toBe(1);
    expect(matchStrength('christian ba', 'Christian Bale')).toBe(0);
    expect(matchStrength('chris', 'Christian Bale')).toBe(0);
    expect(matchStrength('batman', 'Christian Bale')).toBe(-1);
    expect(matchStrength('christian christian', 'Christian Bale')).toBe(-1);
    expect(matchStrength('', 'Christian Bale')).toBe(-1);
  });

  const p = (name: string, key: string, over: Partial<PersonHit> = {}): PersonHit => ({ key, name, jobs: [{ type: 'actor' }], ...over });
  const bale = p('Christian Bale', 'k0000000000000001', { score: 0.9, jobs: [{ type: 'actor', title: 'Actor', count: 80 }] });
  const slater = p('Christian Slater', 'k0000000000000002', { score: 0.95 });
  const balian = p('Bale Christianson', 'k0000000000000003');

  it('met en avant le nom complet, devant les films', () => {
    const r = rankPeople('christian bale', [slater, bale, balian]);
    expect(r.featured?.name).toBe('Christian Bale');
    // « Christian Slater » ne correspond pas ; « Bale Christianson » seulement en début de mot.
    expect(r.others.map((x) => x.name)).toEqual(['Bale Christianson']);
  });

  it('un prénom seul ne met personne en avant : les personnes restent en rangée', () => {
    const r = rankPeople('christian', [slater, bale, balian]);
    expect(r.featured).toBeUndefined();
    // Mot entier d'abord, puis la pertinence du catalogue ; « Christianson » (début de mot) après.
    expect(r.others.map((x) => x.name)).toEqual(['Christian Slater', 'Christian Bale', 'Bale Christianson']);
  });

  it('écarte les personnes dont le nom ne correspond pas', () => {
    expect(rankPeople('dune', [slater, bale])).toEqual({ others: [] });
  });

  it('fusionne serveur et catalogue ; à égalité, la bibliothèque passe devant', () => {
    const local = p('Christian Bale', 'k0000000000000001', { thumb: 'https://srv/bale.jpg', libraryCount: 3, jobs: [{ type: 'actor', count: 3 }] });
    const namesake = p('Christian Bale', 'k0000000000000009', { score: 1 });
    const r = rankPeople('Christian Bale', [local], [bale, namesake]);
    expect(r.featured).toEqual({ key: 'k0000000000000001', name: 'Christian Bale', thumb: 'https://srv/bale.jpg', libraryCount: 3, score: 0.9, jobs: [{ type: 'actor', title: 'Actor', count: 80 }] });
    expect(r.others.map((x) => x.key)).toEqual(['k0000000000000009']);
  });

  it('le catalogue de démo connaît Inès Morel, et le serveur de démo aussi', async () => {
    const d = new DemoDiscover();
    expect((await d.searchPeople('Ines Morel')).map((x) => x.name)).toEqual(['Inès Morel']);
    expect(await d.searchPeople('brume')).toEqual([]);
    const r = rankPeople('inès', await d.searchPeople('inès'));
    expect([r.featured, r.others.map((x) => x.name)]).toEqual([undefined, ['Inès Morel', 'Inès Moreau']]);
  });
});
