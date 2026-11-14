import { describe, expect, it } from 'vitest';
import {
  ratingBadges,
  switchHomeUser,
  imdbIdOf,
  segmentsToMarkers,
  toFriendActivity,
  DemoDiscover,
  DemoServer,
  discoverId,
  discoverImage,
  clearLogoPath,
  ultraBlurCorners,
  directPlayMime,
  hdrKind,
  luminance,
  parseGallery,
  parseTheme,
  videoCodecString,
  pickConnection,
  planPlayback,
  seasonCatalogId,
  upcomingEpisodes,
  request,
  rankConnections,
  srtToVtt,
  techBadges,
  transcodeParams,
  type ClientInfo,
  type Metadata,
  type PlexConnection,
} from '../src';

const client: ClientInfo = { clientId: 'c', product: 'MultiPlex', version: '0', platform: 'Web', device: 'Test', deviceName: 'Test' };

const conn = (uri: string, local: boolean, relay: boolean): PlexConnection => ({ uri, local, relay, protocol: uri.split(':')[0], address: '', port: 32400 });
const conns = [conn('https://relay', false, true), conn('https://remote', false, false), conn('http://local', true, false), conn('https://local', true, false)];

const movie = (over: Partial<NonNullable<Metadata['Media']>[0]> = {}, streams: NonNullable<Metadata['Media']>[0]['Part'][0]['Stream'] = []): Metadata => ({
  ratingKey: '42',
  type: 'movie',
  title: 'T',
  Media: [{ id: 1, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', Part: [{ id: 7, key: '/library/parts/7/file.mp4', container: 'mp4', Stream: streams }], ...over }],
});
const yes = () => true;

describe('épisodes à venir', () => {
  const ep = (index: number, date?: string): Metadata => ({ ratingKey: `e${index}`, type: 'episode', title: `É${index}`, index, originallyAvailableAt: date });
  it('garde les épisodes absents de la bibliothèque et pas encore diffusés', () => {
    const catalogue = [ep(3, '2026-11-11'), ep(1, '2026-11-11'), ep(2, '2026-11-11'), ep(5, '2026-11-18'), ep(4, '2026-11-01'), ep(6)];
    const library = [ep(1), ep(2)];
    expect(upcomingEpisodes(catalogue, library, '2026-11-12').map((e) => e.index)).toEqual([5, 6]);
  });
  it("reconnaît l'identifiant de catalogue d'une saison", () => {
    expect(seasonCatalogId('plex://season/684de13cce7759c761c9d9ce')).toBe('684de13cce7759c761c9d9ce');
    expect(seasonCatalogId('com.plexapp.agents.thetvdb://1/2')).toBeNull();
  });
});

describe('connexions', () => {
  it('classe local > distant > relais et filtre le http si nécessaire', () => {
    expect(rankConnections(conns, false).map((c) => c.uri)).toEqual(['http://local', 'https://local', 'https://remote', 'https://relay']);
    expect(rankConnections(conns, true).map((c) => c.uri)).toEqual(['https://local', 'https://remote', 'https://relay']);
  });

  it('choisit la meilleure connexion qui répond', async () => {
    const probe = (uri: string) => (uri.includes('local') ? Promise.reject(new Error('x')) : Promise.resolve());
    expect((await pickConnection(conns, { secureOnly: false, probe }))?.uri).toBe('https://remote');
  });

  it("n'attend pas le relais quand le local répond", async () => {
    const probe = (uri: string) => (uri.includes('relay') ? new Promise(() => {}) : Promise.resolve());
    expect((await pickConnection(conns, { secureOnly: true, probe }))?.uri).toBe('https://local');
  });

  it('sonde avec le jeton (sinon Plex refuse les sites autres que les siens)', async () => {
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      await pickConnection([conn('https://local', true, false)], { secureOnly: true, token: 'a b' });
    } finally {
      globalThis.fetch = real;
    }
    expect(seen).toEqual(['https://local/identity?X-Plex-Token=a%20b']);
  });

  it("un délai dépassé donne un message lisible, sans le jeton", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    try {
      await expect(request('https://srv:32400/video/:/transcode/universal/decision?X-Plex-Token=secret', { timeout: 20 })).rejects.toThrow(
        "Le serveur n'a pas répondu en 0 s (/video/:/transcode/universal/decision)",
      );
    } finally {
      globalThis.fetch = real;
    }
  });

  it('renvoie null si rien ne répond', async () => {
    expect(await pickConnection(conns, { secureOnly: false, probe: () => Promise.reject(new Error('x')) })).toBeNull();
  });
});

describe('lecture', () => {
  it('construit le type MIME', () => {
    expect(directPlayMime(movie().Media![0])).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
    expect(directPlayMime(movie({ videoCodec: 'hevc' }, [{ id: 1, streamType: 1, bitDepth: 10, level: 150 }]).Media![0])).toBe('video/mp4; codecs="hvc1.2.4.L150.B0, mp4a.40.2"');
    expect(directPlayMime(movie({ videoCodec: 'mpeg2video' }).Media![0])).toBeNull();
    expect(directPlayMime(movie({ audioCodec: 'dca' }).Media![0])).toBeNull();
  });

  it('construit des chaînes de codec exactes', () => {
    expect(videoCodecString('h264', { id: 1, streamType: 1, profile: 'high', level: 41 })).toBe('avc1.640029');
    expect(videoCodecString('h264', { id: 1, streamType: 1, profile: 'high 10', level: 51 })).toBe('avc1.6E0033');
    expect(videoCodecString('hevc', { id: 1, streamType: 1, profile: 'main 10', bitDepth: 10, level: 153 })).toBe('hvc1.2.4.L153.B0');
    expect(videoCodecString('hevc', { id: 1, streamType: 1, level: 120 })).toBe('hvc1.1.6.L120.B0');
    expect(videoCodecString('av1', { id: 1, streamType: 1, bitDepth: 10 })).toBe('av01.0.12M.10');
    expect(videoCodecString('vp9', { id: 1, streamType: 1, bitDepth: 10 })).toBe('vp09.02.51.10');
    expect(videoCodecString('mpeg2video')).toBeNull();
  });

  it('reconnaît HDR10, HLG et Dolby Vision', () => {
    expect(hdrKind({ id: 1, streamType: 1, colorTrc: 'smpte2084' })).toBe('HDR10');
    expect(hdrKind({ id: 1, streamType: 1, colorTrc: 'arib-std-b67' })).toBe('HLG');
    expect(hdrKind({ id: 1, streamType: 1, DOVIPresent: true, colorTrc: 'smpte2084' })).toBe('Dolby Vision');
    expect(hdrKind({ id: 1, streamType: 1, colorTrc: 'bt709' })).toBe('');
  });

  it('refuse de lire tel quel un Dolby Vision sans couche HDR10', () => {
    const dv5 = movie({ videoCodec: 'hevc' }, [{ id: 1, streamType: 1, codec: 'hevc', bitDepth: 10, DOVIPresent: true, DOVIProfile: 5, DOVIBLCompatID: 0 }]);
    const d = planPlayback(dv5, { quality: 'original', canPlay: yes });
    expect([d.mode, d.keepVideo]).toEqual(['hls', false]);
    const dv8 = movie({ videoCodec: 'hevc' }, [{ id: 1, streamType: 1, codec: 'hevc', bitDepth: 10, DOVIPresent: true, DOVIProfile: 8, DOVIBLCompatID: 1 }]);
    expect(planPlayback(dv8, { quality: 'original', canPlay: yes }).mode).toBe('direct');
  });

  it('résume les caractéristiques techniques en pastilles', () => {
    const labels = (m: Metadata) => techBadges(m.Media![0]).map((b) => b.label);
    const uhd = movie({ videoResolution: '4k', videoCodec: 'hevc', audioCodec: 'truehd', audioChannels: 8 }, [
      { id: 1, streamType: 1, codec: 'hevc', DOVIPresent: true, colorTrc: 'smpte2084' },
      { id: 2, streamType: 2, codec: 'truehd', channels: 8, selected: true, extendedDisplayTitle: 'English (TrueHD 7.1 Atmos)' },
    ]);
    expect(labels(uhd)).toEqual(['4K', 'HEVC', 'Dolby Vision', 'Dolby Atmos', '7.1']);
    const dts = movie({ videoResolution: '1080', videoCodec: 'h264', audioCodec: 'dca-ma', audioChannels: 6 }, [
      { id: 1, streamType: 1, codec: 'h264', colorTrc: 'bt709' },
      { id: 2, streamType: 2, codec: 'dca', profile: 'ma', channels: 6 },
    ]);
    expect(labels(dts)).toEqual(['1080p', 'H.264', 'DTS-HD MA', '5.1']);
    // Sans détail des pistes (listes, rangées), on se rabat sur le résumé du fichier.
    expect(labels(movie({ videoResolution: '720', videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2 }))).toEqual(['720p', 'H.264', 'AAC', 'Stéréo']);
    expect(techBadges(undefined)).toEqual([]);
  });

  it('lecture directe quand tout est compatible', () => {
    expect(planPlayback(movie(), { quality: 'original', canPlay: yes }).mode).toBe('direct');
  });

  it('transcode si codec refusé, qualité limitée ou forcé', () => {
    expect(planPlayback(movie(), { quality: 'original', canPlay: () => false }).mode).toBe('hls');
    expect(planPlayback(movie(), { quality: '4000', canPlay: yes }).mode).toBe('hls');
    expect(planPlayback(movie(), { quality: 'original', canPlay: yes, forceTranscode: true }).mode).toBe('hls');
  });

  it('gère pistes audio et sous-titres', () => {
    const streams = [
      { id: 1, streamType: 1 },
      { id: 2, streamType: 2 },
      { id: 3, streamType: 2 },
      { id: 4, streamType: 3, codec: 'srt', key: '/library/streams/4' },
      { id: 5, streamType: 3, codec: 'pgs' },
    ];
    const m = movie({}, streams);
    expect(planPlayback(m, { quality: 'original', canPlay: yes, audioStreamId: 2 }).mode).toBe('direct');
    expect(planPlayback(m, { quality: 'original', canPlay: yes, audioStreamId: 3 }).mode).toBe('hls');
    const side = planPlayback(m, { quality: 'original', canPlay: yes, subtitleStreamId: 4 });
    expect([side.mode, side.subtitle]).toEqual(['direct', 'sidecar']);
    const burn = planPlayback(m, { quality: 'original', canPlay: yes, subtitleStreamId: 5 });
    expect([burn.mode, burn.subtitle]).toEqual(['hls', 'burn']);
  });

  it('juge la lecture directe sur le codec de la première piste audio', () => {
    const m = movie({ audioCodec: 'dca' }, [{ id: 2, streamType: 2, codec: 'flac' }, { id: 3, streamType: 2, codec: 'dca' }]);
    const seen: string[] = [];
    const d = planPlayback(m, { quality: 'original', canPlay: (mime) => (seen.push(mime), true), audioStreamId: 2 });
    expect(d.mode).toBe('direct');
    expect(seen[0]).toContain('flac');
  });

  it('paramètres de transcodage', () => {
    const orig = transcodeParams(movie(), { quality: 'original', canPlay: yes }, 's', client);
    expect(orig.path).toBe('/library/metadata/42');
    expect(orig.directStream).toBe(1);
    expect(orig.maxVideoBitrate).toBeUndefined();
    const low = transcodeParams(movie(), { quality: '4000', canPlay: yes, subtitleStreamId: 5 }, 's', client);
    expect([low.directStream, low.maxVideoBitrate, low.videoResolution, low.subtitles]).toEqual([0, 4000, '1280x720', 'auto']);
    expect(String(orig['X-Plex-Client-Profile-Extra'])).not.toContain('hevc');
    expect(String(transcodeParams(movie(), { quality: 'original', canPlay: yes }, 's', client, true)['X-Plex-Client-Profile-Extra'])).toContain('videoCodec=h264,hevc');
  });

  it('convertit le SRT en VTT', () => {
    expect(srtToVtt('﻿1\r\n00:00:01,500 --> 00:00:02,000\r\nSalut\r\n')).toBe('WEBVTT\n\n1\n00:00:01.500 --> 00:00:02.000\nSalut\n');
  });
});

describe('catalogue et liste de suivi', () => {
  it('extrait l’identifiant du catalogue', () => {
    expect(discoverId('plex://movie/5d776824f54112001f5bbddc')).toBe('5d776824f54112001f5bbddc');
    expect(discoverId('plex://show/5d9c08aa3c3f87001f354581')).toBe('5d9c08aa3c3f87001f354581');
    expect(discoverId('plex://episode/5d9c08aa3c3f87001f354581')).toBeNull();
    expect(discoverId('com.plexapp.agents.imdb://tt1375666?lang=fr')).toBeNull();
    expect(discoverId(undefined)).toBeNull();
  });
  it('choisit l’affiche et le fond', () => {
    const item = { ratingKey: 'a', type: 'movie', title: 't', Image: [{ type: 'background', url: 'https://x/bg.jpg' }, { type: 'coverPoster', url: 'https://x/p.jpg' }] };
    expect([discoverImage(item, 'poster'), discoverImage(item, 'background')]).toEqual(['https://x/p.jpg', 'https://x/bg.jpg']);
    expect(discoverImage({ ...item, thumb: 'https://x/t.jpg' }, 'poster')).toBe('https://x/t.jpg');
  });
  it('le catalogue de démo gère la liste de suivi', async () => {
    const d = new DemoDiscover();
    const before = await d.watchlist(0, 50);
    const hit = (await d.search('brume'))[0];
    expect(hit.title).toBe('Brume');
    const other = (await d.search('archipel'))[0];
    expect(await d.isWatchlisted(other.ratingKey)).toBe(false);
    await d.setWatchlisted(other.ratingKey, true);
    const after = await d.watchlist(0, 50);
    expect([after.total, after.items[0].title, (await d.details(other.ratingKey)).watchlisted]).toEqual([before.total + 1, 'Archipel', true]);
    await d.setWatchlisted(other.ratingKey, false);
    expect((await d.watchlist(0, 50)).total).toBe(before.total);
  });
});

describe('repères communautaires et activité des amis', () => {
  it('lit l’identifiant IMDb et convertit les repères IntroDB', () => {
    expect(imdbIdOf({ Guid: [{ id: 'tmdb://1396' }, { id: 'imdb://tt0903747' }] })).toBe('tt0903747');
    expect(imdbIdOf({ guid: 'plex://show/5d9c086c7d06d9001ffd27aa' })).toBeNull();
    expect(segmentsToMarkers({ intro: { start_sec: 2.5, end_sec: 58 }, outro: null })).toEqual([{ type: 'intro', startTimeOffset: 2500, endTimeOffset: 58000 }]);
    // Repère trop court ou à l'envers : ignoré.
    expect(segmentsToMarkers({ intro: { start_sec: 50, end_sec: 51 }, outro: { start_sec: 90, end_sec: 10 } })).toEqual([]);
    expect(segmentsToMarkers(null)).toEqual([]);
  });

  it('met en forme une lecture d’ami', () => {
    const a = toFriendActivity({
      id: 'x',
      date: '2026-11-12T10:00:00Z',
      userV2: { id: '1', username: 'cam', displayName: 'Camille' },
      metadataItem: { title: 'Pilote', type: 'EPISODE', index: 1, key: '/library/metadata/5d9c086c7d06d9001ffd27ab', parent: { index: 2 }, grandparent: { title: 'Archipel', key: '/library/metadata/5d9c086c7d06d9001ffd27aa', images: { coverPoster: 'https://exemple/p.jpg' } } },
    });
    expect(a).toMatchObject({ user: { name: 'Camille' }, type: 'episode', title: 'Pilote', show: 'Archipel', episode: 'S2 · E1', poster: 'https://exemple/p.jpg', discoverId: '5d9c086c7d06d9001ffd27aa' });
    expect(toFriendActivity({ id: 'y', date: '', metadataItem: null })).toBeNull();
  });
});

describe('notes', () => {
  it('reprend les notes de Plex dans l’ordre IMDb, critiques, public, TMDB', () => {
    const badges = ratingBadges({
      Rating: [
        { image: 'themoviedb://image.rating', value: 8.4, type: 'audience' },
        { image: 'rottentomatoes://image.rating.upright', value: 8, type: 'audience' },
        { image: 'imdb://image.rating', value: 8.6, type: 'audience' },
        { image: 'rottentomatoes://image.rating.ripe', value: 9.5, type: 'critic' },
      ],
    });
    expect(badges).toEqual([
      { source: 'imdb', text: '8.6' },
      { source: 'rt-critic', text: '95%', fresh: true },
      { source: 'rt-audience', text: '80%', fresh: true },
      { source: 'tmdb', text: '84%' },
    ]);
    expect(ratingBadges({ Rating: [{ image: 'rottentomatoes://image.rating.rotten', value: 0.9, type: 'critic' }] })).toEqual([{ source: 'rt-critic', text: '9%', fresh: false }]);
    // Sans le détail : les deux notes principales.
    expect(ratingBadges({ rating: 7.2, ratingImage: 'imdb://image.rating' })).toEqual([{ source: 'imdb', text: '7.2' }]);
    expect(ratingBadges({})).toEqual([]);
  });
});

describe('Plex Home', () => {
  it('refuse un identifiant de profil mal formé avant tout appel réseau', async () => {
    const c = { clientId: 'x', product: 'p', version: '1', platform: 'p', device: 'd', deviceName: 'n' };
    await expect(switchHomeUser(c, 'jeton', '../admin')).rejects.toThrow('Profil invalide');
  });
});

describe('thèmes partagés', () => {
  const vars = { '--bg': '#101010', '--surface': '#1a1a1a', '--surface-2': '#2a2a2a', '--text': '#ffffff', '--muted': '#999999', '--accent': '#ffcc00' };
  it('accepte un thème valide et complète ce qui manque', () => {
    const th = parseTheme({ id: 'mon-theme', name: ' Mon thème ', vars, radius: 12.4 })!;
    expect([th.id, th.name, th.mode, th.radius, th.vars['--on-accent']]).toEqual(['mon-theme', 'Mon thème', 'dark', 12, '#000000']);
    expect(parseTheme({ id: 'clair', name: 'Clair', vars: { ...vars, '--bg': '#fafafa', '--accent': '#102040' } })).toMatchObject({ mode: 'light', vars: { '--on-accent': '#ffffff' } });
  });
  it('rejette ce qui pourrait charger ou exécuter quelque chose', () => {
    expect(parseTheme({ id: 'x', name: 'trop court', vars })).toBeNull();
    expect(parseTheme({ id: 'Majuscule', name: 'n', vars })).toBeNull();
    expect(parseTheme({ id: 'incomplet', name: 'n', vars: { '--bg': '#000' } })).toBeNull();
    expect(parseTheme({ id: 'piege', name: 'n', vars: { ...vars, '--bg': 'url(https://exemple.test/pixel.png)' } })).toBeNull();
    expect(parseTheme({ id: 'piege2', name: 'n', vars: { ...vars, '--accent': 'red; background: url(x)' } })).toBeNull();
    const th = parseTheme({ id: 'extra', name: 'n', css: 'body{display:none}', vars: { ...vars, '--inconnue': '#fff', color: 'red' } })!;
    expect(Object.keys(th.vars).sort()).toEqual([...Object.keys(vars), '--on-accent'].sort());
    expect('css' in th).toBe(false);
  });
  it('n’accepte une illustration que si elle est embarquée', () => {
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const ok = parseTheme({ id: 'illustre', name: 'n', vars, image: pixel, imageCredit: ' Auteur, CC BY ' })!;
    expect([ok.image, ok.imageCredit]).toEqual([pixel, 'Auteur, CC BY']);
    // La mise en scène se choisit dans une liste fermée, et n'a de sens qu'avec une illustration.
    expect(parseTheme({ id: 'illustre', name: 'n', vars, image: pixel, effect: 'aura', motto: ' Devise ' })).toMatchObject({ effect: 'aura', motto: 'Devise' });
    expect(parseTheme({ id: 'illustre', name: 'n', vars, image: pixel, effect: 'body{display:none}' })!.effect).toBeUndefined();
    expect(parseTheme({ id: 'illustre', name: 'n', vars, effect: 'aura', motto: 'x' })).toMatchObject({ effect: undefined, motto: undefined });
    for (const image of ['https://exemple.test/photo.jpg', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGI+', pixel + '" onerror="x', 'data:image/png;base64,' + 'A'.repeat(400000)]) {
      const th = parseTheme({ id: 'illustre', name: 'n', vars, image, imageCredit: 'x' })!;
      expect([th.image, th.imageCredit]).toEqual([undefined, undefined]);
    }
  });
  it('valide une galerie sans doublon', () => {
    const list = parseGallery({ themes: [{ id: 'aa', name: 'A', vars }, { id: 'aa', name: 'Doublon', vars }, { id: 'bb', name: 'B', vars }, 'autre chose', null] });
    expect(list.map((x) => x.name)).toEqual(['A', 'B']);
    expect(parseGallery('pas une liste')).toEqual([]);
  });
  it('mesure la luminance', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#fff')).toBeCloseTo(1);
    expect(luminance('rgb(1,2,3)')).toBeNull();
    // Une couleur à six chiffres ne doit pas être lue comme ses trois premiers.
    expect(luminance('#f6f1e7')!).toBeGreaterThan(0.8);
    expect(luminance('#101014')!).toBeLessThan(0.05);
    expect(luminance('#ffffff80')).toBeCloseTo(1);
    expect(parseTheme({ id: 'papier', name: 'Papier', vars: { '--bg': '#f6f1e7', '--surface': '#fffaf0', '--surface-2': '#e9e0cf', '--text': '#2b2419', '--muted': '#6f6453', '--accent': '#a8590f' } })).toMatchObject({ mode: 'light', vars: { '--on-accent': '#ffffff' } });
  });
});

describe('serveur de démo', () => {
  const s = new DemoServer();
  it('pagine et trie', async () => {
    const p = await s.items('1', { offset: 100, limit: 50, sort: 'year:desc' });
    expect(p.total).toBe(240);
    expect(p.items).toHaveLength(50);
    expect(p.items[0].year!).toBeGreaterThanOrEqual(p.items[49].year!);
  });
  it('expose séries, saisons et épisodes', async () => {
    const show = (await s.items('2', { offset: 0, limit: 1 })).items[0];
    const seasons = await s.children(show.ratingKey);
    expect(seasons).toHaveLength(2);
    expect(await s.children(seasons[0].ratingKey)).toHaveLength(6);
  });
  it('simule des lectures en cours', async () => {
    const list = await s.sessions();
    expect(list).toHaveLength(3);
    expect(list[0].item.viewOffset).toBeGreaterThan(0);
  });
  it('recherche', async () => {
    expect((await s.search('chroniques'))[0].type).toBe('show');
  });
});

describe('clearLogoPath', () => {
  const base = { ratingKey: '42' };
  it('prend le logo de la liste d’images du serveur', () => {
    const Image = [{ type: 'coverPoster', url: '/library/metadata/42/thumb/1' }, { type: 'clearLogo', url: '/library/metadata/42/clearLogo/7' }];
    expect(clearLogoPath({ ...base, type: 'movie', Image })).toBe('/library/metadata/42/clearLogo/7');
    expect(clearLogoPath({ ...base, type: 'show', Image })).toBe('/library/metadata/42/clearLogo/7');
  });
  it('rien quand la liste existe sans logo, ni pour une personne ou une collection', () => {
    expect(clearLogoPath({ ...base, type: 'movie', Image: [{ type: 'background', url: '/a' }] })).toBeUndefined();
    expect(clearLogoPath({ ...base, type: 'collection' })).toBeUndefined();
  });
  it('épisode et saison : le logo de la série', () => {
    expect(clearLogoPath({ ...base, type: 'episode', grandparentRatingKey: '7', Image: [{ type: 'clearLogo', url: '/library/metadata/7/clearLogo/3' }] })).toBe('/library/metadata/7/clearLogo/3');
    expect(clearLogoPath({ ...base, type: 'season', parentRatingKey: '7', Image: [{ type: 'coverPoster', url: '/p' }] })).toBe('/library/metadata/7/clearLogo');
    expect(clearLogoPath({ ...base, type: 'episode' })).toBeUndefined();
  });
  it('adresse générique quand le serveur ne donne pas de liste d’images', () => {
    expect(clearLogoPath({ ...base, type: 'movie' })).toBe('/library/metadata/42/clearLogo');
  });
});

describe('ultraBlurCorners', () => {
  it('lit l’objet ou le tableau, avec ou sans dièse', () => {
    const c = { topLeft: '1A2B3C', topRight: '#445566', bottomLeft: '778899', bottomRight: 'aabbcc' };
    const want = { tl: '#1a2b3c', tr: '#445566', bl: '#778899', br: '#aabbcc' };
    expect(ultraBlurCorners({ UltraBlurColors: c })).toEqual(want);
    expect(ultraBlurCorners({ UltraBlurColors: [c] })).toEqual(want);
  });
  it('ignore l’absence et les quatre coins noirs', () => {
    expect(ultraBlurCorners({})).toBeUndefined();
    expect(ultraBlurCorners({ UltraBlurColors: [{ topLeft: '000000', topRight: '000000', bottomLeft: '000000', bottomRight: '000000' }] })).toBeUndefined();
  });
});
