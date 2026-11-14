import { randomId } from './http';
import type { ActiveSession, Hub, ItemsQuery, Library, LibraryOptions, MediaServer, Metadata, Page, PlaybackPlan } from './types';

/**
 * Serveur factice : permet d'essayer et de développer l'interface sans compte
 * Plex. Les affiches sont des SVG générés, la vidéo un flux HLS de test public.
 */
const ADJ = ['Dernier', 'Grand', 'Petit', 'Étrange', 'Lointain', 'Sombre', 'Premier', 'Vieux', 'Silencieux', 'Autre'];
const NOUN = ['Voyage', 'Hiver', 'Rivage', 'Horizon', 'Jardin', 'Signal', 'Phare', 'Désert', 'Orage', 'Matin', 'Atlas', 'Secret'];
const TEST_STREAM = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

function poster(title: string, hue: number, wide = false): string {
  const [w, h] = wide ? [640, 360] : [400, 600];
  const esc = title.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},55%,42%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,16%)"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.78}" cy="${h * 0.22}" r="${w * 0.3}" fill="hsla(${(hue + 30) % 360},80%,70%,.18)"/>` +
    `<text x="${w * 0.08}" y="${h * 0.86}" font-family="system-ui,sans-serif" font-weight="700" font-size="${w * 0.085}" fill="#fff">${esc}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Couleurs de coin d'une image de démonstration, comme les UltraBlurColors d'un serveur. */
function blur(hue: number): Metadata['UltraBlurColors'] {
  const hex = (h: number, sat: number, l: number) => {
    const a = (sat / 100) * Math.min(l / 100, 1 - l / 100);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
    };
    return `${f(0)}${f(8)}${f(4)}`;
  };
  return [{ topLeft: hex(hue, 55, 34), topRight: hex((hue + 30) % 360, 60, 30), bottomLeft: hex((hue + 45) % 360, 60, 20), bottomRight: hex((hue + 60) % 360, 60, 14) }];
}

function build(): Map<string, Metadata & { _section: string; _children?: string[] }> {
  const db = new Map<string, Metadata & { _section: string; _children?: string[] }>();
  let n = 0;
  for (let i = 0; i < 240; i++) {
    const title = `Le ${ADJ[i % ADJ.length]} ${NOUN[Math.floor(i / ADJ.length) % NOUN.length]}${i >= 120 ? ` ${Math.floor(i / 120) + 1}` : ''}`;
    const hue = (i * 47) % 360;
    const key = String(++n);
    db.set(key, {
      _section: '1',
      ratingKey: key,
      type: 'movie',
      title,
      year: 1980 + ((i * 13) % 45),
      summary: `« ${title} » est un film de démonstration. Connectez votre compte Plex pour retrouver votre vraie bibliothèque.`,
      thumb: poster(title, hue),
      art: poster(title, hue, true),
      UltraBlurColors: blur(hue),
      duration: (85 + (i % 60)) * 60000,
      viewOffset: i % 17 === 3 ? 25 * 60000 : undefined,
      viewCount: i % 3 === 0 ? 1 : 0,
      rating: 5 + ((i * 3) % 50) / 10,
      Director: [{ tag: 'Maud Ferrand', tagKey: 'demo00000000000000a1' }],
      Role: ['Inès Morel', 'Yanis Haddad', 'Camille Roy', 'Louis Garnier', 'Sofia Lemaire'].map((tag, k) => ({ tag, tagKey: `demo00000000000000b${k}`, role: ['La capitaine', 'Le navigateur', 'La cartographe', 'Le passager', 'La gardienne'][k] })),
      Rating: [
        { image: 'imdb://image.rating', value: 5 + ((i * 3) % 50) / 10, type: 'audience' },
        { image: `rottentomatoes://image.rating.${i % 3 ? 'ripe' : 'rotten'}`, value: i % 3 ? 7.4 + (i % 5) * 0.5 : 4.2, type: 'critic' },
        { image: `rottentomatoes://image.rating.${i % 4 ? 'upright' : 'spilled'}`, value: i % 4 ? 8 : 5.5, type: 'audience' },
        { image: 'themoviedb://image.rating', value: 6 + (i % 4) * 0.7, type: 'audience' },
      ],
      contentRating: 'Tous publics',
      Genre: [{ tag: ['Aventure', 'Drame', 'Comédie', 'Science-fiction'][i % 4] }],
      Media: [{ id: n, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', videoResolution: '1080', Part: [{ id: n, key: TEST_STREAM, container: 'mp4' }] }],
    });
  }
  for (let s = 0; s < 12; s++) {
    const title = `Chroniques du ${NOUN[s % NOUN.length]}`;
    const hue = (s * 83 + 20) % 360;
    const showKey = String(++n);
    const seasons: string[] = [];
    for (let se = 1; se <= 2; se++) {
      const seasonKey = String(++n);
      const eps: string[] = [];
      for (let e = 1; e <= 6; e++) {
        const epKey = String(++n);
        eps.push(epKey);
        db.set(epKey, {
          _section: '2',
          ratingKey: epKey,
          type: 'episode',
          title: `Épisode ${e}`,
          index: e,
          parentIndex: se,
          parentRatingKey: seasonKey,
          parentTitle: `Saison ${se}`,
          grandparentRatingKey: showKey,
          grandparentTitle: title,
          grandparentThumb: poster(title, hue),
          thumb: poster(`${title} · S${se}E${e}`, hue, true),
          art: poster(title, hue, true),
          UltraBlurColors: blur(hue),
          summary: 'Épisode de démonstration.',
          duration: 42 * 60000,
          viewCount: se === 1 && e < 3 ? 1 : 0,
          Marker: [{ type: 'intro', startTimeOffset: 5000, endTimeOffset: 35000 }],
          Media: [{ id: n, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', videoResolution: '1080', Part: [{ id: n, key: TEST_STREAM, container: 'mp4' }] }],
        });
      }
      seasons.push(seasonKey);
      db.set(seasonKey, {
        _section: '2',
        _children: eps,
        ratingKey: seasonKey,
        type: 'season',
        title: `Saison ${se}`,
        index: se,
        parentRatingKey: showKey,
        parentTitle: title,
        thumb: poster(`${title} — S${se}`, hue),
        art: poster(title, hue, true),
        UltraBlurColors: blur(hue),
        leafCount: 6,
        viewedLeafCount: se === 1 ? 2 : 0,
      });
    }
    db.set(showKey, {
      _section: '2',
      _children: seasons,
      ratingKey: showKey,
      type: 'show',
      Role: ['Inès Morel', 'Yanis Haddad', 'Camille Roy'].map((tag, k) => ({ tag, tagKey: `demo00000000000000c${k}`, role: ['La voyageuse', 'Le guide', 'La chroniqueuse'][k] })),
      title,
      year: 2010 + s,
      summary: `« ${title} » est une série de démonstration.`,
      thumb: poster(title, hue),
      art: poster(title, hue, true),
      UltraBlurColors: blur(hue),
      leafCount: 12,
      viewedLeafCount: 2,
      Genre: [{ tag: 'Drame' }],
    });
  }
  return db;
}

export class DemoServer implements MediaServer {
  readonly id = 'demo';
  readonly name = 'Démo';
  private db = build();

  private all(pred: (m: Metadata & { _section: string }) => boolean): Metadata[] {
    return [...this.db.values()].filter(pred);
  }

  async libraries(): Promise<Library[]> {
    return [
      { key: '1', title: 'Films', type: 'movie' },
      { key: '2', title: 'Séries', type: 'show' },
    ];
  }

  async hubs(sectionId?: string): Promise<Hub[]> {
    const inSection = (m: { _section: string }) => !sectionId || m._section === sectionId;
    const movies = this.all((m) => m.type === 'movie' && inSection(m));
    const shows = this.all((m) => m.type === 'show' && inSection(m));
    const hubs: Hub[] = [
      { hubIdentifier: 'home.continue', title: 'Reprendre la lecture', type: 'mixed', Metadata: movies.filter((m) => m.viewOffset).slice(0, 12) },
      { hubIdentifier: 'home.movies.recent', title: 'Films ajoutés récemment', type: 'movie', Metadata: movies.slice(-20).reverse() },
      { hubIdentifier: 'home.television.recent', title: 'Séries ajoutées récemment', type: 'show', Metadata: shows },
      { hubIdentifier: 'movie.toprated', title: 'Les mieux notés', type: 'movie', Metadata: [...movies].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).slice(0, 20) },
    ];
    return hubs.filter((h) => h.Metadata?.length);
  }

  async items(sectionId: string, q: ItemsQuery): Promise<Page<Metadata>> {
    const top = sectionId === '1' ? 'movie' : 'show';
    let list = this.all((m) => m._section === sectionId && m.type === top);
    const f = q.filter ?? {};
    const seen = (m: Metadata) => (m.type === 'movie' ? !!m.viewCount : (m.viewedLeafCount ?? 0) >= (m.leafCount ?? 0));
    const flag = f.unwatched ?? f.unwatchedLeaves;
    if (flag !== undefined) list = list.filter((m) => (Number(flag) ? !seen(m) : seen(m)));
    if (f.inProgress) list = list.filter((m) => !!m.viewOffset || (m.type === 'show' && (m.viewedLeafCount ?? 0) > 0 && !seen(m)));
    if (f.genre) list = list.filter((m) => m.Genre?.some((g) => g.tag === f.genre));
    if (f.decade) list = list.filter((m) => Math.floor((m.year ?? 0) / 10) * 10 === Number(f.decade));
    if (f.resolution) list = list.filter((m) => m.Media?.[0]?.videoResolution === String(f.resolution));
    if (f.year) list = list.filter((m) => m.year === Number(f.year));
    const epRes = f['episode.resolution'];
    if (epRes) {
      const eps = this.all((e) => e.type === 'episode' && e.Media?.[0]?.videoResolution === String(epRes));
      list = list.filter((m) => eps.some((e) => e.grandparentRatingKey === m.ratingKey));
    }
    const [field, dir] = (q.sort ?? 'titleSort').split(':');
    const val = (m: Metadata) =>
      field === 'year' || field === 'originallyAvailableAt'
        ? (m.year ?? 0)
        : field === 'rating' || field === 'audienceRating'
          ? (m.rating ?? 0)
          : field === 'duration'
            ? (m.duration ?? 0)
            : field === 'addedAt' || field === 'lastViewedAt'
              ? Number(m.ratingKey)
              : m.title;
    list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - Number(y);
      return dir === 'desc' ? -c : c;
    });
    return { items: list.slice(q.offset, q.offset + q.limit), total: list.length, offset: q.offset };
  }

  async libraryOptions(sectionId: string, type: number): Promise<LibraryOptions> {
    const base = `/demo/${sectionId}/${type}`;
    const show = type === 2;
    const filters = [
      { filter: show ? 'unwatchedLeaves' : 'unwatched', filterType: 'boolean', key: '', title: 'Unwatched' },
      { filter: 'inProgress', filterType: 'boolean', key: '', title: 'In Progress' },
      { filter: 'genre', filterType: 'string', key: `${base}/genre`, title: 'Genre' },
      { filter: 'decade', filterType: 'integer', key: `${base}/decade`, title: 'Decade' },
      ...(show ? [] : [{ filter: 'resolution', filterType: 'string', key: `${base}/resolution`, title: 'Resolution' }]),
      { filter: 'year', filterType: 'integer', key: `${base}/year`, title: 'Year' },
    ];
    const sorts = ['titleSort', 'addedAt', 'year', 'originallyAvailableAt', 'rating', 'audienceRating', 'lastViewedAt', ...(show ? [] : ['duration'])].map((k) => ({
      key: k,
      descKey: `${k}:desc`,
      title: k,
      defaultDirection: k === 'titleSort' ? 'asc' : 'desc',
    }));
    return { filters, sorts };
  }

  async filterValues(key: string): Promise<{ key: string; title: string }[]> {
    const [, , section, , what] = key.split('/');
    const list = this.all((m) => m._section === section && (m.type === 'movie' || m.type === 'show'));
    const uniq = (v: (string | undefined)[]) => [...new Set(v.filter((x): x is string => !!x))].sort();
    if (what === 'genre') return uniq(list.flatMap((m) => m.Genre?.map((g) => g.tag) ?? [])).map((g) => ({ key: g, title: g }));
    if (what === 'decade') return uniq(list.map((m) => (m.year ? String(Math.floor(m.year / 10) * 10) : undefined))).reverse().map((d) => ({ key: d, title: `${d}s` }));
    if (what === 'resolution') {
      const src = key.split('/')[3] === '4' ? this.all((m) => m.type === 'episode') : list;
      return uniq(src.map((m) => m.Media?.[0]?.videoResolution)).map((r) => ({ key: r, title: r === '4k' ? '4K' : `${r}p` }));
    }
    if (what === 'year') return uniq(list.map((m) => (m.year ? String(m.year) : undefined))).reverse().map((y) => ({ key: y, title: y }));
    return [];
  }

  async metadata(ratingKey: string): Promise<Metadata> {
    const m = this.db.get(ratingKey);
    if (!m) throw new Error('Élément introuvable');
    return m;
  }

  async findByGuid(guid: string): Promise<Metadata | undefined> {
    return [...this.db.values()].find((m) => m.guid === guid);
  }

  async children(ratingKey: string): Promise<Metadata[]> {
    return (this.db.get(ratingKey)?._children ?? []).map((k) => this.db.get(k)!);
  }

  async search(query: string, limit = 20): Promise<Hub[]> {
    const q = query.toLowerCase();
    const hit = (type: string) => this.all((m) => m.type === type && m.title.toLowerCase().includes(q)).slice(0, limit);
    return [
      { hubIdentifier: 'movie', title: 'Films', type: 'movie', Metadata: hit('movie') },
      { hubIdentifier: 'show', title: 'Séries', type: 'show', Metadata: hit('show') },
    ].filter((h) => h.Metadata.length);
  }

  image(path: string | undefined): string {
    return path ?? '';
  }

  fileRequest(path: string): { url: string; headers: Record<string, string> } {
    return { url: path, headers: {} };
  }

  async playback(): Promise<PlaybackPlan> {
    return { mode: 'hls', url: TEST_STREAM, session: randomId(), reason: 'flux de démonstration', subtitle: 'none' };
  }

  async stopTranscode(): Promise<void> {}
  async selectStreams(): Promise<void> {}

  async timeline(r: { ratingKey: string; timeMs: number; state: string }): Promise<void> {
    const m = this.db.get(r.ratingKey);
    if (m && r.state !== 'buffering') m.viewOffset = r.timeMs;
  }

  private started = Date.now();

  async sessions(): Promise<ActiveSession[]> {
    // Trois amis fictifs dont la lecture avance en temps réel.
    const elapsed = Date.now() - this.started;
    const cast: [string, string, string][] = [
      ['Camille', '7', 'playing'],
      ['Noah', '245', 'paused'],
      ['Inès', '42', 'playing'],
    ];
    return cast.map(([user, key, state], i) => {
      const m = this.db.get(key)!;
      const base = (i + 1) * 11 * 60000;
      return {
        id: 'demo-' + i,
        user,
        state,
        item: { ...m, viewOffset: Math.min((m.duration ?? 0) - 1000, base + (state === 'playing' ? elapsed : 0)) },
      };
    });
  }

  async personMedia(key: string): Promise<Metadata[]> {
    // Chaque personne fictive apparaît dans quelques films du serveur de démonstration.
    const n = Number(key.replace(/\D/g, '')) || 0;
    return [...this.db.values()].filter((m) => m.type === 'movie').filter((_, i) => (i + n) % 3 === 0).slice(0, 6);
  }

  async rate(ratingKey: string, rating: number | null): Promise<void> {
    const m = this.db.get(ratingKey);
    if (m) m.userRating = rating ?? undefined;
  }


  async trailer(ratingKey: string): Promise<string | undefined> {
    // La démo n'a pas de clips : la bande-annonce est le film lui-même.
    return this.db.get(ratingKey)?.type === 'movie' ? ratingKey : undefined;
  }

  async related(ratingKey: string, lang = 'fr'): Promise<Hub[]> {
    const m = this.db.get(ratingKey);
    if (!m) return [];
    const same = [...this.db.values()].filter((x) => x.type === m.type && x.ratingKey !== ratingKey).slice(0, 12);
    if (!same.length) return [];
    const title = m.type === 'show' ? (lang === 'en' ? 'Related shows' : 'Séries associées') : lang === 'en' ? 'Related movies' : 'Films associés';
    return [{ title, hubIdentifier: `${m.type}.similar`, type: m.type, size: same.length, Metadata: same } as Hub];
  }

  async continueWatching(): Promise<Metadata[]> {
    return [...this.db.values()].filter((m) => !!m.viewOffset);
  }

  async forDevice(url: string): Promise<string> {
    return url;
  }

  async removeFromContinueWatching(ratingKey: string): Promise<void> {
    const m = this.db.get(ratingKey);
    if (m) m.viewOffset = undefined;
  }

  async scrobble(ratingKey: string, watched: boolean): Promise<void> {
    const m = this.db.get(ratingKey);
    if (m) {
      m.viewCount = watched ? 1 : 0;
      m.viewOffset = undefined;
    }
  }
}
