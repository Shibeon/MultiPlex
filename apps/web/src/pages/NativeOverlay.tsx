import { useEffect, useRef, useState } from 'preact/hooks';
import { formatClock, t } from '../i18n';
import { native, type NativeMeta } from '../native';
import { settings } from '../settings';
import { Icon } from '../ui';

type Menu = null | 'audio' | 'sub' | 'speed' | 'chapter' | 'quality' | 'output';

interface Track {
  id: number;
  type: string;
  lang?: string;
  title?: string;
  codec?: string;
  selected?: boolean;
  'demux-channel-count'?: number;
}
interface Chapter {
  title?: string;
  time: number;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const HIDE_AFTER_MS = 3000;

/**
 * Commandes du lecteur natif. Cette page s'affiche dans une fenêtre transparente
 * posée par-dessus la vidéo de mpv : elle ne lit rien elle-même, elle reflète
 * l'état de mpv et lui envoie des ordres.
 */
export function NativeOverlay() {
  const n = native!;
  const [meta, setMeta] = useState<NativeMeta>({});
  const [s, setS] = useState<Record<string, unknown>>({});
  const [menu, setMenu] = useState<Menu>(null);
  const [visible, setVisible] = useState(true);
  /** Position visée pendant qu'on fait glisser la barre de progression. */
  const [scrub, setScrub] = useState<number | null>(null);
  const hideTimer = useRef(0);
  /** Instants des derniers arrêts pour mise en tampon, pour repérer un serveur trop lent. */
  const stalls = useRef<number[]>([]);
  const [slow, setSlow] = useState(false);
  const second = useRef(-1);
  /** Sorties audio de la machine, relues à chaque ouverture du menu (casque branché entre-temps…). */
  const [outputs, setOutputs] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    if (menu !== null && menu !== 'output') return;
    n.audioDevices?.()
      .then(setOutputs)
      .catch(() => {});
  }, [menu === 'output']);

  useEffect(() => {
    n.overlayInit().then(({ meta: m, state }) => {
      setMeta(m ?? {});
      setS((prev) => ({ ...state, ...prev }));
    });
    const offMeta = n.onMeta((m) => setMeta(m ?? {}));
    const off = n.on((type, data) => {
      if (type !== 'state') return;
      const name = String(data.name);
      // mpv signale la position à chaque image : on ne redessine qu'une fois par seconde.
      if (name === 'time-pos') {
        const sec = Math.floor(Number(data.value) || 0);
        if (sec === second.current) return;
        second.current = sec;
      }
      if (name === 'paused-for-cache' && data.value) {
        const now = Date.now();
        stalls.current = [...stalls.current.filter((x) => now - x < 60000), now];
        // Trois arrêts en une minute : la conversion n'arrive pas à suivre la lecture.
        if (stalls.current.length >= 3) setSlow(true);
      }
      setS((prev) => ({ ...prev, [name]: data.value }));
    });
    return () => {
      offMeta();
      off();
    };
  }, []);

  const time = Number(s['time-pos']) || 0;
  const duration = Number(s.duration) || 0;
  const paused = !!s.pause;
  const muted = !!s.mute;
  const volume = Math.round(Number(s.volume ?? 100));
  const speed = Number(s.speed) || 1;
  const buffering = !!s['paused-for-cache'] || !duration;
  const tracks = (Array.isArray(s['track-list']) ? s['track-list'] : []) as Track[];
  const audio = tracks.filter((x) => x.type === 'audio');
  const subs = tracks.filter((x) => x.type === 'sub');
  const chapters = (Array.isArray(s['chapter-list']) ? s['chapter-list'] : []) as Chapter[];

  const wake = () => {
    setVisible(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setVisible(false), HIDE_AFTER_MS);
  };
  useEffect(() => {
    wake();
    return () => clearTimeout(hideTimer.current);
  }, []);
  const shown = visible || paused || !!menu || scrub !== null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const step = settings.value.seekStep;
      const onControl = (e.target as HTMLElement).closest?.('button,input');
      wake();
      switch (e.key) {
        case 'Escape':
        case 'Backspace':
          if (menu) setMenu(null);
          else n.action('back');
          break;
        case ' ':
        case 'Enter':
          if (onControl) return;
          void n.command('toggle');
          break;
        case 'k':
        case 'MediaPlayPause':
          void n.command('toggle');
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
          if (onControl?.tagName === 'INPUT') return;
          void n.command('seekBy', e.key === 'ArrowLeft' ? -step : step);
          break;
        case 'ArrowUp':
        case 'ArrowDown':
          if (menu) return;
          void n.command('volume', volume + (e.key === 'ArrowUp' ? 5 : -5));
          break;
        case 'f':
          n.action('fullscreen');
          break;
        case 'm':
          void n.command('mute');
          break;
        case 'i':
          void n.command('stats');
          break;
        case 'n':
          if (meta.hasNext) n.action('next');
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [menu, volume, meta.hasNext]);

  const marker = (meta.markers ?? []).find((m) => time >= m.start && time < m.end - 1);
  const trackLabel = (list: Track[], labels: string[] | undefined, x: Track, i: number) =>
    // Les libellés du serveur, plus parlants, quand le compte de pistes concorde.
    (labels?.length === list.length ? labels[i] : undefined) ?? ([x.title, x.lang?.toUpperCase(), x.codec?.toUpperCase(), x['demux-channel-count'] && `${x['demux-channel-count']} canaux`].filter(Boolean).join(' · ') || `#${x.id}`);

  const items: { key: string; label: string; on: boolean; run: () => void }[] =
    menu === 'audio'
      ? audio.map((x, i) => ({ key: `a${x.id}`, label: trackLabel(audio, meta.audioLabels, x, i), on: !!x.selected, run: () => void n.command('aid', x.id) }))
      : menu === 'sub'
        ? [
            { key: 's0', label: t('player.none'), on: !subs.some((x) => x.selected), run: () => void n.command('sid', 0) },
            ...subs.map((x, i) => ({ key: `s${x.id}`, label: trackLabel(subs, meta.subLabels, x, i), on: !!x.selected, run: () => void n.command('sid', x.id) })),
          ]
        : menu === 'speed'
          ? SPEEDS.map((v) => ({ key: `v${v}`, label: v === 1 ? 'Normale' : `×${v}`, on: Math.abs(v - speed) < 0.01, run: () => void n.command('speed', v) }))
          : menu === 'output'
            ? [{ id: '', label: t('set.audioAuto') }, ...outputs].map((d) => ({ key: `o${d.id}`, label: d.label, on: (d.id || 'auto') === String(s['audio-device'] ?? 'auto'), run: () => void n.command('audioDevice', d.id) }))
            : menu === 'quality'
            ? (meta.qualities ?? []).map((q) => ({ key: `q${q.id}`, label: q.label, on: q.id === (meta.quality ?? 'original'), run: () => n.action(`quality:${q.id}`) }))
            : menu === 'chapter'
            ? chapters.map((c, i) => ({
                key: `c${i}`,
                label: `${formatClock(c.time)} — ${c.title || `${t('player.chapters')} ${i + 1}`}`,
                on: time >= c.time && time < (chapters[i + 1]?.time ?? Infinity),
                run: () => void n.command('seek', c.time),
              }))
            : [];

  const menuButton = (kind: Exclude<Menu, null>, label: string) => (
    <button class="btn" data-menu={kind} aria-expanded={menu === kind} onClick={() => setMenu(menu === kind ? null : kind)}>
      {label}
    </button>
  );
  const shownTime = scrub ?? time;

  return (
    <div
      class={`player overlay${shown ? ' show-ui' : ''}`}
      onMouseMove={wake}
      onClick={(e) => {
        // Clic sur l'image elle-même : pause ; sur un menu ouvert : on le referme.
        if (e.target !== e.currentTarget) return;
        if (menu) setMenu(null);
        else void n.command('toggle');
      }}
      onDblClick={(e) => e.target === e.currentTarget && n.action('fullscreen')}
    >
      {buffering && <div class="spinner" />}

      {marker && (
        <button class="btn primary skip" onClick={() => void n.command('seek', marker.end)}>
          {marker.type === 'intro' ? t('player.skipIntro') : t('player.skipCredits')}
        </button>
      )}

      {slow && meta.quality && meta.quality !== 'original' && (
        <div class="player-notice" role="status">
          <span>{t('native.slow')}</span>
          <button class="btn" onClick={() => (setSlow(false), (stalls.current = []), setMenu('quality'))}>
            {t('player.quality')}
          </button>
          <button class="btn icon-btn" aria-label="Fermer" onClick={() => (setSlow(false), (stalls.current = []))}>
            ✕
          </button>
        </div>
      )}

      <div class="player-top">
        <button class="btn icon-btn" aria-label={t('common.back')} onClick={() => n.action('back')}>
          <Icon name="back" />
        </button>
        <div class="player-title">
          <strong>{meta.title}</strong>
          <span>{meta.sub}</span>
        </div>
        <span class="chip">{meta.quality && meta.quality !== 'original' ? t('native.chipConverted') : t('native.chip')}</span>
      </div>

      <div class="player-bottom">
        <div class="seek">
          <span>{formatClock(shownTime)}</span>
          <div class="seek-track">
            <input
              type="range"
              aria-label="Position"
              min={0}
              max={Math.max(1, Math.floor(duration))}
              step={1}
              value={Math.floor(shownTime)}
              style={{ '--fill': `${duration ? (shownTime / duration) * 100 : 0}%` }}
              onInput={(e) => setScrub(Number(e.currentTarget.value))}
              onChange={(e) => {
                void n.command('seek', Number(e.currentTarget.value));
                setScrub(null);
              }}
            />
            {/* Intro et générique repérés sur la barre. */}
            {duration > 0 &&
              (meta.markers ?? []).map((m) => (
                <span key={m.type + m.start} class={`seek-mark ${m.type}`} data-label={m.type === 'intro' ? 'Intro' : t('player.credits')} style={{ left: `${(m.start / duration) * 100}%`, width: `${(Math.max(0, m.end - m.start) / duration) * 100}%` }} />
              ))}
          </div>
          <span>-{formatClock(Math.max(0, duration - shownTime))}</span>
        </div>
        <div class="controls">
          <button
            class="btn icon-btn"
            data-act="prev"
            aria-label={t('player.prev')}
            title={t('player.prev')}
            onClick={() => {
              // Comme sur une platine : au-delà de quelques secondes, on revient d'abord au début.
              if (time > 5 || !meta.hasPrev) void n.command('seek', 0);
              else n.action('prev');
            }}
          >
            <Icon name="prev" size={20} />
          </button>
          <button class="btn icon-btn play" data-act="toggle" aria-label={paused ? t('item.play') : 'Pause'} onClick={() => void n.command('toggle')}>
            <Icon name={paused ? 'play' : 'pause'} size={26} />
          </button>
          <button class="btn icon-btn" data-act="mute" aria-label="Volume" aria-pressed={muted} onClick={() => void n.command('mute')}>
            <Icon name={muted || volume === 0 ? 'mute' : 'volume'} />
          </button>
          <input class="volume" type="range" aria-label="Volume" min={0} max={100} step={1} value={muted ? 0 : Math.min(100, volume)} style={{ '--fill': `${muted ? 0 : Math.min(100, volume)}%` }} onInput={(e) => void n.command('volume', Number(e.currentTarget.value))} />
          {meta.hasNext && (
            <button class="btn" data-act="next" onClick={() => n.action('next')}>
              <Icon name="next" size={18} /> {t('player.next')}
            </button>
          )}
          <span class="spacer" />
          {chapters.length > 1 && menuButton('chapter', t('player.chapters'))}
          {audio.length > 1 && menuButton('audio', t('player.audio'))}
          {subs.length > 0 && menuButton('sub', t('player.subs'))}
          {outputs.length > 0 && menuButton('output', t('player.output'))}
          {!!meta.qualities?.length && menuButton('quality', meta.quality && meta.quality !== 'original' ? (meta.qualities.find((q) => q.id === meta.quality)?.label.split(' · ')[0] ?? t('player.quality')) : t('player.quality'))}
          {menuButton('speed', speed !== 1 ? `×${speed}` : t('player.speed'))}
          <button class="btn icon-btn" aria-label={t('player.stats')} title={t('player.stats')} onClick={() => void n.command('stats')}>
            <Icon name="info" />
          </button>
          <button class="btn icon-btn" aria-label={t('player.fullscreen')} onClick={() => n.action('fullscreen')}>
            <Icon name="full" />
          </button>
        </div>
        {menu && (
          <div class="player-menu" role="menu">
            {items.map((m) => (
              <button
                key={m.key}
                role="menuitemradio"
                aria-checked={m.on}
                class={m.on ? 'on' : ''}
                onClick={() => {
                  m.run();
                  setMenu(null);
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
