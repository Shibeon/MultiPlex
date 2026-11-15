import { identityHeaders } from './auth';
import { DEMO_LINKED, demoMovieTitle, demoMovieYear } from './demo';
import { getJson, request } from './http';
import { nameWords, peopleFromDiscover, type PersonHit } from './people';
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
  /** Personnes du catalogue dont le nom correspond à la recherche (acteurs, réalisateurs…). */
  searchPeople(query: string, limit?: number): Promise<PersonHit[]>;
  /** Fiche d'un titre du catalogue, avec `watchlisted`. */
  details(id: string): Promise<Metadata & { watchlisted: boolean }>;
  isWatchlisted(id: string): Promise<boolean>;
  setWatchlisted(id: string, on: boolean): Promise<void>;
  /** Fiche d'une personne (identifiant `tagKey` d'un acteur, d'un réalisateur…). */
  person(key: string): Promise<Person>;
  /** Sa filmographie complète, par métier. */
  credits(key: string): Promise<CreditGroup[]>;
  /** Tous les épisodes d'une saison connus du catalogue, à venir compris (identifiant de saison). */
  seasonEpisodes(seasonId: string, lang?: string): Promise<Metadata[]>;
}

/** Identifiant du catalogue d'une saison de serveur (`plex://season/<id>`), ou null. */
export function seasonCatalogId(guid: string | undefined): string | null {
  const m = /^plex:\/\/season\/([0-9a-f]{16,40})$/i.exec(guid ?? '');
  return m ? m[1] : null;
}

/**
 * Épisodes annoncés mais pas encore sur le serveur : absents de la bibliothèque (par numéro)
 * et pas encore diffusés, ou sans date. `today` au format AAAA-MM-JJ.
 */
export function upcomingEpisodes(catalogue: Metadata[], library: Metadata[], today: string): Metadata[] {
  const have = new Set(library.map((e) => e.index));
  return catalogue
    .filter((e) => e.index !== undefined && !have.has(e.index) && (!e.originallyAvailableAt || e.originallyAvailableAt >= today))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

export interface Person {
  key: string;
  name: string;
  thumb?: string;
  summary?: string;
  /** Date de naissance, « 1993-07-08 ». */
  born?: string;
  birthPlace?: string;
  /** Liens publics de la personne (réseaux sociaux…), en https uniquement. */
  links?: { title: string; url: string }[];
}

export interface CreditGroup {
  /** « actor », « director », « writer »… */
  type: string;
  title: string;
  credits: { role?: string; item: Metadata }[];
}

const personKey = (key: string) => {
  if (!/^[0-9a-f]{16,40}$/i.test(key)) throw new Error('Personne introuvable');
  return key;
};

const BASE = 'https://discover.provider.plex.tv';
const METADATA = 'https://metadata.provider.plex.tv';

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

/**
 * Logo (« clear logo ») d'un film ou d'une série : image au fond transparent que le
 * serveur Plex récupère lui-même auprès de ses sources (TMDB, Fanart.tv) et choisit
 * selon la langue de la bibliothèque. Une saison ou un épisode prend celui de sa série
 * (la liste d'images d'un épisode nomme déjà la série). Undefined pour les autres types,
 * ou quand la liste d'images du serveur n'en contient pas. Sans liste d'images (serveur
 * ancien), on demande l'adresse générique ; une réponse en erreur ramène au texte.
 */
export function clearLogoPath(item: Pick<Metadata, 'type' | 'ratingKey' | 'parentRatingKey' | 'grandparentRatingKey' | 'Image'>): string | undefined {
  const owner =
    item.type === 'movie' || item.type === 'show' ? item.ratingKey : item.type === 'season' ? item.parentRatingKey : item.type === 'episode' ? item.grandparentRatingKey : undefined;
  if (!owner) return undefined;
  const listed = item.Image?.find((i) => i.type === 'clearLogo' && i.url)?.url;
  if (listed) return listed;
  // La liste d'une saison ne porte pas toujours le logo de la série : on le demande à la série.
  if (item.Image && owner === item.ratingKey) return undefined;
  return `/library/metadata/${owner}/clearLogo`;
}

/**
 * Les quatre couleurs de coin d'une fiche (`#rrggbb`), ou undefined. Le serveur envoie
 * parfois la clé avec quatre coins noirs : ce n'est pas une palette, on l'ignore.
 */
export function ultraBlurCorners(item: Pick<Metadata, 'UltraBlurColors'>): { tl: string; tr: string; bl: string; br: string } | undefined {
  const raw = Array.isArray(item.UltraBlurColors) ? item.UltraBlurColors[0] : item.UltraBlurColors;
  if (!raw) return undefined;
  const hex = (v: string | undefined) => {
    const m = /^#?([0-9a-f]{6})$/i.exec((v ?? '').trim());
    return m ? `#${m[1].toLowerCase()}` : '#000000';
  };
  const c = { tl: hex(raw.topLeft), tr: hex(raw.topRight), bl: hex(raw.bottomLeft), br: hex(raw.bottomRight) };
  return Object.values(c).some((v) => v !== '#000000') ? c : undefined;
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
      // Identifiants externes (tableau `Guid`) quand le catalogue les fournit : ils servent à
      // retrouver un titre sur le serveur quand son identifiant Plex n'y correspond pas.
      includeGuids: 1,
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

  async searchPeople(query: string, limit = 10): Promise<PersonHit[]> {
    // Recherche de personnes du catalogue : `searchTypes=people` auprès du fournisseur de
    // métadonnées, comme dans l'exemple publié avec python-plexapi (ticket 1158). Chaque
    // personne y est un `Directory` ; toute autre forme est ignorée.
    const q = new URLSearchParams({ query, limit: String(limit), searchTypes: 'people', includeMetadata: '1', filterPeople: '1' });
    const { MediaContainer } = await getJson<{ MediaContainer?: unknown }>(`${METADATA}/library/search?${q}`, { headers: identityHeaders(this.client, this.token) });
    return peopleFromDiscover(MediaContainer);
  }

  async seasonEpisodes(seasonId: string, lang = 'fr'): Promise<Metadata[]> {
    // Le catalogue « discover » ne liste pas les épisodes d'une saison ; le fournisseur de
    // métadonnées, si (le même que celui du serveur), avec les épisodes annoncés et leur date.
    const q = new URLSearchParams({ 'X-Plex-Language': lang });
    const { MediaContainer: mc } = await getJson<ListResponse>(`${METADATA}/library/metadata/${encodeURIComponent(seasonId)}/children?${q}`, {
      headers: identityHeaders(this.client, this.token),
    });
    return mc.Metadata ?? [];
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

  async person(key: string): Promise<Person> {
    type Raw = { title?: string; thumb?: string; summary?: string; bornAt?: string; birthPlace?: string; External?: { sourceTitle?: string; url?: string }[] };
    const p = (await this.get<{ MediaContainer: { Metadata?: Raw[] } }>(`/library/people/${personKey(key)}`)).MediaContainer.Metadata?.[0];
    if (!p?.title) throw new Error('Personne introuvable');
    const links = (p.External ?? []).filter((e): e is { sourceTitle: string; url: string } => !!e.sourceTitle && /^https:\/\//.test(e.url ?? '')).map((e) => ({ title: e.sourceTitle, url: e.url }));
    return { key, name: p.title, thumb: p.thumb, summary: p.summary, born: p.bornAt, birthPlace: p.birthPlace, links };
  }

  async credits(key: string): Promise<CreditGroup[]> {
    type Raw = { title?: string; type?: string; Credit?: { role?: string; Metadata?: Metadata }[] };
    const groups = (await this.get<{ MediaContainer: { CreditGroup?: Raw[] } }>(`/library/people/${personKey(key)}/credits`)).MediaContainer.CreditGroup ?? [];
    return groups.map((g) => ({
      type: g.type ?? 'other',
      title: g.title ?? '',
      credits: (g.Credit ?? [])
        .filter((c): c is { role?: string; Metadata: Metadata } => !!c.Metadata?.ratingKey && (c.Metadata.type === 'movie' || c.Metadata.type === 'show'))
        // L'identifiant universel permet de retrouver l'œuvre sur le serveur.
        .map((c) => ({ role: c.role || undefined, item: { ...c.Metadata, guid: `plex://${c.Metadata.type}/${c.Metadata.ratingKey}` } }))
        .sort((a, b) => (b.item.year ?? 0) - (a.item.year ?? 0)),
    }));
  }

  async setWatchlisted(id: string, on: boolean): Promise<void> {
    const action = on ? 'addToWatchlist' : 'removeFromWatchlist';
    await request(`${BASE}/actions/${action}?ratingKey=${encodeURIComponent(id)}`, { method: 'PUT', headers: identityHeaders(this.client, this.token) });
  }
}

/** Catalogue factice du mode démo : même contrat, tout en mémoire. */
/** Remplace le titre incrusté dans une affiche SVG de démonstration. */
function retitle(image: string | undefined, from: string, to: string): string | undefined {
  return image?.replace(encodeURIComponent(from.replace(/&/g, '&amp;')), encodeURIComponent(to));
}

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
    // Assez de titres pour une vraie filmographie (plus d'une centaine de rôles) : des noms
    // composés, toujours les mêmes d'un lancement à l'autre.
    const heads = ['L’Ombre', 'Le Chant', 'La Nuit', 'Le Silence', 'La Route', 'Le Secret', 'La Saison', 'Le Rivage', 'La Mémoire', 'Le Voyage', 'La Lumière'];
    const tails = ['des glaces', 'du phare', 'de l’aube', 'des marées', 'du désert', 'des collines', 'du fleuve', 'de minuit', 'des forges', 'du large', 'des orages'];
    for (let i = 0; i < 121; i++) titles.push([`${heads[i % 11]} ${tails[(i * 4 + Math.floor(i / 11)) % 11]}`, i % 5 === 3 ? 'show' : 'movie', 2026 - Math.floor(i / 3)]);
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
    // Trois titres qui renvoient au serveur de démonstration (voir DEMO_LINKED) : un disponible
    // par identifiant Plex, un par identifiant TMDB, un dont la vérification échoue.
    const linked: [string, number, Partial<Metadata>][] = [
      [demoMovieTitle(DEMO_LINKED.sameGuid.movie), 1, { guid: DEMO_LINKED.sameGuid.guid, year: demoMovieYear(DEMO_LINKED.sameGuid.movie) }],
      [demoMovieTitle(DEMO_LINKED.sameTmdb.movie), 4, { guid: DEMO_LINKED.sameTmdb.catalogueGuid, year: demoMovieYear(DEMO_LINKED.sameTmdb.movie), Guid: [{ id: DEMO_LINKED.sameTmdb.tmdb }] }],
      [DEMO_LINKED.unreachable.title, 5, { guid: DEMO_LINKED.unreachable.guid, year: DEMO_LINKED.unreachable.year }],
    ];
    const extra = linked.map(([title, k, ids]) => {
      const summary = `« ${title} », titre de démonstration du catalogue.`;
      const base = { ...this.catalogue[k], type: 'movie', title, summary, Genre: [{ tag: 'Aventure' }], ...ids };
      const id = base.guid!.slice(base.guid!.lastIndexOf('/') + 1);
      return { ...base, ratingKey: id, thumb: retitle(base.thumb, this.catalogue[k].title, title), art: retitle(base.art, this.catalogue[k].title, title) };
    });
    this.catalogue.push(...extra);
    this.listed = [this.catalogue[2].ratingKey, extra[0].ratingKey, this.catalogue[0].ratingKey, extra[2].ratingKey, extra[1].ratingKey, this.catalogue[6].ratingKey];
  }

  async watchlist(offset: number, limit: number): Promise<Page<Metadata>> {
    const all = this.listed.map((id) => this.catalogue.find((m) => m.ratingKey === id)!).filter(Boolean);
    return { items: all.slice(offset, offset + limit), total: all.length, offset };
  }

  async search(query: string, limit = 24): Promise<Metadata[]> {
    const q = query.toLowerCase();
    return this.catalogue.filter((m) => m.title.toLowerCase().includes(q)).slice(0, limit);
  }

  async searchPeople(query: string, limit = 10): Promise<PersonHit[]> {
    // Quelques personnes fictives ; Inès Morel est aussi dans la distribution du serveur de démonstration.
    const words = nameWords(query).join(' ');
    if (!words) return [];
    const face = (hue: number) =>
      `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,46%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360},50%,18%)"/></linearGradient></defs><rect width="200" height="200" fill="url(#g)"/><circle cx="100" cy="78" r="38" fill="rgba(255,255,255,.55)"/><path d="M30 200c6-48 36-74 70-74s64 26 70 74z" fill="rgba(255,255,255,.55)"/></svg>`,
      )}`;
    const people: PersonHit[] = [
      {
        key: 'demo00000000000000b0',
        name: 'Inès Morel',
        thumb: face(200),
        score: 0.9,
        jobs: [
          { type: 'actor', title: 'Actor', count: 117 },
          { type: 'appeared', title: 'Appearances', count: 9 },
          { type: 'producer', title: 'Producer', count: 6 },
          { type: 'director', title: 'Director', count: 3 },
        ],
      },
      { key: 'demo00000000000000d1', name: 'Inès Moreau', thumb: face(20), score: 0.5, jobs: [{ type: 'actor', title: 'Actor', count: 24 }] },
      { key: 'demo00000000000000d2', name: 'Jules Morel', thumb: face(120), score: 0.4, jobs: [{ type: 'writer', title: 'Writer', count: 7 }] },
    ];
    return people.filter((p) => nameWords(p.name).join(' ').includes(words)).slice(0, limit);
  }

  async isWatchlisted(id: string): Promise<boolean> {
    return this.listed.includes(id);
  }

  async seasonEpisodes(): Promise<Metadata[]> {
    return [];
  }

  async details(id: string): Promise<Metadata & { watchlisted: boolean }> {
    const item = this.catalogue.find((m) => m.ratingKey === id);
    if (!item) throw new Error('Titre introuvable');
    return { ...item, watchlisted: this.listed.includes(id) };
  }

  async person(key: string): Promise<Person> {
    return { key, name: '', summary: 'Personne fictive du mode démo. Connectez votre compte Plex pour lire les vraies biographies.', born: '1984-03-12', birthPlace: 'Port-Blanc' };
  }

  async credits(): Promise<CreditGroup[]> {
    // Une carrière fournie : 117 rôles, quelques apparitions, de la production, de la réalisation.
    const c = this.catalogue;
    const group = (type: string, title: string, items: Metadata[], roles: string[]): CreditGroup => ({ type, title, credits: items.map((item, i) => ({ role: roles[i % roles.length], item })) });
    return [
      group('actor', 'Actor', c.slice(0, 117), ['La capitaine', 'Le témoin', 'Elle-même']),
      group('appeared', 'Appearances', c.slice(40, 49), ['Elle-même']),
      group('producer', 'Producer', c.slice(60, 66), ['Productrice', 'Productrice déléguée']),
      group('director', 'Director', c.slice(100, 103), ['Réalisatrice']),
      group('other', 'Other', c.slice(120, 124), ['Consultante', 'Remerciements']),
    ];
  }

  async setWatchlisted(id: string, on: boolean): Promise<void> {
    this.listed = this.listed.filter((x) => x !== id);
    if (on) this.listed.unshift(id);
  }
}
