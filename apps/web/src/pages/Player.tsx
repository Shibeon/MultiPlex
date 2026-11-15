import { lockLandscape, useLandscape } from '../orientation';
import { tvDevice } from '../platform';
import { PillMenu, PlayerClock, PlayerOutput, PlayerSub, Pill, SkipButton, liveTechWeb } from '../playerui';
import { AUDIO_MODES, QUALITIES, audioModeOf, audioRouteDecision, webAudioSafe, type AudioMode, type MediaKind, hdrKind, srtToVtt, streamsOf, techBadges, type Media, type Metadata, type PlaybackPlan, type Stream } from '@multiplex/core';
import type Hls from 'hls.js';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { serverThumbs } from '../thumbs';
import { formatClock, t } from '../i18n';
import { back, go, route } from '../router';
import { withCommunityMarkers } from '../markers';
import { settings, update } from '../settings';
import { AudioGraph, audioKindFailed, corsReadable, graphOf, markAudioKindFailed, webAudioAvailable, type GraphFailure } from '../audiograph';
import { invalidate, server } from '../store';
import { dequeue, upNext } from '../queue';
import { Icon, Spinner, labels, SeekPreview } from '../ui';
import { castApi, castEnabled, openCast } from '../cast';
import { attachPlayer } from '../together';

type Menu = null | 'audio' | 'sub' | 'quality' | 'speed' | 'chapter' | 'version' | 'audiomode' | 'more';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Le navigateur sait-il décoder le HEVC 10 bits ? Si oui, le serveur peut copier la vidéo d'origine dans le flux. */
function canDecodeHevc(): boolean {
  const type = 'video/mp4; codecs="hvc1.2.4.L153.B0"';
  try {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type);
  } catch {
    return false;
  }
}

/** Par où passe la vidéo : réseau local, Internet, ou relais Plex (limité à quelques Mbps). */
function connectionLabel(uri: string | undefined): string {
  if (!uri) return '?';
  try {
    const u = new URL(uri);
    const ip = /^(\d+)-(\d+)-\d+-\d+\./.exec(u.hostname);
    const a = ip ? Number(ip[1]) : NaN;
    const b = ip ? Number(ip[2]) : NaN;
    const local = /^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname) || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
    if (local) return 'réseau local';
    return u.port === '8443' ? 'relais Plex (débit limité)' : 'Internet';
  } catch {
    return '?';
  }
}

const versionLabel = (m: Media) =>
  [m.videoResolution && (/^\d+$/.test(m.videoResolution) ? `${m.videoResolution}p` : m.videoResolution.toUpperCase()), m.videoCodec?.toUpperCase(), m.bitrate && `${(m.bitrate / 1000).toFixed(1)} Mbps`, m.container?.toUpperCase()]
    .filter(Boolean)
    .join(' · ');

const streamLabel = (s: Stream) => s.extendedDisplayTitle ?? s.displayTitle ?? s.title ?? s.language ?? `#${s.id}`;

export function Player({ id }: { id: string }) {
  const srv = server.value!;
  const video = useRef<HTMLVideoElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const hls = useRef<Hls | null>(null);
  // Téléphone : le lecteur s'affiche toujours en paysage.
  useLandscape();
  const plan = useRef<PlaybackPlan | null>(null);
  const itemRef = useRef<Metadata | null>(null);
  const gen = useRef(0);
  const recovered = useRef(false);
  const skipped = useRef(new Set<number>());
  const retries = useRef(0);
  const lastTime = useRef(0);
  const hideTimer = useRef(0);
  const choice = useRef({ audio: 0, sub: 0, quality: settings.value.quality, force: false, media: 0, speed: 1 });

  const [item, setItem] = useState<Metadata | null>(null);
  const [next, setNext] = useState<Metadata | null>(null);
  const [prev, setPrev] = useState<Metadata | null>(null);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<Menu>(null);
  const [visible, setVisible] = useState(true);
  const [trackUrl, setTrackUrl] = useState('');
  const [stats, setStats] = useState<string[] | null>(null);
  const [ui, setUi] = useState({ playing: false, time: 0, duration: 0, buffering: true, muted: false, reason: '' });
  const patch = (p: Partial<typeof ui>) => setUi((u) => ({ ...u, ...p }));

  // Mode audio (Web Audio, voir audiograph.ts). Un élément <video> branché sur Web Audio ne peut
  // plus jouer sans : quand le média ne le permet pas (ou que le mode est désactivé), le lecteur
  // remplace l'élément (`videoKey`) et reprend au même endroit, son coupé et volume compris.
  // Seule perte : une image dans l'image en cours se referme (elle suit l'ancien élément).
  const [videoKey, setVideoKey] = useState(0);
  const restart = useRef<{ at: number; how: 'start' | 'reuse'; muted: boolean; volume: number } | null>(null);
  const graph = useRef<AudioGraph | null>(null);
  /** Le média en cours peut-il passer par Web Audio : oui, non, ou pas encore vérifié (CORS). */
  const audioSafe = useRef<boolean | null>(null);
  /** Chargement en cours : un mode choisi pendant ce temps est relu par le chargement lui-même. */
  const loading = useRef(false);
  /** Type du média en cours (pour retenir un échec pour la séance). */
  const audioKind = useRef<MediaKind>('direct');
  /** L'élément a été chargé en `crossorigin` pour le mode (pas pour la lecture elle-même). */
  const modeCors = useRef(false);
  /** Le garde-fou a vu un échec : plus de mode audio pour ce titre. */
  const audioBlocked = useRef(false);
  const failNoticed = useRef(false);
  const audioOffered = () => !tvDevice && webAudioAvailable();
  const [audioUi, setAudioUi] = useState({ shown: audioOffered(), waiting: false, failed: false });
  const patchAudio = (p: Partial<typeof audioUi>) => setAudioUi((a) => ({ ...a, ...p }));
  /**
   * Mode appliqué par ce lecteur : aucun sur téléviseur (son décodé par le matériel, que Web
   * Audio reçoit muet) ni sans Web Audio. Le réglage, lui, reste tel quel.
   */
  const effectiveMode = (): AudioMode => (audioOffered() ? audioModeOf(settings.value.audioMode) : 'off');

  const media = item?.Media?.[choice.current.media] ?? item?.Media?.[0];
  const part = media?.Part?.[0];
  const audioStreams = streamsOf(part, 2);
  const subStreams = streamsOf(part, 3);

  // Aperçus de la barre : vignettes préparées par le serveur Plex (« aperçus vidéo »), lues à la
  // demande. Sans elles, la bulle n'affiche que l'heure.
  const partId = part?.id;
  const thumbs = useMemo(() => (partId && srv.previewThumbUrl ? serverThumbs((ms) => srv.previewThumbUrl!(partId, ms)) : null), [partId]);
  useEffect(() => () => thumbs?.dispose(), [thumbs]);

  const teardown = async () => {
    hls.current?.destroy();
    hls.current = null;
    const p = plan.current;
    plan.current = null;
    if (p?.mode === 'hls') await srv.stopTranscode(p.session).catch(() => {});
  };

  /** Un transcodage qui échoue au démarrage est retenté une fois : le serveur refuse parfois une session lancée trop tôt après la précédente. */
  const retryOnce = (): boolean => {
    if (retries.current >= 1) return false;
    retries.current++;
    const mine = gen.current;
    setTimeout(() => mine === gen.current && void start(lastTime.current), 1500);
    return true;
  };

  const report = (state: 'playing' | 'paused' | 'stopped') => {
    const v = video.current;
    const it = itemRef.current;
    const p = plan.current;
    if (!v || !it || !p || !v.currentTime) return;
    srv
      .timeline({ ratingKey: it.ratingKey, state, timeMs: v.currentTime * 1000, durationMs: Number.isFinite(v.duration) && v.duration > 0 ? v.duration * 1000 : it.duration || 0, session: p.session })
      .catch(() => {});
  };

  const start = async (at: number) => {
    const it = itemRef.current;
    const v = video.current;
    if (!it || !v) return;
    const mine = ++gen.current;
    setError('');
    patch({ buffering: true });
    lastTime.current = at;
    loading.current = true;
    audioSafe.current = null;
    // Élément branché sur Web Audio alors que le mode est désactivé (ou a échoué) : remplacé
    // avant de demander le média, pour ne pas le demander deux fois.
    if (graphOf(v) && (effectiveMode() === 'off' || audioBlocked.current)) return remount(at, 'start');
    // On attend l'arrêt de la session précédente : en lancer deux à la fois fait répondre 400 au serveur.
    await teardown();
    if (mine !== gen.current) return;
    setTrackUrl((old) => (old && URL.revokeObjectURL(old), ''));
    const c = choice.current;
    try {
      // HDR sur écran SDR : au choix de l'utilisateur, c'est le serveur qui convertit l'image.
      const source = streamsOf((it.Media?.[c.media] ?? it.Media?.[0])?.Part?.[0], 1)[0];
      const sdrFix = settings.value.hdrServerOnSdr && !!hdrKind(source) && !matchMedia('(dynamic-range: high)').matches;
      const p = await srv.playback(it, {
        quality: c.quality,
        forceTranscode: c.force || !settings.value.directPlay || sdrFix,
        audioStreamId: c.audio || undefined,
        subtitleStreamId: c.sub || undefined,
        canPlay: (mime) => !!v.canPlayType(mime),
        hevc: canDecodeHevc() && !sdrFix,
        mediaIndex: c.media,
      });
      if (mine !== gen.current) return;
      plan.current = p;
      patch({ reason: p.reason });

      if (p.subtitle === 'sidecar' && p.subtitleUrl) {
        // Sous-titres externes : convertis en WebVTT côté client, la vidéo reste en lecture directe.
        fetch(p.subtitleUrl)
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error('subs'))))
          .then((txt) => {
            if (mine === gen.current) setTrackUrl(URL.createObjectURL(new Blob([srtToVtt(txt)], { type: 'text/vtt' })));
          })
          .catch(() => {});
      }

      // hls.js n'est téléchargé que si le passage par le serveur est réellement nécessaire.
      // On le préfère à la lecture HLS native : lui seul affiche les sous-titres livrés à part.
      const HlsLib = p.mode === 'hls' ? (await import('hls.js')).default : null;
      if (mine !== gen.current) return;
      await load(p, HlsLib, at, mine);
    } catch (e) {
      if (mine === gen.current) {
        loading.current = false;
        setError((e as Error).message);
      }
    }
  };

  /** Recharge le plan en cours (sans nouvelle session serveur) dans l'élément actuel. */
  const reload = async (at: number) => {
    const p = plan.current;
    if (!p || !video.current) return;
    const mine = ++gen.current;
    loading.current = true;
    audioSafe.current = null;
    hls.current?.destroy();
    hls.current = null;
    patch({ buffering: true });
    try {
      const HlsLib = p.mode === 'hls' ? (await import('hls.js')).default : null;
      if (mine !== gen.current) return;
      await load(p, HlsLib, at, mine);
    } catch (e) {
      if (mine === gen.current) {
        loading.current = false;
        setError((e as Error).message);
      }
    }
  };

  /**
   * Charge le plan dans l'élément. Le choix (Web Audio ou non, `crossorigin` ou non, élément à
   * remplacer) est refait après chaque attente avec l'état du moment : un mode choisi pendant
   * la vérification CORS, ou un élément branché entre-temps, sont pris en compte.
   */
  const load = async (p: PlaybackPlan, HlsLib: typeof Hls | null, at: number, mine: number) => {
    const v = video.current;
    if (!v) return;
    const c = choice.current;
    const kind: MediaKind = HlsLib?.isSupported() ? 'mse' : p.mode === 'hls' ? 'native-hls' : 'direct';
    audioKind.current = kind;
    const sameOrigin = webAudioSafe({ kind: 'direct', url: p.url, pageOrigin: location.origin });
    let cors: boolean | undefined;
    for (;;) {
      const mode = effectiveMode();
      const d = audioRouteDecision({ mode, kind, sameOrigin, claimed: !!graphOf(v), blocked: audioBlocked.current || audioKindFailed(kind), cors });
      if (d.action === 'probe') {
        // Vérifié seulement si un mode le demande : la lecture par défaut ne change pas.
        cors = await corsReadable(p.url);
        if (mine !== gen.current) return;
        continue;
      }
      // Élément déjà branché qui ne doit (ou ne peut) plus l'être : élément neuf, même plan.
      if (d.action === 'swap') return remount(at, 'reuse');
      dropPendingAudio();
      modeCors.current = d.crossOrigin;
      if (d.crossOrigin) v.crossOrigin = 'anonymous';
      else v.removeAttribute('crossorigin');
      audioSafe.current = d.safe;
      // Mode enregistré mais inapplicable ici : l'entrée disparaît de « Plus », et on le dit une fois.
      // Échec déjà retenu pour la séance : annoncé une fois, au titre où il a eu lieu.
      const failed = mode !== 'off' && d.safe === false && !failNoticed.current && !audioKindFailed(kind);
      if (failed) failNoticed.current = true;
      // (Une note déjà affichée par le garde-fou ou une erreur de chargement reste.)
      patchAudio(failed ? { shown: audioOffered() && d.safe !== false, failed } : { shown: audioOffered() && d.safe !== false });

      if (HlsLib?.isSupported()) {
        // Réglages pour les gros fichiers (4K d'origine copiée, 50 à 100 Mbps) : par défaut, hls.js
        // plafonne l'avance à 60 Mo (6 s à 80 Mbps, d'où des arrêts) et garde tout ce qui a été lu,
        // jusqu'à saturer la mémoire que Chrome accorde à la vidéo. Le serveur, lui, peut mettre plus
        // de 10 s à préparer le début d'un très gros fichier : on l'attend au lieu de recommencer.
        const h = new HlsLib({
          startPosition: at,
          maxBufferLength: 40,
          maxMaxBufferLength: 90,
          maxBufferSize: 120 * 1000 * 1000,
          backBufferLength: 20,
          startFragPrefetch: true,
          manifestLoadingTimeOut: 30_000,
          fragLoadingTimeOut: 40_000,
        });
        hls.current = h;
        h.on(HlsLib.Events.SUBTITLE_TRACKS_UPDATED, () => {
          h.subtitleDisplay = p.subtitle === 'segmented';
          h.subtitleTrack = p.subtitle === 'segmented' ? 0 : -1;
        });
        h.on(HlsLib.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === HlsLib.ErrorTypes.MEDIA_ERROR && !recovered.current) {
            recovered.current = true;
            h.recoverMediaError();
          } else if (!retryOnce()) setError(`${t('player.error')} (${data.details})`);
        });
        h.loadSource(p.url);
        h.attachMedia(v);
      } else if (p.mode === 'hls' && !v.canPlayType('application/vnd.apple.mpegurl')) {
        loading.current = false;
        return setError(t('player.unsupported'));
      } else {
        v.src = p.url;
        if (at > 0) v.addEventListener('loadedmetadata', () => (v.currentTime = at), { once: true });
      }
      v.defaultPlaybackRate = c.speed;
      v.playbackRate = c.speed;
      v.play().catch(() => {});
      loading.current = false;
      if (d.route) attachAudio(mode);
      return;
    }
  };

  /** Canaux de la piste qui sort (inconnus si le serveur réencode l'audio). */
  const audioChannels = (): number | undefined => {
    if (plan.current?.audio === 'transcode') return undefined;
    const p = (itemRef.current?.Media?.[choice.current.media] ?? itemRef.current?.Media?.[0])?.Part?.[0];
    const list = streamsOf(p, 2);
    return (list.find((s) => s.id === choice.current.audio) ?? list[0])?.channels;
  };

  /** Graphe qui attend encore un geste pour se brancher (l'élément n'est pas touché) : abandonné. */
  const dropPendingAudio = () => {
    if (!graph.current || graph.current.connected) return;
    graph.current.dispose();
    graph.current = null;
    patchAudio({ waiting: false });
  };

  /** Le média a-t-il une piste audio (d'après le serveur) ? Sans piste, des zéros ne prouvent rien. */
  const hasAudio = () => {
    const m = itemRef.current?.Media?.[choice.current.media] ?? itemRef.current?.Media?.[0];
    return streamsOf(m?.Part?.[0], 2).length > 0 || !!m?.audioCodec;
  };

  const attachAudio = (mode: AudioMode) => {
    const el = video.current;
    if (!el) return;
    graph.current = AudioGraph.attach(el, mode, { channels: audioChannels(), hasAudio: hasAudio() }, {
      onWaiting: (waiting) => patchAudio({ waiting }),
      onFail: (why: GraphFailure) => {
        // Web Audio ne rend pas le son : élément neuf, sans Web Audio, au même endroit. Le
        // réglage reste. Silence confirmé (l'élément a du son, Web Audio rien) : plus d'essai
        // pour ce type de lecture jusqu'à la fermeture de l'application.
        if (why === 'no-signal') markAudioKindFailed(audioKind.current);
        audioBlocked.current = true;
        patchAudio({ shown: false, failed: true, waiting: false });
        if (el === video.current) remount(el.currentTime, 'reuse');
      },
    });
  };

  /**
   * Remplace l'élément <video> (le précédent reste branché sur Web Audio) et relance la lecture :
   * `start` redemande le média au serveur, `reuse` recharge le plan en cours.
   */
  const remount = (at: number, how: 'start' | 'reuse') => {
    gen.current++;
    graph.current?.dispose();
    graph.current = null;
    const old = video.current;
    // hls.js lâche l'ancien élément (la session serveur, elle, reste ouverte pour `reuse`).
    hls.current?.destroy();
    hls.current = null;
    restart.current = { at, how, muted: old?.muted ?? false, volume: old?.volume ?? 1 };
    if (old) {
      old.pause();
      old.removeAttribute('src');
      old.load();
    }
    loading.current = true;
    patchAudio({ waiting: false });
    setVideoKey((k) => k + 1);
  };
  useEffect(() => {
    const r = restart.current;
    const el = video.current;
    if (!r || !el) return;
    restart.current = null;
    el.muted = r.muted;
    el.volume = r.volume;
    void (r.how === 'start' ? start(r.at) : reload(r.at));
  }, [videoKey]);
  useEffect(() => () => graph.current?.dispose(), []);

  /** Mode choisi dans « Plus » : appliqué tout de suite au média en cours. */
  const chooseAudioMode = (chosen: AudioMode) => {
    update({ audioMode: chosen });
    patchAudio({ failed: false });
    failNoticed.current = false;
    // Chargement en cours : il relit le mode après chaque attente.
    if (loading.current) return;
    const el = video.current;
    if (!el || !plan.current) return;
    const mode = effectiveMode();
    const g = graphOf(el);
    // Désactivé sur un élément branché : élément neuf tout de suite, sans nouvelle session.
    if (g) return mode === 'off' ? remount(el.currentTime, 'reuse') : g.setMode(mode, { channels: audioChannels() });
    dropPendingAudio();
    if (mode === 'off') return;
    if (audioSafe.current) attachAudio(mode);
    // Fichier d'un autre serveur chargé sans CORS : rechargé (après vérification) au même endroit.
    else if (audioSafe.current === null) void reload(el.currentTime);
  };

  // Chargement de l'élément, puis de l'épisode suivant.
  useEffect(() => {
    let alive = true;
    audioBlocked.current = false;
    failNoticed.current = false;
    patchAudio({ failed: false });
    skipped.current.clear();
    recovered.current = false;
    setNext(null);
    setPrev(null);
    setItem(null);
    srv
      .metadata(id)
      .then(async (it) => {
        if (!alive) return;
        itemRef.current = it;
        const p = it.Media?.[0]?.Part?.[0];
        choice.current = {
          audio: streamsOf(p, 2).find((s) => s.selected)?.id ?? 0,
          sub: streamsOf(p, 3).find((s) => s.selected)?.id ?? 0,
          quality: settings.value.quality,
          force: false,
          media: 0,
          speed: 1,
        };
        setItem(it);
        void withCommunityMarkers(srv, it).then((full) => {
          if (!alive || full === it || itemRef.current !== it) return;
          itemRef.current = full;
          setItem(full);
        });
        dequeue(it.ratingKey);
        const queued = upNext.peek()[0];
        if (queued) setNext({ ratingKey: queued.ratingKey, title: queued.title, type: 'queued' });
        const t0 = route.value.query.get('t');
        void start(t0 !== null ? Number(t0) || 0 : (it.viewOffset ?? 0) / 1000);
        if (it.type === 'episode' && it.parentRatingKey) {
          const eps = await srv.children(it.parentRatingKey).catch(() => []);
          const i = eps.findIndex((e) => e.ratingKey === it.ratingKey);
          let following = i >= 0 ? eps[i + 1] : undefined;
          if (!following && i >= 0 && it.grandparentRatingKey) {
            // Dernier épisode de la saison : on enchaîne sur le premier de la saison suivante.
            const seasons = await srv.children(it.grandparentRatingKey).catch(() => []);
            const after = seasons.filter((s) => (s.index ?? 0) > (it.parentIndex ?? 0)).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0];
            if (after) following = (await srv.children(after.ratingKey).catch(() => []))[0];
          }
          if (alive && following) setNext((cur) => cur ?? following);
          // Épisode précédent, y compris le dernier de la saison d'avant.
          let previous = i > 0 ? eps[i - 1] : undefined;
          if (!previous && i === 0 && it.grandparentRatingKey) {
            const all = await srv.children(it.grandparentRatingKey).catch(() => []);
            const before = all.filter((s) => (s.index ?? 0) > 0 && (s.index ?? 0) < (it.parentIndex ?? 0)).sort((a, b) => (b.index ?? 0) - (a.index ?? 0))[0];
            if (before) previous = (await srv.children(before.ratingKey).catch(() => [])).pop();
          }
          if (alive && previous) setPrev(previous);
        }
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
      gen.current++;
      report('stopped');
      void teardown();
      invalidate(`${srv.id}:`);
    };
  }, [id]);

  // Progression envoyée au serveur toutes les 10 s.
  useEffect(() => {
    const timer = setInterval(() => {
      const v = video.current;
      if (v && !v.paused) report('playing');
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  const wake = () => {
    setVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (video.current && !video.current.paused) setVisible(false);
    }, 3500);
  };
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const v = () => video.current!;
  const toggle = () => (v().paused ? void v().play().catch(() => {}) : v().pause());
  const seekBy = (d: number) => (v().currentTime = Math.max(0, Math.min((v().duration || Infinity) - 1, v().currentTime + d)));
  const fullscreen = () => {
    type Webkit = { webkitFullscreenElement?: Element; webkitExitFullscreen?(): void; webkitRequestFullscreen?(): void; webkitEnterFullscreen?(): void };
    const doc = document as Document & Webkit;
    if (document.fullscreenElement) return void document.exitFullscreen().catch(() => {});
    if (doc.webkitFullscreenElement) return void doc.webkitExitFullscreen?.();
    const el = root.current as (HTMLElement & Webkit) | null;
    // iPhone (Safari comme Chrome, même moteur) : pas de plein écran pour la page, seulement pour
    // la vidéo, avec le lecteur d'iOS. Nos commandes y sont remplacées par les siennes.
    const ios = () => (video.current as (HTMLVideoElement & Webkit) | null)?.webkitEnterFullscreen?.();
    if (el?.requestFullscreen) return void el.requestFullscreen().then(lockLandscape, ios);
    if (el?.webkitRequestFullscreen) return void el.webkitRequestFullscreen();
    ios();
  };
  const leave = () => back();
  const playNext = () => next && go(`/play/${next.ratingKey}?t=0`, true);

  // Envoi vers un téléviseur depuis le navigateur : Chromecast (Chrome, Edge, Chrome Android) et
  // AirPlay (Safari) via la « lecture à distance » du navigateur, qui affiche son propre choix
  // d'appareil. Le bouton n'apparaît que si le navigateur trouve un appareil pour cette vidéo.
  const [remote, setRemote] = useState({ ok: false, on: false });
  useEffect(() => {
    type Remote = EventTarget & { state: string; watchAvailability(cb: (a: boolean) => void): Promise<number>; cancelWatchAvailability(id?: number): Promise<void> };
    const el = video.current as (HTMLVideoElement & { remote?: Remote }) | null;
    if (!el || castApi) return;
    const r = el.remote;
    let watch: number | undefined;
    r?.watchAvailability((ok) => setRemote((s) => ({ ...s, ok }))).then(
      (id) => (watch = id),
      () => {
        /* flux non transmissible (lecture via MediaSource, par exemple) : pas de bouton */
      },
    );
    const state = () => setRemote((s) => ({ ...s, on: r?.state === 'connected' }));
    for (const ev of ['connect', 'connecting', 'disconnect']) r?.addEventListener(ev, state);
    // Safari plus ancien : AirPlay par son propre événement.
    const air = (e: Event) => setRemote((s) => ({ ...s, ok: (e as Event & { availability?: string }).availability === 'available' }));
    el.addEventListener('webkitplaybacktargetavailabilitychanged', air);
    return () => {
      if (watch !== undefined) void r?.cancelWatchAvailability(watch).catch(() => {});
      for (const ev of ['connect', 'connecting', 'disconnect']) r?.removeEventListener(ev, state);
      el.removeEventListener('webkitplaybacktargetavailabilitychanged', air);
    };
  }, [videoKey]);
  const castHere = () => {
    const el = v() as HTMLVideoElement & { remote?: { prompt(): Promise<void> }; webkitShowPlaybackTargetPicker?: () => void };
    // Application de bureau ou Chrome : notre envoi, depuis la position actuelle.
    if (castEnabled.value && itemRef.current) {
      el.pause();
      const it = itemRef.current;
      const at = el.currentTime;
      back();
      openCast(it, at);
    } else if (el.remote?.prompt) void el.remote.prompt().catch(() => {});
    else el.webkitShowPlaybackTargetPicker?.();
  };

  // Regarder ensemble : la séance suit ce lecteur.
  useEffect(() => {
    const el = video.current;
    if (!item || !el) return;
    return attachPlayer(
      {
        time: () => el.currentTime,
        paused: () => el.paused,
        ready: () => el.readyState >= 2 && el.currentTime > 0,
        play: () => void el.play().catch(() => {}),
        pause: () => el.pause(),
        seek: (at) => (el.currentTime = at),
        rate: (r) => (el.playbackRate = r),
      },
      item,
    );
  }, [item?.ratingKey, videoKey]);

  const pip = () => {
    const el = v() as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> };
    if (document.pictureInPictureElement) void document.exitPictureInPicture();
    else void el.requestPictureInPicture?.().catch(() => {});
  };

  /** Infos de lecture (« statistiques pour les curieux ») : ce qui est réellement décodé et affiché. */
  const readStats = (): string[] => {
    const el = video.current;
    const pl = plan.current;
    if (!el || !pl) return [];
    const vs = streamsOf(part, 1)[0];
    const as = streamsOf(part, 2).find((s) => s.id === choice.current.audio) ?? streamsOf(part, 2)[0];
    const q = el.getVideoPlaybackQuality?.();
    const ahead = el.buffered.length ? el.buffered.end(el.buffered.length - 1) - el.currentTime : 0;
    const hdrScreen = matchMedia('(dynamic-range: high)').matches;
    const hdr = hdrKind(vs);
    return [
      `Mode : ${pl.reason}`,
      `Source vidéo : ${[media?.videoCodec?.toUpperCase(), vs?.profile, vs?.width && `${vs.width}×${vs.height}`, vs?.bitDepth && `${vs.bitDepth} bits`, hdr || 'SDR', vs?.frameRate && `${Math.round(vs.frameRate * 100) / 100} i/s`].filter(Boolean).join(' · ')}`,
      `Source audio : ${[as?.codec?.toUpperCase(), as?.audioChannelLayout ?? (as?.channels && `${as.channels} canaux`), pl.audio === 'transcode' ? 'converti en AAC' : 'tel quel'].filter(Boolean).join(' · ')}`,
      `Image décodée : ${el.videoWidth}×${el.videoHeight}${pl.mode === 'hls' ? ` (${pl.video === 'copy' ? 'copie' : 'conversion'} serveur)` : ''}`,
      `Écran : ${hdrScreen ? 'HDR' : 'SDR'}${hdr && !hdrScreen ? (pl.video === 'transcode' ? ' — HDR converti par le serveur' : ' — HDR adapté par le navigateur (image sombre ? voir Réglages → Lecture, ou l’application de bureau)') : ''}`,
      q ? `Images perdues : ${q.droppedVideoFrames} / ${q.totalVideoFrames}` : '',
      `Tampon : ${ahead.toFixed(1)} s · vitesse ×${el.playbackRate}`,
      `Aperçus de la barre : ${!thumbs ? 'non proposés' : { unknown: 'survolez la barre', ok: 'vignettes du serveur', missing: 'aucune vignette sur le serveur (Plex : « Générer les aperçus vidéo »)' }[thumbs.state()]}`,
      `Connexion : ${connectionLabel((srv as { uri?: string }).uri)}${hls.current?.bandwidthEstimate ? ` · débit mesuré ${(hls.current.bandwidthEstimate / 1e6).toFixed(0)} Mbps` : ''}`,
    ].filter(Boolean);
  };
  useEffect(() => {
    if (!stats) return;
    const timer = setInterval(() => setStats(readStats()), 1000);
    return () => clearInterval(timer);
  }, [!!stats, item]);

  const change = async (kind: Exclude<Menu, null>, value: number | string) => {
    setMenu(null);
    const c = choice.current;
    const at = video.current?.currentTime ?? 0;
    if (kind === 'speed') {
      c.speed = Number(value);
      v().defaultPlaybackRate = c.speed;
      v().playbackRate = c.speed;
      return;
    }
    if (kind === 'chapter') return void (v().currentTime = Number(value) / 1000);
    if (kind === 'more') return moreAction(String(value));
    if (kind === 'audiomode') return chooseAudioMode(audioModeOf(value));
    if (kind === 'version') {
      // Autre fichier du même titre : ses propres pistes par défaut.
      c.media = Number(value);
      const np = itemRef.current?.Media?.[c.media]?.Part?.[0];
      c.audio = streamsOf(np, 2).find((s) => s.selected)?.id ?? 0;
      c.sub = streamsOf(np, 3).find((s) => s.selected)?.id ?? 0;
      c.force = false;
    } else if (kind === 'quality') c.quality = String(value);
    else {
      if (kind === 'audio') c.audio = Number(value);
      else c.sub = Number(value);
      if (part) await srv.selectStreams(part.id, kind === 'audio' ? { audioStreamID: c.audio } : { subtitleStreamID: c.sub }).catch(() => {});
    }
    void start(at);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const done = () => {
        e.preventDefault();
        e.stopPropagation();
        wake();
      };
      if (e.key === 'Escape' || e.keyCode === 10009 || e.keyCode === 461 || e.key === 'Backspace') {
        done();
        if (menu) setMenu(null);
        else leave();
        return;
      }
      if (menu) return wake();
      const onControl = (e.target as HTMLElement).closest?.('button,input,a');
      const step = settings.value.seekStep;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'MediaPlayPause':
          if (e.key === ' ' && onControl) return wake();
          done();
          return toggle();
        case 'Enter':
          if (onControl) return wake();
          done();
          return toggle();
        case 'MediaPlay':
          done();
          return void v().play().catch(() => {});
        case 'MediaPause':
          done();
          return v().pause();
        case 'MediaStop':
          done();
          return leave();
        case 'MediaFastForward':
        case 'MediaRewind':
          done();
          return void seekBy(e.key === 'MediaRewind' ? -step * 3 : step * 3);
        case 'ArrowLeft':
        case 'ArrowRight':
          if (onControl && visible) return wake();
          done();
          return void seekBy(e.key === 'ArrowLeft' ? -step : step);
        case 'f':
          done();
          return fullscreen();
        case 'm':
          done();
          return void (v().muted = !v().muted);
        case 'i':
          done();
          return setStats((s) => (s ? null : readStats()));
        case 'p':
          done();
          return pip();
        default:
          wake();
      }
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [menu, visible, next, item]);

  const onTime = () => {
    const el = video.current;
    if (!el) return; // évènement tardif après la fermeture du lecteur
    if (el.currentTime > 0) lastTime.current = el.currentTime;
    patch({ time: el.currentTime, duration: el.duration || (itemRef.current?.duration ?? 0) / 1000 });
    const ms = el.currentTime * 1000;
    const s = settings.value;
    for (const m of itemRef.current?.Marker ?? []) {
      const auto = (m.type === 'intro' && s.autoSkipIntro) || (m.type === 'credits' && s.autoSkipCredits);
      if (auto && ms >= m.startTimeOffset && ms < m.endTimeOffset - 1000 && !skipped.current.has(m.startTimeOffset)) {
        skipped.current.add(m.startTimeOffset);
        el.currentTime = m.endTimeOffset / 1000;
      }
    }
  };

  const onError = () => {
    const p = plan.current;
    if (!p || hls.current) return;
    if (modeCors.current) {
      // Chargé en `crossorigin` pour le mode, puis refusé (le média lui-même n'a pas les
      // en-têtes CORS) : même plan, sans `crossorigin` ni mode pour ce titre.
      modeCors.current = false;
      audioBlocked.current = true;
      patchAudio({ shown: false, failed: !failNoticed.current });
      failNoticed.current = true;
      return void reload(video.current?.currentTime || lastTime.current);
    }
    if (p.mode === 'direct' && !choice.current.force) {
      // La lecture directe a échoué (codec annoncé mais illisible) : repli sur le transcodage.
      choice.current.force = true;
      void start(video.current?.currentTime || (itemRef.current?.viewOffset ?? 0) / 1000);
    } else if (!retryOnce()) setError(t('player.error'));
  };

  const onEnded = () => {
    report('stopped');
    if (next && (settings.value.autoNext || next.type === 'queued')) playNext();
    else leave();
  };

  const marker = (item?.Marker ?? []).find((m) => ui.time * 1000 >= m.startTimeOffset && ui.time * 1000 < m.endTimeOffset - 1000 && (m.type === 'intro' || m.type === 'credits'));
  const head = item ? labels(item) : { title: '', sub: '' };
  const chapters = item?.Chapter ?? [];
  // « Plus » : ce qui ne tient pas dans la rangée du bas.
  const moreItems: { id: string; label: string; on: boolean }[] = [
    ui.time > 5 ? { id: 'restart', label: t('player.restart'), on: false } : null,
    chapters.length > 1 ? { id: 'chapter', label: t('player.chapters'), on: false } : null,
    (item?.Media?.length ?? 0) > 1 ? { id: 'version', label: t('player.version'), on: false } : null,
    { id: 'quality', label: `${t('player.quality')} · ${QUALITIES.find((q) => q.id === choice.current.quality)?.label ?? ''}`, on: false },
    { id: 'speed', label: `${t('player.speed')} · ${choice.current.speed === 1 ? t('player.normal') : `×${choice.current.speed}`}`, on: false },
    audioUi.shown ? { id: 'audiomode', label: `${t('player.audioMode')} · ${t(`audio.${audioModeOf(settings.value.audioMode)}`)}`, on: audioModeOf(settings.value.audioMode) !== 'off' } : null,
    { id: 'stats', label: t('player.stats'), on: !!stats },
    remote.ok || castEnabled.value ? { id: 'cast', label: t('cast.title'), on: remote.on } : null,
    document.pictureInPictureEnabled && !tvDevice ? { id: 'pip', label: t('player.pip'), on: false } : null,
  ].filter((x): x is { id: string; label: string; on: boolean } => !!x);
  const menuItems: { id: number | string; label: string; on: boolean }[] =
    menu === 'audio'
      ? audioStreams.map((s) => ({ id: s.id, label: streamLabel(s), on: s.id === choice.current.audio || (!choice.current.audio && s === audioStreams[0]) }))
      : menu === 'sub'
        ? [{ id: 0, label: t('player.none'), on: !choice.current.sub }, ...subStreams.map((s) => ({ id: s.id, label: streamLabel(s), on: s.id === choice.current.sub }))]
        : menu === 'quality'
          ? QUALITIES.map((q) => ({ id: q.id, label: q.label, on: q.id === choice.current.quality }))
          : menu === 'speed'
            ? SPEEDS.map((s) => ({ id: s, label: s === 1 ? t('player.normal') : `×${s}`, on: s === choice.current.speed }))
            : menu === 'chapter'
              ? chapters.map((c, i) => ({ id: c.startTimeOffset, label: `${formatClock(c.startTimeOffset / 1000)} — ${c.tag || `${t('player.chapters')} ${i + 1}`}`, on: ui.time * 1000 >= c.startTimeOffset && ui.time * 1000 < c.endTimeOffset }))
              : menu === 'version'
                ? (item?.Media ?? []).map((m, i) => ({ id: i, label: versionLabel(m), on: i === choice.current.media }))
                : menu === 'audiomode'
                  ? AUDIO_MODES.map((m) => ({ id: m, label: t(`audio.${m}`), on: m === audioModeOf(settings.value.audioMode) }))
                  : menu === 'more'
                    ? moreItems
                    : [];
  function moreAction(id: string) {
    if (id === 'restart') return void (v().currentTime = 0);
    if (id === 'stats') return setStats(stats ? null : readStats());
    if (id === 'cast') return castHere();
    if (id === 'pip') return pip();
    setMenu(id as Menu);
  }
  const openMenu = (kind: Exclude<Menu, null>) => () => setMenu(menu === kind ? null : kind);

  const menuList = menu && (
    <div class="player-menu" role="menu">
      {menuItems.map((m) => (
        <button key={m.id} role="menuitemradio" aria-checked={m.on} class={m.on ? 'on' : ''} onClick={() => void change(menu, m.id)}>
          {m.label}
        </button>
      ))}
    </div>
  );
  return (
    <div ref={root} class={`player${visible || menu || error ? ' show-ui' : ''}${menu ? ' menu-open' : ''}`} data-focus-scope onMouseMove={wake} onTouchStart={wake}>
      <video
        key={videoKey}
        ref={video}
        playsInline
        autoPlay
        x-webkit-airplay="allow"
        onClick={toggle}
        onDblClick={fullscreen}
        onPlay={() => (patch({ playing: true }), report('playing'), wake())}
        onPause={() => (patch({ playing: false }), report('paused'), setVisible(true))}
        onWaiting={() => patch({ buffering: true })}
        onPlaying={() => (patch({ buffering: false }), (retries.current = 0))}
        onCanPlay={() => patch({ buffering: false })}
        onTimeUpdate={onTime}
        onVolumeChange={() => video.current && patch({ muted: video.current.muted })}
        onError={onError}
        onEnded={onEnded}
      >
        {trackUrl && <track kind="subtitles" src={trackUrl} default />}
      </video>

      {ui.buffering && !error && <Spinner />}

      {(audioUi.failed || audioUi.waiting) && (
        <div class="player-notice" role="status">
          <span>{t(audioUi.waiting ? 'audio.waiting' : 'audio.failed')}</span>
          <button class="btn icon-btn" aria-label={t('common.close')} onClick={() => patchAudio({ failed: false, waiting: false })}>
            ✕
          </button>
        </div>
      )}

      {stats && (
        <div class="player-stats" role="status">
          {stats.map((line) => (
            <div key={line.split(' : ')[0]}>{line}</div>
          ))}
        </div>
      )}

      {error && (
        <div class="player-error" role="alert">
          <p>{error}</p>
          <button class="btn primary" onClick={() => void start(ui.time)}>
            {t('common.retry')}
          </button>
          <button class="btn" onClick={leave}>
            {t('common.back')}
          </button>
        </div>
      )}

      {marker && (
        <button class="btn primary skip" onClick={() => (v().currentTime = marker.endTimeOffset / 1000)}>
          {marker.type === 'intro' ? t('player.skipIntro') : t('player.skipCredits')}
        </button>
      )}

      <div class="player-top">
        <button class="btn icon-btn" aria-label={t('common.back')} onClick={leave}>
          <Icon name="back" />
        </button>
        <div class="player-title">
          <strong>{head.title}</strong>
          {head.sub && <PlayerSub text={head.sub} />}
          {item && (
            <PlayerOutput
              badges={liveTechWeb(video.current, plan.current, techBadges(item.Media?.[choice.current.media]))}
              source={techBadges(item.Media?.[choice.current.media])}
            />
          )}
        </div>
        <PlayerClock remaining={ui.duration - ui.time} speed={choice.current.speed} />
      </div>

      <div class="player-bottom">
        <div class="seek">
          <span>{formatClock(ui.time)}</span>
          <SeekPreview duration={ui.duration} thumb={thumbs ? (time) => thumbs.at(time) : undefined}>
            <input
              type="range"
              aria-label="Position"
              min={0}
              max={Math.max(1, Math.floor(ui.duration))}
              step={1}
              value={Math.floor(ui.time)}
              style={{ '--fill': `${ui.duration ? (ui.time / ui.duration) * 100 : 0}%` }}
              onInput={(e) => (v().currentTime = Number(e.currentTarget.value))}
            />
            {/* Intro et générique repérés sur la barre. */}
            {ui.duration > 0 &&
              (item?.Marker ?? [])
                .filter((m) => m.type === 'intro' || m.type === 'credits')
                .map((m) => (
                  <span key={m.type + m.startTimeOffset} class={`seek-mark ${m.type}`} data-label={m.type === 'intro' ? 'Intro' : t('player.credits')} style={{ left: `${(m.startTimeOffset / 1000 / ui.duration) * 100}%`, width: `${(Math.max(0, m.endTimeOffset - m.startTimeOffset) / 1000 / ui.duration) * 100}%` }} />
                ))}
          </SeekPreview>
          <span>−{formatClock(Math.max(0, ui.duration - ui.time))}</span>
        </div>
        <div class="transport">
          <span class="tr-side tr-left">
            {prev && <Pill icon="prev" act="prev" label={t('player.prevEp')} onClick={() => go(`/play/${prev.ratingKey}?t=0`, true)} />}
            <SkipButton seconds={-30} act="back" onClick={() => void seekBy(-30)} />
          </span>
          <button class="btn icon-btn play" data-act="toggle" aria-label={ui.playing ? 'Pause' : t('item.play')} onClick={toggle}>
            <Icon name={ui.playing ? 'pause' : 'play'} size={26} />
          </button>
          <span class="tr-side tr-right">
            <SkipButton seconds={30} act="fwd" onClick={() => void seekBy(30)} />
            {next && <Pill icon="next" act="next" label={next.type === 'queued' ? t('player.upNext') : t('player.next')} title={next.type === 'queued' ? next.title : undefined} onClick={playNext} />}
          </span>
        </div>
        <div class="controls">
          <span class="side side-left">
            {/* Téléviseur : le son se règle à la télécommande. */}
            {!tvDevice && (
              <button class="btn icon-btn" aria-label="Volume" aria-pressed={ui.muted} onClick={() => (v().muted = !v().muted)}>
                <Icon name={ui.muted ? 'mute' : 'volume'} />
              </button>
            )}
          </span>
          {audioStreams.length > 0 && <PillMenu icon="audio" act="audio" label={t('player.audio')} open={menu === 'audio'} menu={menuList} onClick={openMenu('audio')} />}
          {subStreams.length > 0 && <PillMenu icon="subtitles" act="sub" label={t('player.subs')} open={menu === 'sub'} menu={menuList} onClick={openMenu('sub')} />}
          <PillMenu icon="plus" act="more" label={t('player.more')} open={!!menu && menu !== 'audio' && menu !== 'sub'} menu={menuList} onClick={() => setMenu(menu ? null : 'more')} />
          <span class="side">
            {/* Téléviseur : l'application occupe déjà tout l'écran. */}
            {!tvDevice && (
              <button class="btn icon-btn" aria-label={t('player.fullscreen')} title={t('player.fullscreen')} onClick={fullscreen}>
                <Icon name="full" />
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
