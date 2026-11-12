import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpError, PlexServer, type ClientInfo } from '../src';

/**
 * Faux Plex Media Server : répond comme un PMS sur les routes utilisées et
 * enregistre chaque requête, pour vérifier ce que le client envoie réellement.
 * Il valide notre code, pas le comportement d'un vrai serveur.
 */
const client: ClientInfo = { clientId: 'cid', product: 'MultiPlex', version: '0.1', platform: 'Chrome', device: 'Test', deviceName: 'Test' };
const TOKEN = 'secret-token';
const log: { method: string; path: string; q: URLSearchParams; headers: Record<string, unknown> }[] = [];

const movie = {
  ratingKey: '10',
  type: 'movie',
  title: 'Film',
  duration: 6000000,
  Media: [
    {
      id: 1,
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      Part: [
        {
          id: 77,
          key: '/library/parts/77/123/file.mp4',
          container: 'mp4',
          Stream: [
            { id: 1, streamType: 1, codec: 'h264' },
            { id: 2, streamType: 2, codec: 'aac', selected: true },
            { id: 3, streamType: 3, codec: 'srt', key: '/library/streams/3' },
            { id: 4, streamType: 3, codec: 'ass' },
          ],
        },
      ],
    },
  ],
  Marker: [{ type: 'intro', startTimeOffset: 1000, endTimeOffset: 30000 }],
};

const routes: Record<string, (q: URLSearchParams) => unknown> = {
  '/library/sections': () => ({ Directory: [{ key: '1', title: 'Films', type: 'movie' }] }),
  '/hubs': () => ({ Hub: [{ hubIdentifier: 'home.continue', title: 'Continuer', type: 'mixed', Metadata: [movie] }, { hubIdentifier: 'vide', title: 'Vide', type: 'movie' }] }),
  '/hubs/sections/1': () => ({ Hub: [] }),
  '/library/sections/1/all': (q) => ({ totalSize: 500, size: 2, Metadata: [{ ...movie, title: `#${q.get('X-Plex-Container-Start')}` }, movie] }),
  '/library/metadata/10': () => ({ Metadata: [movie] }),
  '/library/metadata/404': () => ({}),
  '/library/metadata/20/children': () => ({ Metadata: [movie] }),
  '/library/all': (q) => ({ Metadata: q.get('guid') === 'plex://movie/aaaaaaaaaaaaaaaaaaaaaaaa' ? [movie] : [] }),
  '/hubs/search': () => ({ Hub: [{ hubIdentifier: 'movie', title: 'Films', type: 'movie', Metadata: [movie] }] }),
  '/:/timeline': () => ({}),
  '/status/sessions': () => ({
    Metadata: [
      { ...movie, viewOffset: 600000, sessionKey: '5', User: { title: 'Ami', thumb: 'https://exemple.test/a.png' }, Player: { state: 'paused', title: 'Salon', platform: 'Android' }, Session: { id: 'abc' }, TranscodeSession: { videoDecision: 'copy', audioDecision: 'transcode' } },
      { ...movie, ratingKey: '11', sessionKey: '6', Player: { product: 'Plex Web' } },
    ],
  }),
  '/:/scrobble': () => ({}),
  '/library/metadata/10/extras': () => ({ Metadata: [{ ratingKey: '91', type: 'clip', extraType: 5, title: 'Coulisses' }, { ratingKey: '92', type: 'clip', extraType: 1, subtype: 'trailer', title: 'Bande-annonce' }] }),
  '/actions/removeFromContinueWatching': () => ({}),
  '/hubs/continueWatching': () => ({ Hub: [{ hubIdentifier: 'continueWatching', title: 'Continuer', type: 'mixed', Metadata: [movie] }] }),
  '/playlists': () => ({ Metadata: [{ ratingKey: '300', type: 'playlist', title: 'Soirée' }, { ratingKey: '301', type: 'playlist', title: 'Récents', smart: 1 }] }),
  '/playlists/300/items': () => ({ Metadata: [movie] }),
  '/:/unscrobble': () => ({}),
  '/library/parts/77': () => ({}),
  '/video/:/transcode/universal/stop': () => ({}),
  '/video/:/transcode/universal/decision': (q) =>
    q.get('path') === '/library/metadata/66'
      ? { generalDecisionCode: 2001, generalDecisionText: 'Conversion impossible' }
      : {
          generalDecisionCode: 1001,
          Metadata: [
            {
              Media: [
                {
                  Part: [
                    {
                      Stream: [
                        // Le faux serveur ne copie la vidéo que si le HEVC est proposé et qu'aucun débit n'est imposé.
                        { streamType: 1, decision: String(q.get('X-Plex-Client-Profile-Extra')).includes('hevc') && q.get('path') !== '/library/metadata/77' ? 'copy' : 'transcode' },
                        { streamType: 2, decision: 'transcode' },
                        ...(q.get('subtitles') === 'auto' ? [{ streamType: 3, decision: 'transcode', location: 'segments-subs' }] : []),
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
};

let http: Server;
let srv: PlexServer;
let base = '';

beforeAll(async () => {
  http = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    log.push({ method: req.method!, path: url.pathname, q: url.searchParams, headers: req.headers });
    const route = routes[url.pathname];
    if (url.searchParams.get('X-Plex-Token') !== TOKEN) return void res.writeHead(401).end();
    if (!route) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ MediaContainer: route(url.searchParams) }));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  srv = new PlexServer('id', 'Test', base, TOKEN, client);
});
afterAll(() => new Promise((r) => http.close(r)));

const last = () => log[log.length - 1];
const yes = () => true;

describe('PlexServer contre un faux PMS', () => {
  it('menu d’un titre : bande-annonce, continuer à regarder, listes de lecture', async () => {
    expect(await srv.trailer('10')).toBe('92');
    expect((await srv.continueWatching()).map((m) => m.ratingKey)).toEqual(['10']);
    await srv.removeFromContinueWatching('10');
    expect([last().method, last().path, last().q.get('ratingKey')]).toEqual(['PUT', '/actions/removeFromContinueWatching', '10']);
    expect((await srv.playlists()).map((p) => p.title)).toEqual(['Soirée']);
    expect(last().q.get('playlistType')).toBe('video');
    expect(await srv.playlistItems('300')).toHaveLength(1);
    await srv.addToPlaylist('300', '10');
    expect([last().method, last().path, last().q.get('uri')]).toEqual(['PUT', '/playlists/300/items', 'server://id/com.plexapp.plugins.library/library/metadata/10']);
    await srv.addToPlaylist(null, '10', 'Ciné du dimanche');
    expect([last().method, last().path, last().q.get('title'), last().q.get('type'), last().q.get('smart')]).toEqual(['POST', '/playlists', 'Ciné du dimanche', 'video', '0']);
  });

  it('authentifie chaque requête sans en-tête personnalisé (pas de pré-requête CORS)', async () => {
    expect(await srv.libraries()).toEqual([{ key: '1', title: 'Films', type: 'movie' }]);
    expect(last().q.get('X-Plex-Client-Identifier')).toBe('cid');
    expect(last().headers.accept).toBe('application/json');
    expect(Object.keys(last().headers).filter((h) => h.startsWith('x-plex'))).toEqual([]);
  });

  it('écarte les rangées vides', async () => {
    expect((await srv.hubs()).map((h) => h.hubIdentifier)).toEqual(['home.continue']);
    expect(await srv.hubs('1')).toEqual([]);
    expect(last().path).toBe('/hubs/sections/1');
  });

  it('pagine une bibliothèque', async () => {
    const page = await srv.items('1', { type: 1, sort: 'addedAt:desc', offset: 240, limit: 120, filter: { unwatched: 1 } });
    expect([page.total, page.offset, page.items[0].title]).toEqual([500, 240, '#240']);
    const q = last().q;
    expect([q.get('type'), q.get('sort'), q.get('X-Plex-Container-Size'), q.get('unwatched')]).toEqual(['1', 'addedAt:desc', '120', '1']);
  });

  it('charge une fiche avec ses marqueurs, ses enfants, la recherche', async () => {
    expect((await srv.metadata('10')).Marker?.[0].type).toBe('intro');
    expect(last().q.get('includeMarkers')).toBe('1');
    await expect(srv.metadata('404')).rejects.toThrow('introuvable');
    expect(await srv.children('20')).toHaveLength(1);
    expect(await srv.search('fil m&x')).toHaveLength(1);
    expect(last().q.get('query')).toBe('fil m&x');
  });

  it('retrouve un élément par son identifiant Plex universel', async () => {
    expect((await srv.findByGuid('plex://movie/aaaaaaaaaaaaaaaaaaaaaaaa'))?.ratingKey).toBe('10');
    expect(last().q.get('guid')).toBe('plex://movie/aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(await srv.findByGuid('plex://movie/bbbbbbbbbbbbbbbbbbbbbbbb')).toBeUndefined();
  });

  it('ne divulgue pas le jeton dans les erreurs', async () => {
    const err = await srv.children('999').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('refuse un mauvais jeton', async () => {
    const bad = new PlexServer('id', 'Test', base, 'faux', client);
    await expect(bad.libraries()).rejects.toMatchObject({ status: 401 });
  });

  it('construit les URL d’images', () => {
    const u = new URL(srv.image('/library/metadata/10/thumb/1', 320, 480));
    expect([u.pathname, u.searchParams.get('url'), u.searchParams.get('width'), u.searchParams.get('X-Plex-Token')]).toEqual(['/photo/:/transcode', '/library/metadata/10/thumb/1', '320', TOKEN]);
    expect(srv.image(undefined, 1, 1)).toBe('');
    // Lecteur natif : le jeton part en en-tête, l'adresse n'en contient aucune trace.
    const file = srv.fileRequest('/library/parts/77/123/file.mkv');
    expect(file.url).toBe(`${base}/library/parts/77/123/file.mkv`);
    expect(file.url).not.toContain(TOKEN);
    expect(file.headers['X-Plex-Token']).toBe(TOKEN);
    expect(srv.image('https://exemple.test/a.jpg', 1, 1)).toBe('https://exemple.test/a.jpg');
  });

  it('lecture directe : URL du fichier et sous-titres externes', async () => {
    const plan = await srv.playback(movie, { quality: 'original', canPlay: yes, audioStreamId: 2, subtitleStreamId: 3 });
    expect([plan.mode, plan.subtitle]).toEqual(['direct', 'sidecar']);
    expect(new URL(plan.url).pathname).toBe('/library/parts/77/123/file.mp4');
    expect(new URL(plan.subtitleUrl!).pathname).toBe('/library/streams/3');
  });

  it('transcodage : URL HLS complète', async () => {
    const plan = await srv.playback(movie, { quality: '4000', canPlay: yes });
    // La décision est demandée avant le démarrage, avec la même session.
    expect([last().path, last().q.get('session'), last().q.get('maxVideoBitrate')]).toEqual(['/video/:/transcode/universal/decision', plan.session, '4000']);
    await expect(srv.playback({ ...movie, ratingKey: '66' }, { quality: '4000', canPlay: yes })).rejects.toThrow('Conversion impossible');
    const u = new URL(plan.url);
    const q = u.searchParams;
    expect(plan.mode).toBe('hls');
    expect(u.pathname).toBe('/video/:/transcode/universal/start.m3u8');
    expect([q.get('path'), q.get('protocol'), q.get('maxVideoBitrate'), q.get('session')]).toEqual(['/library/metadata/10', 'hls', '4000', plan.session]);
    expect(q.get('X-Plex-Token')).toBe(TOKEN);
    expect([q.get('X-Plex-Platform'), q.get('X-Plex-Device'), plan.video, String(q.get('X-Plex-Client-Profile-Extra')).includes('hevc')]).toEqual(['MultiPlex', 'Windows', 'transcode', false]);

    // Qualité d'origine + navigateur HEVC : la vidéo est copiée, les sous-titres texte livrés à part.
    const keep = await srv.playback(movie, { quality: 'original', canPlay: () => false, hevc: true, subtitleStreamId: 4 });
    expect([keep.mode, keep.video, keep.audio, keep.subtitle]).toEqual(['hls', 'copy', 'transcode', 'segmented']);
    expect(new URL(keep.url).searchParams.get('subtitles')).toBe('auto');
    expect(keep.reason).toContain('vidéo d’origine');

    // Si le serveur compte réencoder malgré tout, on retombe sur du H.264.
    const fallback = await srv.playback({ ...movie, ratingKey: '77' }, { quality: 'original', canPlay: () => false, hevc: true });
    expect([fallback.video, String(new URL(fallback.url).searchParams.get('X-Plex-Client-Profile-Extra')).includes('hevc')]).toEqual(['transcode', false]);
    await srv.stopTranscode(plan.session);
    expect([last().path, last().q.get('session')]).toEqual(['/video/:/transcode/universal/stop', plan.session]);
  });

  it('liste les lectures en cours', async () => {
    const [a, b] = await srv.sessions();
    expect([a.id, a.user, a.state, a.player, a.platform, a.transcoding, a.item.viewOffset]).toEqual(['abc', 'Ami', 'paused', 'Salon', 'Android', true, 600000]);
    expect([b.id, b.user, b.state, b.player, b.transcoding]).toEqual(['6', '?', 'playing', 'Plex Web', false]);
  });

  it('envoie progression, vu / non vu et choix de pistes', async () => {
    await srv.timeline({ ratingKey: '10', state: 'playing', timeMs: 12345.6, durationMs: 6000000, session: 's1' });
    let q = last().q;
    expect([last().path, q.get('ratingKey'), q.get('key'), q.get('state'), q.get('time'), q.get('duration'), q.get('X-Plex-Session-Identifier')]).toEqual(['/:/timeline', '10', '/library/metadata/10', 'playing', '12346', '6000000', 's1']);
    await srv.scrobble('10', true);
    expect([last().path, last().q.get('key'), last().q.get('identifier')]).toEqual(['/:/scrobble', '10', 'com.plexapp.plugins.library']);
    await srv.scrobble('10', false);
    expect(last().path).toBe('/:/unscrobble');
    await srv.selectStreams(77, { subtitleStreamID: 0 });
    q = last().q;
    expect([last().method, last().path, q.get('subtitleStreamID'), q.get('audioStreamID'), q.get('allParts')]).toEqual(['PUT', '/library/parts/77', '0', null, '1']);
  });
});
