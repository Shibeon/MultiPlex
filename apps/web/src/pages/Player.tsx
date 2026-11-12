import { QUALITIES, hdrKind, srtToVtt, streamsOf, type Media, type Metadata, type PlaybackPlan, type Stream } from '@multiplex/core';
import type Hls from 'hls.js';
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatClock, t } from '../i18n';
import { back, go, route } from '../router';
import { settings } from '../settings';
import { invalidate, server } from '../store';
import { Icon, Spinner, labels } from '../ui';

type Menu = null | 'audio' | 'sub' | 'quality' | 'speed' | 'chapter' | 'version';

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
  const [error, setError] = useState('');
  const [menu, setMenu] = useState<Menu>(null);
  const [visible, setVisible] = useState(true);
  const [trackUrl, setTrackUrl] = useState('');
  const [stats, setStats] = useState<string[] | null>(null);
  const [ui, setUi] = useState({ playing: false, time: 0, duration: 0, buffering: true, muted: false, reason: '' });
  const patch = (p: Partial<typeof ui>) => setUi((u) => ({ ...u, ...p }));

  const media = item?.Media?.[choice.current.media] ?? item?.Media?.[0];
  const part = media?.Part?.[0];
  const audioStreams = streamsOf(part, 2);
  const subStreams = streamsOf(part, 3);

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
      .timeline({ ratingKey: it.ratingKey, state, timeMs: v.currentTime * 1000, durationMs: (v.duration || 0) * 1000 || it.duration || 0, session: p.session })
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
      if (HlsLib?.isSupported()) {
        const h = new HlsLib({ startPosition: at, maxBufferLength: 30 });
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
        return setError(t('player.unsupported'));
      } else {
        v.src = p.url;
        if (at > 0) v.addEventListener('loadedmetadata', () => (v.currentTime = at), { once: true });
      }
      v.defaultPlaybackRate = c.speed;
      v.playbackRate = c.speed;
      v.play().catch(() => {});
    } catch (e) {
      if (mine === gen.current) setError((e as Error).message);
    }
  };

  // Chargement de l'élément, puis de l'épisode suivant.
  useEffect(() => {
    let alive = true;
    skipped.current.clear();
    recovered.current = false;
    setNext(null);
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
          if (alive && following) setNext(following);
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
  const fullscreen = () => (document.fullscreenElement ? void document.exitFullscreen() : void root.current?.requestFullscreen?.().catch(() => {}));
  const leave = () => back();
  const playNext = () => next && go(`/play/${next.ratingKey}?t=0`, true);

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
    if (p.mode === 'direct' && !choice.current.force) {
      // La lecture directe a échoué (codec annoncé mais illisible) : repli sur le transcodage.
      choice.current.force = true;
      void start(video.current?.currentTime || (itemRef.current?.viewOffset ?? 0) / 1000);
    } else if (!retryOnce()) setError(t('player.error'));
  };

  const onEnded = () => {
    report('stopped');
    if (next && settings.value.autoNext) playNext();
    else leave();
  };

  const marker = (item?.Marker ?? []).find((m) => ui.time * 1000 >= m.startTimeOffset && ui.time * 1000 < m.endTimeOffset - 1000 && (m.type === 'intro' || m.type === 'credits'));
  const head = item ? labels(item) : { title: '', sub: '' };
  const chapters = item?.Chapter ?? [];
  const menuItems: { id: number | string; label: string; on: boolean }[] =
    menu === 'audio'
      ? audioStreams.map((s) => ({ id: s.id, label: streamLabel(s), on: s.id === choice.current.audio || (!choice.current.audio && s === audioStreams[0]) }))
      : menu === 'sub'
        ? [{ id: 0, label: t('player.none'), on: !choice.current.sub }, ...subStreams.map((s) => ({ id: s.id, label: streamLabel(s), on: s.id === choice.current.sub }))]
        : menu === 'quality'
          ? QUALITIES.map((q) => ({ id: q.id, label: q.label, on: q.id === choice.current.quality }))
          : menu === 'speed'
            ? SPEEDS.map((s) => ({ id: s, label: s === 1 ? 'Normale' : `×${s}`, on: s === choice.current.speed }))
            : menu === 'chapter'
              ? chapters.map((c, i) => ({ id: c.startTimeOffset, label: `${formatClock(c.startTimeOffset / 1000)} — ${c.tag || `${t('player.chapters')} ${i + 1}`}`, on: ui.time * 1000 >= c.startTimeOffset && ui.time * 1000 < c.endTimeOffset }))
              : menu === 'version'
                ? (item?.Media ?? []).map((m, i) => ({ id: i, label: versionLabel(m), on: i === choice.current.media }))
                : [];
  const menuButton = (kind: Exclude<Menu, null>, label: string) => (
    <button class="btn" aria-expanded={menu === kind} onClick={() => setMenu(menu === kind ? null : kind)}>
      {label}
    </button>
  );

  return (
    <div ref={root} class={`player${visible || menu || error ? ' show-ui' : ''}`} data-focus-scope onMouseMove={wake} onTouchStart={wake}>
      <video
        ref={video}
        playsInline
        autoPlay
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
          <span>{head.sub}</span>
        </div>
        {ui.reason && <span class="chip">{ui.reason}</span>}
      </div>

      <div class="player-bottom">
        <div class="seek">
          <span>{formatClock(ui.time)}</span>
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
          <span>{formatClock(ui.duration)}</span>
        </div>
        <div class="controls">
          <button class="btn icon-btn" aria-label={ui.playing ? 'Pause' : t('item.play')} onClick={toggle}>
            <Icon name={ui.playing ? 'pause' : 'play'} size={26} />
          </button>
          <button class="btn icon-btn" aria-label="Volume" onClick={() => (v().muted = !v().muted)}>
            <Icon name={ui.muted ? 'mute' : 'volume'} />
          </button>
          {next && (
            <button class="btn" onClick={playNext}>
              <Icon name="next" size={18} /> {t('player.next')}
            </button>
          )}
          <span class="spacer" />
          {chapters.length > 1 && menuButton('chapter', t('player.chapters'))}
          {(item?.Media?.length ?? 0) > 1 && menuButton('version', t('player.version'))}
          {audioStreams.length > 1 && menuButton('audio', t('player.audio'))}
          {subStreams.length > 0 && menuButton('sub', t('player.subs'))}
          {menuButton('quality', t('player.quality'))}
          {menuButton('speed', ui.playing && choice.current.speed !== 1 ? `×${choice.current.speed}` : t('player.speed'))}
          <button class={`btn icon-btn${stats ? ' on' : ''}`} aria-label={t('player.stats')} aria-pressed={!!stats} title={t('player.stats')} onClick={() => setStats(stats ? null : readStats())}>
            <Icon name="info" />
          </button>
          {document.pictureInPictureEnabled && (
            <button class="btn icon-btn" aria-label={t('player.pip')} title={t('player.pip')} onClick={pip}>
              <Icon name="pip" />
            </button>
          )}
          <button class="btn icon-btn" aria-label={t('player.fullscreen')} onClick={fullscreen}>
            <Icon name="full" />
          </button>
        </div>
        {menu && (
          <div class="player-menu" role="menu">
            {menuItems.map((m) => (
              <button key={m.id} role="menuitemradio" aria-checked={m.on} class={m.on ? 'on' : ''} onClick={() => void change(menu, m.id)}>
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
