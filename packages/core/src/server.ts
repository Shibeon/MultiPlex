import { getJson, randomId, request } from './http';
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
    const mc = await this.mc<{ Metadata?: Metadata[] }>(`/library/metadata/${ratingKey}`, { includeMarkers: 1 });
    const m = mc.Metadata?.[0];
    if (!m) throw new Error('Élément introuvable');
    return m;
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

  async playback(item: Metadata, opts: PlaybackOptions): Promise<PlaybackPlan> {
    const d = planPlayback(item, opts);
    const session = randomId();
    const subtitleUrl = d.subtitle === 'sidecar' && d.subtitleStream?.key ? this.url(d.subtitleStream.key) : undefined;
    const common = { session, reason: d.reason, subtitle: d.subtitle, subtitleUrl };
    if (d.mode === 'direct') return { ...common, mode: 'direct', url: this.url(d.part.key) };
    const params = transcodeParams(item, opts, session, this.client);
    // Le serveur exige qu'on lui demande sa décision avant de démarrer : sans cet appel,
    // start.m3u8 répond 400 pour certains fichiers (constaté sur un vrai PMS).
    const decision = await this.mc<{ generalDecisionCode?: number; generalDecisionText?: string }>(
      '/video/:/transcode/universal/decision',
      params,
    );
    if ((decision.generalDecisionCode ?? 1000) >= 2000) {
      throw new Error(decision.generalDecisionText || 'Le serveur ne peut pas convertir cet élément');
    }
    return { ...common, mode: 'hls', url: this.url('/video/:/transcode/universal/start.m3u8', params) };
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

  async scrobble(ratingKey: string, watched: boolean): Promise<void> {
    await request(
      this.url(watched ? '/:/scrobble' : '/:/unscrobble', {
        identifier: 'com.plexapp.plugins.library',
        key: ratingKey,
      }),
    );
  }
}
