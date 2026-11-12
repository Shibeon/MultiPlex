import { HttpError, getJson, randomId, request } from './http';
import { planPlayback, transcodeParams } from './playback';
import type {
  ActiveSession,
  ClientInfo,
  Hub,
  ItemsQuery,
  Library,
  MediaServer,
  Metadata,
  Page,
  PlaybackOptions,
  PlaybackPlan,
  Stream,
  TimelineReport,
} from './types';

type Params = Record<string, string | number | undefined>;

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

  private url(path: string, params: Params = {}): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
    q.set('X-Plex-Token', this.token);
    q.set('X-Plex-Client-Identifier', this.client.clientId);
    return `${this.uri}${path}${path.includes('?') ? '&' : '?'}${q}`;
  }

  private async mc<T>(path: string, params?: Params): Promise<T> {
    const j = await getJson<{ MediaContainer: T }>(this.url(path, params));
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

  async metadata(ratingKey: string): Promise<Metadata> {
    const mc = await this.mc<{ Metadata?: Metadata[] }>(`/library/metadata/${ratingKey}`, { includeMarkers: 1, includeChapters: 1, includeGuids: 1 });
    const m = mc.Metadata?.[0];
    if (!m) throw new Error('Élément introuvable');
    return m;
  }

  async findByGuid(guid: string): Promise<Metadata | undefined> {
    return (await this.mc<{ Metadata?: Metadata[] }>('/library/all', { guid })).Metadata?.[0];
  }

  async children(ratingKey: string): Promise<Metadata[]> {
    return (await this.mc<{ Metadata?: Metadata[] }>(`/library/metadata/${ratingKey}/children`)).Metadata ?? [];
  }

  async search(query: string, limit = 20): Promise<Hub[]> {
    const hubs = (await this.mc<{ Hub?: Hub[] }>('/hubs/search', { query, limit })).Hub ?? [];
    return hubs.filter((h) => h.Metadata?.length);
  }

  image(path: string | undefined, width: number, height: number): string {
    if (!path) return '';
    if (/^(https?:|data:)/.test(path)) return path;
    return this.url('/photo/:/transcode', { width, height, minSize: 1, upscale: 1, url: path });
  }

  fileRequest(path: string): { url: string; headers: Record<string, string> } {
    if (/^https?:/.test(path)) return { url: path, headers: {} };
    return { url: this.uri + path, headers: { 'X-Plex-Token': this.token, 'X-Plex-Client-Identifier': this.client.clientId } };
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
      const res = await this.mc<Raw>('/video/:/transcode/universal/decision', params);
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
      url: this.url('/video/:/transcode/universal/start.m3u8', r.params),
    };
  }

  async stopTranscode(session: string): Promise<void> {
    await request(this.url('/video/:/transcode/universal/stop', { session }), { timeout: 5000 });
  }

  async selectStreams(partId: number, sel: { audioStreamID?: number; subtitleStreamID?: number }): Promise<void> {
    await request(this.url(`/library/parts/${partId}`, { ...sel, allParts: 1 }), { method: 'PUT' });
  }

  async timeline(r: TimelineReport): Promise<void> {
    await request(
      this.url('/:/timeline', {
        ratingKey: r.ratingKey,
        key: `/library/metadata/${r.ratingKey}`,
        state: r.state,
        time: Math.round(r.timeMs),
        duration: Math.round(r.durationMs),
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
      player: m.Player?.title || m.Player?.product || '',
      platform: m.Player?.platform || m.Player?.product,
      transcoding: m.TranscodeSession?.videoDecision === 'transcode' || m.TranscodeSession?.audioDecision === 'transcode',
      item: m,
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

  async scrobble(ratingKey: string, watched: boolean): Promise<void> {
    await request(
      this.url(watched ? '/:/scrobble' : '/:/unscrobble', {
        identifier: 'com.plexapp.plugins.library',
        key: ratingKey,
      }),
    );
  }
}
