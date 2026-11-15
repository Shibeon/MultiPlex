import { HttpError, getJson, randomId, request } from './http';
import { identityParams } from './identity';
import { peopleFromHubs } from './people';
import { planPlayback, transcodeParams } from './playback';
import type {
  ActiveSession,
  ClientInfo,
  Hub,
  ItemsQuery,
  Library,
  LibraryOptions,
  MediaServer,
  Metadata,
  Page,
  PlaybackOptions,
  PlaybackPlan,
  SearchResults,
  Stream,
  TimelineReport,
} from './types';

/** `undefined` : rien n'est envoyé ; `null` : retire aussi le champ d'identité de même nom. */
type Params = Record<string, string | number | undefined | null>;

/**
 * Conversion : le serveur choisit son profil d'après la plateforme et l'appareil que
 * `transcodeParams` déclare (voir playback.ts, et le repli sur l'ancien profil en cas de 400).
 * La version du système, le modèle et le fabricant réels n'y sont jamais allés : on ne les
 * ajoute pas à ce choix, dont l'effet n'a pas été mesuré. Le nom lisible, lui, part.
 */
const NO_PROFILE_HINTS: Params = { 'X-Plex-Platform-Version': null, 'X-Plex-Model': null, 'X-Plex-Device-Vendor': null };
/** Taille des pages lues pour l'index des identifiants externes. */
const GUID_PAGE = 500;

/**
 * Client d'un Plex Media Server. Tous les paramètres X-Plex-* passent dans
 * l'URL plutôt qu'en en-têtes : les requêtes restent « simples » au sens CORS
 * et évitent un aller-retour OPTIONS à chaque appel.
 */
export class PlexServer implements MediaServer {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly uri: string,
    private token: string,
    private client: ClientInfo,
  ) {}

  /**
   * Adresse d'une requête au serveur. Elle porte l'identité complète du client (produit, version,
   * plateforme, appareil, nom) : le serveur en tire la fiche « Lecteur » de la session qu'il
   * montre dans son tableau de bord. Un paramètre donné par l'appelant l'emporte (la conversion
   * choisit son profil par sa propre plateforme / son propre appareil) ; le jeton et
   * l'identifiant du client, eux, sont toujours les nôtres.
   *
   * `identity: false` : seulement le jeton et l'identifiant, pour les images. Elles ne créent
   * aucune session, et leur adresse sert de clé au cache HTTP du navigateur : y mettre la
   * version ferait tout retélécharger (et reconvertir par le serveur) à chaque mise à jour.
   */
  private url(path: string, params: Params = {}, identity = true): string {
    const q = new URLSearchParams(identity ? identityParams(this.client) : {});
    for (const [k, v] of Object.entries(params)) {
      if (v === null) q.delete(k);
      else if (v !== undefined) q.set(k, String(v));
    }
    q.set('X-Plex-Token', this.token);
    q.set('X-Plex-Client-Identifier', this.client.clientId);
    return `${this.uri}${path}${path.includes('?') ? '&' : '?'}${q}`;
  }

  private async mc<T>(path: string, params?: Params, timeout?: number): Promise<T> {
    const j = await getJson<{ MediaContainer: T }>(this.url(path, params), { timeout });
    return j.MediaContainer;
  }

  async libraries(): Promise<Library[]> {
    return (await this.mc<{ Directory?: Library[] }>('/library/sections')).Directory ?? [];
  }

  async hubs(sectionId?: string): Promise<Hub[]> {
    const path = sectionId ? `/hubs/sections/${sectionId}` : '/hubs';
    const hubs = (await this.mc<{ Hub?: Hub[] }>(path, { count: 20, includeOnDeck: 1 })).Hub ?? [];
    return hubs.filter((h) => h.Metadata?.length);
  }

  async items(sectionId: string, q: ItemsQuery): Promise<Page<Metadata>> {
    const mc = await this.mc<{ Metadata?: Metadata[]; totalSize?: number; size?: number }>(
      `/library/sections/${sectionId}/all`,
      {
        type: q.type,
        sort: q.sort,
        'X-Plex-Container-Start': q.offset,
        'X-Plex-Container-Size': q.limit,
        ...q.filter,
      },
    );
    const items = mc.Metadata ?? [];
    return { items, total: mc.totalSize ?? mc.size ?? items.length, offset: q.offset };
  }

  async libraryOptions(sectionId: string, type: number): Promise<LibraryOptions> {
    const mc = await this.mc<{ Meta?: { Type?: { type: string; key?: string; Filter?: LibraryOptions['filters']; Sort?: LibraryOptions['sorts'] }[] } }>(
      `/library/sections/${sectionId}/all`,
      { includeMeta: 1, type, 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 0 },
    );
    const types = mc.Meta?.Type ?? [];
    const t = types.find((x) => x.key?.includes(`type=${type}`)) ?? types[0];
    return { filters: t?.Filter ?? [], sorts: t?.Sort ?? [] };
  }

  async filterValues(key: string): Promise<{ key: string; title: string }[]> {
    const mc = await this.mc<{ Directory?: { key: string; title: string }[] }>(key);
    return (mc.Directory ?? []).filter((d) => d.key && d.title).map((d) => ({ key: String(d.key), title: d.title }));
  }

  async metadata(ratingKey: string): Promise<Metadata> {
    const mc = await this.mc<{ Metadata?: Metadata[] }>(`/library/metadata/${ratingKey}`, { includeMarkers: 1, includeChapters: 1, includeGuids: 1 });
    const m = mc.Metadata?.[0];
    if (!m) throw new Error('Élément introuvable');
    return m;
  }

  async findByGuid(guid: string): Promise<Metadata | undefined> {
    return (await this.mc<{ Metadata?: Metadata[] }>('/library/all', { guid })).Metadata?.[0];
  }

  async libraryGuids(): Promise<Metadata[]> {
    // Le serveur ne filtre pas sur un identifiant externe : on lit les films et séries avec leurs
    // `Guid` (includeGuids=1), par pages, et l'appelant en fait un index (python-plexapi fait de même).
    const out: Metadata[] = [];
    for (const lib of await this.libraries()) {
      if (lib.type !== 'movie' && lib.type !== 'show') continue;
      for (let start = 0; ; start += GUID_PAGE) {
        const mc = await this.mc<{ Metadata?: Metadata[]; totalSize?: number; size?: number }>(`/library/sections/${lib.key}/all`, {
          type: lib.type === 'movie' ? 1 : 2,
          includeGuids: 1,
          'X-Plex-Container-Start': start,
          'X-Plex-Container-Size': GUID_PAGE,
        });
        const page = mc.Metadata ?? [];
        for (const m of page) out.push({ ratingKey: m.ratingKey, type: m.type, title: m.title, year: m.year, guid: m.guid, Guid: m.Guid } as Metadata);
        if (page.length < GUID_PAGE || start + page.length >= (mc.totalSize ?? Infinity)) break;
      }
    }
    return out;
  }

  async children(ratingKey: string): Promise<Metadata[]> {
    return (await this.mc<{ Metadata?: Metadata[] }>(`/library/metadata/${ratingKey}/children`)).Metadata ?? [];
  }

  async search(query: string, limit = 20): Promise<SearchResults> {
    const hubs = (await this.mc<{ Hub?: Hub[] }>('/hubs/search', { query, limit })).Hub ?? [];
    // Les personnes arrivent dans leurs propres rangées, sous forme de `Directory` (sans `Metadata`).
    return { hubs: hubs.filter((h) => h.Metadata?.length), people: peopleFromHubs(hubs) };
  }

  image(path: string | undefined, width: number, height: number, opts?: { png?: boolean }): string {
    if (!path) return '';
    if (/^(https?:|data:)/.test(path)) return path;
    return this.url('/photo/:/transcode', { width, height, minSize: 1, upscale: 1, url: path, ...(opts?.png ? { format: 'png' } : {}) }, false);
  }

  previewThumbUrl(partId: number, ms: number): string {
    return this.url(`/library/parts/${partId}/indexes/sd/${ms}`, {}, false);
  }

  fileRequest(path: string): { url: string; headers: Record<string, string> } {
    if (/^https?:/.test(path)) return { url: path, headers: {} };
    // Lecteur natif, téléchargements : en-têtes, et non paramètres, pour garder le jeton hors de
    // l'adresse ; l'identité complète, pour que la lecture apparaisse sous notre nom.
    return { url: this.uri + path, headers: { ...identityParams(this.client), 'X-Plex-Token': this.token } };
  }

  async playback(item: Metadata, opts: PlaybackOptions): Promise<PlaybackPlan> {
    const d = planPlayback(item, opts);
    const session = randomId();
    const subtitleUrl = d.subtitle === 'sidecar' && d.subtitleStream?.key ? this.url(d.subtitleStream.key) : undefined;
    if (d.mode === 'direct') {
      return { session, reason: d.reason, subtitle: d.subtitle, subtitleUrl, mode: 'direct', url: this.url(d.part.key) };
    }

    // Le serveur exige qu'on lui demande sa décision avant de démarrer : sans cet appel,
    // start.m3u8 répond 400 pour certains fichiers (constaté sur un vrai PMS).
    type Raw = { generalDecisionCode?: number; generalDecisionText?: string; Metadata?: Metadata[] };
    const decide = async (hevc: boolean, legacy = false) => {
      // Des sous-titres externes sont chargés à part par le lecteur : inutile de les demander au serveur.
      const asked = d.subtitle === 'sidecar' ? { ...opts, subtitleStreamId: undefined } : opts;
      const params = transcodeParams(item, asked, session, this.client, hevc, legacy);
      // Sur un gros fichier (sous-titres intégrés à extraire, session précédente encore en
      // cours d'arrêt), le serveur peut mettre bien plus de 15 s à décider : on l'attend.
      const res = await this.mc<Raw>('/video/:/transcode/universal/decision', { ...params, ...NO_PROFILE_HINTS }, 60_000);
      if ((res.generalDecisionCode ?? 1000) >= 2000) {
        throw new Error(res.generalDecisionText || 'Le serveur ne peut pas convertir cet élément');
      }
      const streams = (res.Metadata?.[0]?.Media?.[0]?.Part?.[0]?.Stream ?? []) as (Stream & { decision?: string; location?: string })[];
      const of = (type: number) => streams.find((s) => s.streamType === type);
      return { params, video: of(1), audio: of(2), sub: of(3) };
    };

    // Le HEVC n'est proposé que pour être copié tel quel. Si le serveur compte
    // quand même réencoder, on redemande du H.264, bien plus léger à produire.
    const wantHevc = !!opts.hevc && d.keepVideo && opts.quality === 'original';
    let r = await decide(wantHevc).catch((e: unknown) => {
      // Profil refusé par ce serveur : on retombe sur l'ancien, connu pour fonctionner.
      if (e instanceof HttpError && e.status === 400) return decide(false, true);
      throw e;
    });
    if (wantHevc && r.video?.decision !== 'copy') r = await decide(false);

    const video = r.video?.decision === 'copy' ? 'copy' : 'transcode';
    const audio = r.audio?.decision === 'copy' ? 'copy' : 'transcode';
    const subtitle = d.subtitle !== 'burn' || !r.sub ? 'none' : r.sub.decision === 'burn' ? 'burn' : 'segmented';
    const what =
      video === 'copy' ? (audio === 'copy' ? 'flux direct' : 'vidéo d’origine, audio converti') : subtitle === 'burn' ? 'conversion vidéo, sous-titres incrustés' : 'conversion vidéo';
    return {
      session,
      mode: 'hls',
      reason: `${what} — ${d.reason}`,
      subtitle: d.subtitle === 'sidecar' ? 'sidecar' : subtitle,
      subtitleUrl,
      video,
      audio,
      url: this.url('/video/:/transcode/universal/start.m3u8', { ...r.params, ...NO_PROFILE_HINTS }),
    };
  }

  async stopTranscode(session: string): Promise<void> {
    await request(this.url('/video/:/transcode/universal/stop', { session }), { timeout: 5000 });
  }

  async selectStreams(partId: number, sel: { audioStreamID?: number; subtitleStreamID?: number }): Promise<void> {
    await request(this.url(`/library/parts/${partId}`, { ...sel, allParts: 1 }), { method: 'PUT' });
  }

  /**
   * Progression remontée au serveur, qui marque le titre vu quand elle dépasse son seuil (90 %
   * par défaut). Une valeur aberrante ne part donc jamais : position illisible, rien n'est
   * envoyé ; durée inconnue (Infinity d'un flux HLS, NaN, 0) ou plus courte que la position
   * (unités ou fichier différents), elle est omise et le serveur garde celle qu'il connaît.
   */
  async timeline(r: TimelineReport): Promise<void> {
    const time = Math.round(r.timeMs);
    if (!Number.isFinite(time) || time < 0) return;
    const duration = Math.round(r.durationMs);
    const knownDuration = Number.isFinite(duration) && duration > 0 && time <= duration ? duration : undefined;
    await request(
      this.url('/:/timeline', {
        ratingKey: r.ratingKey,
        key: `/library/metadata/${r.ratingKey}`,
        state: r.state,
        time,
        duration: knownDuration,
        'X-Plex-Session-Identifier': r.session,
      }),
      { timeout: 5000 },
    );
  }

  async sessions(): Promise<ActiveSession[]> {
    type Raw = Metadata & {
      sessionKey?: string;
      User?: { title?: string; thumb?: string };
      Player?: { state?: string; title?: string; product?: string; platform?: string };
      Session?: { id?: string };
      TranscodeSession?: { videoDecision?: string; audioDecision?: string };
    };
    const list = (await this.mc<{ Metadata?: Raw[] }>('/status/sessions')).Metadata ?? [];
    return list.map((m) => ({
      id: m.Session?.id ?? m.sessionKey ?? m.ratingKey,
      user: m.User?.title ?? '?',
      userThumb: m.User?.thumb,
      state: m.Player?.state ?? 'playing',
      // Ni l'appareil, ni l'adresse, ni la façon de lire : on montre ce que regarde un ami,
      // pas d'où ni comment (ces informations ne sont pas gardées).
      item: { ...m, Player: undefined, Session: undefined, TranscodeSession: undefined } as Metadata,
    }));
  }

  async personMedia(key: string): Promise<Metadata[]> {
    if (!/^[0-9a-z]{1,40}$/i.test(key)) return [];
    return (await this.mc<{ Metadata?: Metadata[] }>(`/library/people/${key}/media`)).Metadata ?? [];
  }

  async rate(ratingKey: string, rating: number | null): Promise<void> {
    await request(
      this.url('/:/rate', {
        identifier: 'com.plexapp.plugins.library',
        key: ratingKey,
        // -1 retire la note.
        rating: rating === null ? -1 : Math.max(0, Math.min(10, Math.round(rating))),
      }),
      { method: 'PUT' },
    );
  }

  async trailer(ratingKey: string): Promise<string | undefined> {
    const extras = (await this.mc<{ Metadata?: (Metadata & { extraType?: number; subtype?: string })[] }>(`/library/metadata/${ratingKey}/extras`)).Metadata ?? [];
    // extraType 1 : bande-annonce.
    return extras.find((e) => e.extraType === 1 || e.subtype === 'trailer')?.ratingKey;
  }

  async continueWatching(): Promise<Metadata[]> {
    const mc = await this.mc<{ Hub?: Hub[]; Metadata?: Metadata[] }>('/hubs/continueWatching', { count: 100 });
    return mc.Metadata ?? mc.Hub?.flatMap((h) => h.Metadata ?? []) ?? [];
  }

  async forDevice(url: string): Promise<string> {
    const mc = await this.mc<{ token?: string }>('/security/token', { type: 'delegation', scope: 'all' });
    if (!mc.token || !/^[w-]{8,200}$/.test(mc.token)) throw new Error('Jeton temporaire refusé par le serveur');
    const u = new URL(url);
    if (u.searchParams.has('X-Plex-Token')) u.searchParams.set('X-Plex-Token', mc.token);
    return u.toString();
  }

  async related(ratingKey: string, lang = 'fr'): Promise<Hub[]> {
    const hubs = (await this.mc<{ Hub?: Hub[] }>(`/library/metadata/${ratingKey}/related`, { count: 20, 'X-Plex-Language': lang })).Hub ?? [];
    // Coquille du serveur en français (« Séries asssociées »).
    return hubs.filter((h) => h.Metadata?.length).map((h) => ({ ...h, title: h.title.replace(/asssoci/g, 'associ') }));
  }

  async removeFromContinueWatching(ratingKey: string): Promise<void> {
    await request(this.url('/actions/removeFromContinueWatching', { ratingKey }), { method: 'PUT' });
  }

  async scrobble(ratingKey: string, watched: boolean): Promise<void> {
    await request(
      this.url(watched ? '/:/scrobble' : '/:/unscrobble', {
        identifier: 'com.plexapp.plugins.library',
        key: ratingKey,
      }),
    );
  }
}
