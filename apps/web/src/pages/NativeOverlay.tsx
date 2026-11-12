import { useEffect, useRef, useState } from 'preact/hooks';
import { formatClock, t } from '../i18n';
import { native, type NativeMeta } from '../native';
import { settings } from '../settings';
import { warmUp, whoIsOnScreen, xrayAvailable } from '../xray';
import { Icon, SeekPreview } from '../ui';

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

  // Ce que mpv envoie réellement à la sortie audio : son brut (l'ampli décode) ou son décodé.
  const out = (s['audio-out-params'] ?? null) as { format?: string; 'hr-channels'?: string; 'channel-count'?: number } | null;
  const RAW: Record<string, string> = { 'spdif-ac3': 'Dolby Digital', 'spdif-eac3': 'Dolby Digital Plus', 'spdif-truehd': 'Dolby TrueHD', 'spdif-dts': 'DTS', 'spdif-dtshd': 'DTS-HD' };
  const outLabel = !out?.format ? '' : out.format.startsWith('spdif') ? `${t('native.audioRaw')} · ${RAW[out.format] ?? out.format.slice(6).toUpperCase()}` : `${t('native.audioDecoded')} · ${{ stereo: '2.0', mono: '1.0' }[out['hr-channels'] ?? ''] ?? out['hr-channels'] ?? `${out['channel-count'] ?? '?'} ch`}`;

  // À la pause : qui est à l'écran ? L'analyse attend que la pause soit installée, et s'efface à la reprise.
  const [xray, setXray] = useState<{ at: number; state: 'working' | 'done' | 'failed'; faces: number; onScreen: number[] } | null>(null);
  const pausedAt = paused ? Math.round(time) : -1;
  useEffect(() => {
    setXray(null);
    if (pausedAt < 0 || !meta.xray || !xrayAvailable || !meta.cast?.length) return;
    let alive = true;
    const cast = meta.cast;
    const timer = setTimeout(() => {
      setXray({ at: pausedAt, state: 'working', faces: 0, onScreen: [] });
      whoIsOnScreen(cast, () => alive).then(
        (r) => alive && r && setXray({ at: pausedAt, state: 'done', ...r }),
        (e: unknown) => {
          // Trace pour le diagnostic : l'interface, elle, retombe sur la distribution complète.
          console.warn('[xray]', e);
          (window as unknown as { xrayError?: string }).xrayError = String((e as Error)?.stack ?? e);
          if (alive) setXray({ at: pausedAt, state: 'failed', faces: 0, onScreen: [] });
        },
      );
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pausedAt, meta.xray, meta.cast]);
  // Préparation en tâche de fond, quelques secondes après le début de la lecture.
  useEffect(() => {
    if (!meta.xray || !xrayAvailable || !meta.cast?.length) return;
    let alive = true;
    const cast = meta.cast;
    const timer = setTimeout(() => void warmUp(cast, () => alive).catch(() => {}), 6000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [meta.xray, meta.cast]);
  // Les personnes reconnues d'abord, puis le reste de la distribution.
  const seen = new Set(xray?.onScreen ?? []);
  const castShown = [...(xray?.onScreen ?? []), ...(meta.cast ?? []).map((_, i) => i).filter((i) => !seen.has(i))].slice(0, Math.max(14, seen.size));
  const xrayNote = !meta.xray || !xrayAvailable ? t('xray.note') : !xray || xray.state === 'working' ? t('xray.working') : xray.state === 'failed' ? t('xray.failed') : seen.size ? t('xray.found').replace('{n}', String(seen.size)) : xray.faces ? t('xray.unknown') : t('xray.nobody');

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
        <span class="chips">
          {outLabel && (
            <span class={`chip${out?.format?.startsWith('spdif') ? ' raw' : ''}`} data-audio-out={out?.format}>
              {outLabel}
            </span>
          )}
          <span class="chip">{meta.quality && meta.quality !== 'original' ? t('native.chipConverted') : t('native.chip')}</span>
        </span>
      </div>

      {/* À la pause : qui joue dans ce film. Un clic quitte la lecture (position gardée) pour la fiche de la personne. */}
      {paused && !menu && !!meta.cast?.length && (
        <div class="pause-cast">
          <h3 data-xray={xray?.state ?? 'off'}>
            {seen.size ? t('xray.onScreen') : t('item.cast')} <small>{xrayNote}</small>
          </h3>
          <div class="pause-cast-row">
            {castShown.map((i) => [meta.cast![i], i] as const).map(([c, i]) => (
              <button key={`${c.name}${i}`} class={`pause-cast-card${seen.has(i) ? ' on-screen' : ''}`} disabled={!c.key} onClick={() => c.key && n.action(`person:${c.key}`)}>
                <span class="cast-face">{c.thumb ? <img referrerpolicy="no-referrer" src={c.thumb} alt="" /> : <b>{c.name.slice(0, 1)}</b>}</span>
                <strong>{c.name}</strong>
                {c.role && <small>{c.role}</small>}
              </button>
            ))}
          </div>
        </div>
      )}

      <div class="player-bottom">
        <div class="seek">
          <span>{formatClock(shownTime)}</span>
          <SeekPreview duration={duration} thumb={n.thumb ? (time) => n.thumb!(time) : undefined}>
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
          </SeekPreview>
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
