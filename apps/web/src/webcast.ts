// Envoi vers un téléviseur depuis le navigateur (Chrome, Edge, Chrome sur Android), avec le
// kit officiel de Google. Le navigateur affiche lui-même la liste des appareils ; on ne charge le
// script de Google qu'au premier envoi, jamais avant. Même contrat que l'application de bureau.
import type { CastApi, CastMedia, CastStatus } from './native';

/* eslint-disable @typescript-eslint/no-explicit-any */
type W = Window & { chrome?: any; cast?: any; __onGCastApiAvailable?: (ok: boolean) => void; Capacitor?: { isNativePlatform?(): boolean } };
const w = window as W;

/** Navigateur Chromium, page sécurisée, hors application (bureau ou Android) : le kit fonctionne. */
export const webCastPossible = () =>
  typeof window !== 'undefined' && window.isSecureContext && !!w.chrome && !w.Capacitor?.isNativePlatform?.() && /Chrome|CriOS|Edg\//.test(navigator.userAgent);

let loading: Promise<void> | null = null;
function loadSdk(): Promise<void> {
  if (w.cast?.framework) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    w.__onGCastApiAvailable = (ok) => (ok ? resolve() : reject(new Error('cast-unavailable')));
    const s = document.createElement('script');
    s.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    s.async = true;
    s.onerror = () => reject(new Error('cast-sdk'));
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('cast-timeout')), 15000);
  }).catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

export function webCastApi(): CastApi {
  const listeners = new Set<(s: CastStatus) => void>();
  let player: any = null;
  let controller: any = null;
  let device = '';
  let wired = false;
  const emit = (s: Partial<CastStatus>) => {
    const full: CastStatus = {
      state: 'connecting',
      time: player?.currentTime ?? 0,
      duration: player?.duration ?? 0,
      volume: player?.volumeLevel ?? 1,
      muted: !!player?.isMuted,
      device,
      ...s,
    };
    for (const l of listeners) l(full);
  };

  const wire = () => {
    if (wired) return;
    wired = true;
    const { framework } = w.cast;
    player = new framework.RemotePlayer();
    controller = new framework.RemotePlayerController(player);
    controller.addEventListener(framework.RemotePlayerEventType.ANY_CHANGE, () => {
      if (!player.isConnected) return;
      const states: Record<string, CastStatus['state']> = { PLAYING: 'playing', PAUSED: 'paused', BUFFERING: 'buffering', IDLE: 'idle' };
      emit({ state: states[player.playerState] ?? 'connecting', ended: player.playerState === 'IDLE' && player.currentTime >= player.duration - 2 });
    });
    framework.CastContext.getInstance().addEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, (e: { sessionState: string }) => {
      if (e.sessionState === 'SESSION_ENDED') emit({ state: 'closed', reason: 'stopped' });
    });
  };

  return {
    browserPicker: true,
    async scan() {
      return [];
    },
    async start(_deviceId: string, media: CastMedia) {
      try {
        await loadSdk();
        const { chrome } = w;
        const context = w.cast.framework.CastContext.getInstance();
        context.setOptions({ receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
        wire();
        // Fenêtre du navigateur : la personne choisit l'appareil (ou annule).
        if (!context.getCurrentSession()) await context.requestSession();
        const session = context.getCurrentSession();
        if (!session) return { ok: false, error: 'cancel' };
        device = session.getCastDevice()?.friendlyName ?? '';
        const info = new chrome.cast.media.MediaInfo(media.url, media.contentType);
        info.streamType = chrome.cast.media.StreamType.BUFFERED;
        info.duration = media.duration || null;
        const meta = media.kind === 'episode' ? new chrome.cast.media.TvShowMediaMetadata() : new chrome.cast.media.MovieMediaMetadata();
        meta.title = media.kind === 'episode' ? media.sub || media.title : media.title;
        if (media.kind === 'episode') meta.seriesTitle = media.title;
        else meta.subtitle = media.sub;
        if (media.image) meta.images = [new chrome.cast.Image(media.image)];
        info.metadata = meta;
        const req = new chrome.cast.media.LoadRequest(info);
        req.currentTime = media.start || 0;
        req.autoplay = true;
        await session.loadMedia(req);
        emit({ state: 'buffering' });
        return { ok: true };
      } catch (e) {
        const code = typeof e === 'string' ? e : ((e as { code?: string; message?: string })?.code ?? (e as Error)?.message);
        return { ok: false, error: String(code ?? 'cast') };
      }
    },
    control(action, value) {
      if (!player || !controller) return;
      if (action === 'play' && player.isPaused) controller.playOrPause();
      else if (action === 'pause' && !player.isPaused) controller.playOrPause();
      else if (action === 'seek' && typeof value === 'number') {
        player.currentTime = Math.max(0, value);
        controller.seek();
      } else if (action === 'volume' && typeof value === 'number') {
        player.volumeLevel = Math.min(1, Math.max(0, value));
        controller.setVolumeLevel();
      } else if (action === 'mute' && !!value !== player.isMuted) controller.muteOrUnmute();
    },
    async stop() {
      w.cast?.framework?.CastContext.getInstance().getCurrentSession()?.endSession(true);
      return true;
    },
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Application Android : module natif « MultiplexCast » (fenêtre de choix d'appareil d'Android). */
export function androidCastApi(): CastApi | undefined {
  type Native = {
    available(): Promise<{ available: boolean }>;
    start(media: CastMedia): Promise<{ ok: boolean; error?: string }>;
    control(o: { action: string; value?: number | boolean }): Promise<void>;
    stop(): Promise<void>;
    addListener(event: 'status', cb: (s: CastStatus) => void): Promise<{ remove(): void }>;
  };
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?(): boolean; isPluginAvailable?(n: string): boolean; registerPlugin?<T>(n: string): T } }).Capacitor;
  if (!cap?.isNativePlatform?.() || !cap.isPluginAvailable?.('MultiplexCast') || !cap.registerPlugin) return undefined;
  const plugin = cap.registerPlugin<Native>('MultiplexCast');
  return {
    browserPicker: true,
    available: () => plugin.available().then((r) => !!r.available),
    scan: async () => [],
    start: (_id, media) => plugin.start(media),
    control: (action, value) => void plugin.control({ action, value }).catch(() => {}),
    stop: () => plugin.stop().then(() => true),
    onStatus(listener) {
      const handle = plugin.addListener('status', listener);
      return () => void handle.then((h) => h.remove());
    },
  };
}
