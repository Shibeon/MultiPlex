import { randomId } from './http';
import type { ActiveSession, Hub, ItemsQuery, Library, MediaServer, Metadata, Page, PlaybackPlan } from './types';

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
      duration: (85 + (i % 60)) * 60000,
      viewOffset: i % 17 === 3 ? 25 * 60000 : undefined,
      viewCount: i % 3 === 0 ? 1 : 0,
      rating: 5 + ((i * 3) % 50) / 10,
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
        leafCount: 6,
        viewedLeafCount: se === 1 ? 2 : 0,
      });
    }
    db.set(showKey, {
      _section: '2',
      _children: seasons,
      ratingKey: showKey,
      type: 'show',
      title,
      year: 2010 + s,
      summary: `« ${title} » est une série de démonstration.`,
      thumb: poster(title, hue),
      art: poster(title, hue, true),
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
    if (q.filter?.unwatched || q.filter?.unwatchedLeaves) {
      list = list.filter((m) => (m.type === 'movie' ? !m.viewCount : (m.viewedLeafCount ?? 0) < (m.leafCount ?? 0)));
    }
    const [field, dir] = (q.sort ?? 'titleSort').split(':');
    const val = (m: Metadata) => (field === 'year' ? (m.year ?? 0) : field === 'rating' ? (m.rating ?? 0) : field === 'addedAt' ? Number(m.ratingKey) : m.title);
    list.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - Number(y);
      return dir === 'desc' ? -c : c;
    });
    return { items: list.slice(q.offset, q.offset + q.limit), total: list.length, offset: q.offset };
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
    const cast: [string, string, string, string, string, boolean][] = [
      ['Camille', '7', 'playing', 'Salon', 'Android TV', false],
      ['Noah', '245', 'paused', 'iPhone', 'iOS', true],
      ['Inès', '42', 'playing', 'Chrome', 'Web', false],
    ];
    return cast.map(([user, key, state, player, platform, transcoding], i) => {
      const m = this.db.get(key)!;
      const base = (i + 1) * 11 * 60000;
      return {
        id: 'demo-' + i,
        user,
        state,
        player,
        platform,
        transcoding,
        item: { ...m, viewOffset: Math.min((m.duration ?? 0) - 1000, base + (state === 'playing' ? elapsed : 0)) },
      };
    });
  }

  async scrobble(ratingKey: string, watched: boolean): Promise<void> {
    const m = this.db.get(ratingKey);
    if (m) {
      m.viewCount = watched ? 1 : 0;
      m.viewOffset = undefined;
    }
  }
}
