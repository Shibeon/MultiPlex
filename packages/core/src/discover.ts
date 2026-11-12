import { identityHeaders } from './auth';
import { getJson, request } from './http';
import type { ClientInfo, Metadata, Page } from './types';

/**
 * Catalogue en ligne de Plex (« Discover ») : tous les films et séries connus,
 * qu'ils soient ou non sur un serveur, et la liste de suivi du compte.
 *
 * Ajouter un titre à la liste de suivi ne télécharge rien par lui-même ; un
 * outil branché dessus (Seerr, par exemple) peut ensuite aller le chercher.
 */
export interface Discover {
  watchlist(offset: number, limit: number): Promise<Page<Metadata>>;
  search(query: string, limit?: number): Promise<Metadata[]>;
  /** Fiche d'un titre du catalogue, avec `watchlisted`. */
  details(id: string): Promise<Metadata & { watchlisted: boolean }>;
  isWatchlisted(id: string): Promise<boolean>;
  setWatchlisted(id: string, on: boolean): Promise<void>;
}

const BASE = 'https://discover.provider.plex.tv';

/** Identifiant du catalogue porté par un élément de serveur (`plex://movie/<id>`), ou null. */
export function discoverId(guid: string | undefined): string | null {
  const m = /^plex:\/\/(?:movie|show)\/([0-9a-f]{16,40})$/i.exec(guid ?? '');
  return m ? m[1] : null;
}

/** Affiche ou fond d'un titre du catalogue : champ direct, sinon la liste d'images. */
export function discoverImage(item: Metadata, kind: 'poster' | 'background'): string | undefined {
  const direct = kind === 'poster' ? item.thumb : item.art;
  if (direct) return direct;
  const wanted = kind === 'poster' ? 'coverPoster' : 'background';
  return item.Image?.find((i) => i.type === wanted)?.url;
}

type SearchResponse = { MediaContainer: { SearchResults?: { SearchResult?: { Metadata?: Metadata; score?: number }[] }[] } };
type ListResponse = { MediaContainer: { Metadata?: Metadata[]; totalSize?: number; size?: number; UserState?: { watchlistedAt?: number }[] } };

export class PlexDiscover implements Discover {
  constructor(
    private token: string,
    private client: ClientInfo,
  ) {}

  private get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const qs = q.toString();
    return getJson<T>(`${BASE}${path}${qs ? `?${qs}` : ''}`, { headers: identityHeaders(this.client, this.token) });
  }

  async watchlist(offset: number, limit: number): Promise<Page<Metadata>> {
    const { MediaContainer: mc } = await this.get<ListResponse>('/library/sections/watchlist/all', {
      includeCollections: 1,
      includeExternalMedia: 1,
      sort: 'watchlistedAt:desc',
      'X-Plex-Container-Start': offset,
      'X-Plex-Container-Size': limit,
    });
    const items = mc.Metadata ?? [];
    return { items, total: mc.totalSize ?? mc.size ?? items.length, offset };
  }

  async search(query: string, limit = 24): Promise<Metadata[]> {
    const { MediaContainer: mc } = await this.get<SearchResponse>('/library/search', {
      query,
      limit,
      searchTypes: 'movies,tv',
      searchProviders: 'discover',
      includeMetadata: 1,
    });
    // Les résultats arrivent par groupes ; on les fusionne par pertinence, sans doublon.
    const seen = new Set<string>();
    return (mc.SearchResults ?? [])
      .flatMap((g) => g.SearchResult ?? [])
      .filter((r): r is { Metadata: Metadata; score?: number } => !!r.Metadata?.ratingKey && (r.Metadata.type === 'movie' || r.Metadata.type === 'show'))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((r) => r.Metadata)
      .filter((m) => !seen.has(m.ratingKey) && !!seen.add(m.ratingKey));
  }

  async isWatchlisted(id: string): Promise<boolean> {
    const { MediaContainer: mc } = await this.get<ListResponse>(`/library/metadata/${encodeURIComponent(id)}/userState`);
    return !!mc.UserState?.[0]?.watchlistedAt;
  }

  async details(id: string): Promise<Metadata & { watchlisted: boolean }> {
    const [meta, watchlisted] = await Promise.all([
      this.get<ListResponse>(`/library/metadata/${encodeURIComponent(id)}`),
      this.isWatchlisted(id).catch(() => false),
    ]);
    const item = meta.MediaContainer.Metadata?.[0];
    if (!item) throw new Error('Titre introuvable');
    return { ...item, watchlisted };
  }

  async setWatchlisted(id: string, on: boolean): Promise<void> {
    const action = on ? 'addToWatchlist' : 'removeFromWatchlist';
    await request(`${BASE}/actions/${action}?ratingKey=${encodeURIComponent(id)}`, { method: 'PUT', headers: identityHeaders(this.client, this.token) });
  }
}

/** Catalogue factice du mode démo : même contrat, tout en mémoire. */
export class DemoDiscover implements Discover {
  private catalogue: Metadata[];
  private listed: string[];

  constructor() {
    const titles: [string, string, number][] = [
      ['Les Sentinelles du Nord', 'show', 2024],
      ['Un été à Port-Blanc', 'movie', 2023],
      ['La Mécanique des songes', 'movie', 2025],
      ['Archipel', 'show', 2022],
      ['Le Dernier Télégraphe', 'movie', 2019],
      ['Minuit à Lisbonne', 'movie', 2021],
      ['Brume', 'show', 2025],
      ['Les Cartographes', 'movie', 2018],
      ['Septième Vague', 'movie', 2024],
      ['Hors Saison', 'show', 2020],
      ['La Ligne claire', 'movie', 2026],
      ['Contre-jour', 'movie', 2022],
    ];
    this.catalogue = titles.map(([title, type, year], i) => {
      const hue = (i * 53 + 15) % 360;
      const svg = (w: number, h: number) =>
        `data:image/svg+xml,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},50%,38%)"/><stop offset="1" stop-color="hsl(${(hue + 70) % 360},55%,14%)"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><text x="${w * 0.08}" y="${h * 0.86}" font-family="system-ui,sans-serif" font-weight="700" font-size="${w * 0.075}" fill="#fff">${title.replace(/&/g, '&amp;')}</text></svg>`,
        )}`;
      const id = `d${String(i + 1).padStart(15, '0')}a`;
      return {
        ratingKey: id,
        guid: `plex://${type}/${id}`,
        type,
        title,
        year,
        thumb: svg(400, 600),
        art: svg(640, 360),
        summary: `« ${title} » n'est pas sur le serveur de démonstration. Ajoutez-le à votre liste de suivi pour le retrouver plus tard.`,
        duration: type === 'movie' ? (95 + i * 3) * 60000 : undefined,
        Genre: [{ tag: ['Drame', 'Aventure', 'Policier'][i % 3] }],
      };
    });
    this.listed = [this.catalogue[2].ratingKey, this.catalogue[0].ratingKey, this.catalogue[6].ratingKey];
  }

  async watchlist(offset: number, limit: number): Promise<Page<Metadata>> {
    const all = this.listed.map((id) => this.catalogue.find((m) => m.ratingKey === id)!).filter(Boolean);
    return { items: all.slice(offset, offset + limit), total: all.length, offset };
  }

  async search(query: string, limit = 24): Promise<Metadata[]> {
    const q = query.toLowerCase();
    return this.catalogue.filter((m) => m.title.toLowerCase().includes(q)).slice(0, limit);
  }

  async isWatchlisted(id: string): Promise<boolean> {
    return this.listed.includes(id);
  }

  async details(id: string): Promise<Metadata & { watchlisted: boolean }> {
    const item = this.catalogue.find((m) => m.ratingKey === id);
    if (!item) throw new Error('Titre introuvable');
    return { ...item, watchlisted: this.listed.includes(id) };
  }

  async setWatchlisted(id: string, on: boolean): Promise<void> {
    this.listed = this.listed.filter((x) => x !== id);
    if (on) this.listed.unshift(id);
  }
}
