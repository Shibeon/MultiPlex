import { useEffect, useRef, useState } from 'preact/hooks';
import { formatClock, t } from '../i18n';
import { native, type NativeMeta } from '../native';
import { moveFocus } from '../nav';
import { couchOn, settings } from '../settings';
import { cancelXray, runXray, xrayAvailable } from '../xray';
import { Icon, SeekPreview } from '../ui';
import { PillMenu, PlayerClock, PlayerSub, PlayerTech, Pill, SkipButton, liveTechNative } from '../playerui';

type Menu = null | 'audio' | 'sub' | 'speed' | 'chapter' | 'quality' | 'output' | 'more';

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
/** En mode TV, les contrôles restent un peu plus longtemps : on les lit de loin. */
const HIDE_AFTER_COUCH_MS = 5000;


/**
 * Commandes du lecteur natif. Cette page s'affiche dans une fenêtre transparente
 * posée par-dessus la vidéo de mpv : elle ne lit rien elle-même, elle reflète
 * l'état de mpv et lui envoie des ordres.
 */
/** L'envoi vers un téléviseur existe dans cette version de l'application. */
const castAvailable = !!native?.cast;

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
    hideTimer.current = window.setTimeout(() => setVisible(false), couchOn.value ? HIDE_AFTER_COUCH_MS : HIDE_AFTER_MS);
  };
  useEffect(() => {
    wake();
    return () => clearTimeout(hideTimer.current);
  }, []);
  const shown = visible || paused || !!menu || scrub !== null;
  const couch = couchOn.value;

  // Mode TV : quand les contrôles disparaissent, le focus les quitte aussi, pour que les flèches
  // reviennent à l'avance / au retour rapide.
  useEffect(() => {
    if (!shown && couch) (document.activeElement as HTMLElement | null)?.blur?.();
  }, [shown, couch]);
  // Un menu ouvert à la télécommande : le focus va sur le choix en cours.
  useEffect(() => {
    if (menu && couch) document.querySelector<HTMLElement>('.player-menu button.on, .player-menu button')?.focus();
  }, [menu, couch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const step = settings.value.seekStep;
      const onControl = (e.target as HTMLElement).closest?.('button,input');
      wake();
      // Mode TV, piloté comme une télécommande : flèches pour aller d'un bouton à l'autre quand
      // les contrôles ont le focus ; sinon gauche / droite avancent ou reculent, et haut, bas ou OK
      // font apparaître les contrôles, le focus sur Lecture.
      if (couchOn.value && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
        const DIR: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (onControl) {
          if (e.key === 'Enter') return;
          // Sur la barre de progression, gauche / droite la déplacent.
          if (onControl.tagName === 'INPUT' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
          e.preventDefault();
          const [dx, dy] = DIR[e.key];
          moveFocus(dx, dy);
          return;
        }
        e.preventDefault();
        // OK pendant l'intro ou le générique : on les passe, comme le propose le bouton à l'écran.
        const skip = document.querySelector<HTMLElement>('.skip');
        if (e.key === 'Enter' && skip) return void skip.click();
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') void n.command('seekBy', e.key === 'ArrowLeft' ? -step : step);
        else document.querySelector<HTMLElement>('[data-act="toggle"]')?.focus();
        return;
      }
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
      runXray('who', cast).then(
        (r) => alive && setXray(r ? { at: pausedAt, state: 'done', ...r } : { at: pausedAt, state: 'failed', faces: 0, onScreen: [] }),
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
      cancelXray();
    };
  }, [pausedAt, meta.xray, meta.cast]);
  // Préparation en tâche de fond, quelques secondes après le début de la lecture.
  useEffect(() => {
    if (!meta.xray || !xrayAvailable || !meta.cast?.length) return;
    let alive = true;
    const cast = meta.cast;
    const timer = setTimeout(() => alive && void runXray('warm', cast).catch(() => {}), 6000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [meta.xray, meta.cast]);
  // Les personnes reconnues d'abord, puis le reste de la distribution.
  const seen = new Set(xray?.onScreen ?? []);
  // Reconnaissance active : elle travaille sans rien afficher, puis seules les personnes
  // reconnues à l'écran apparaissent. Sans elle : la distribution, comme avant.
  const xrayOn = !!meta.xray && xrayAvailable;
  const castShown = xrayOn ? [...seen] : (meta.cast ?? []).map((_, i) => i).slice(0, 14);
  const showCast = xrayOn ? xray?.state === 'done' && seen.size > 0 : true;
  const xrayNote = t('xray.note');

  const marker = (meta.markers ?? []).find((m) => time >= m.start && time < m.end - 1);
  const trackLabel = (list: Track[], labels: string[] | undefined, x: Track, i: number) =>
    // Les libellés du serveur, plus parlants, quand le compte de pistes concorde.
    (labels?.length === list.length ? labels[i] : undefined) ?? ([x.title, x.lang?.toUpperCase(), x.codec?.toUpperCase(), x['demux-channel-count'] && `${x['demux-channel-count']} canaux`].filter(Boolean).join(' · ') || `#${x.id}`);

  // « Plus » : ce qui ne tient pas dans la rangée du bas. Un choix qui ouvre une liste la remplace.
  const qualityLabel = meta.quality && meta.quality !== 'original' ? meta.qualities?.find((q) => q.id === meta.quality)?.label.split(' · ')[0] : undefined;
  const moreItems: { key: string; label: string; on: boolean; run: () => void }[] = [
    time > 5 ? { key: 'restart', label: t('player.restart'), on: false, run: () => void n.command('seek', 0) } : null,
    chapters.length > 1 ? { key: 'chapter', label: t('player.chapters'), on: false, run: () => setMenu('chapter') } : null,
    outputs.length > 0 ? { key: 'output', label: t('player.output'), on: false, run: () => setMenu('output') } : null,
    meta.qualities?.length ? { key: 'quality', label: `${t('player.quality')}${qualityLabel ? ` · ${qualityLabel}` : ''}`, on: false, run: () => setMenu('quality') } : null,
    { key: 'speed', label: `${t('player.speed')} · ${speed !== 1 ? `×${speed}` : 'Normale'}`, on: false, run: () => setMenu('speed') },
    { key: 'stats', label: t('player.stats'), on: false, run: () => void n.command('stats') },
    castAvailable ? { key: 'cast', label: t('cast.title'), on: false, run: () => n.action('cast') } : null,
  ].filter((x): x is { key: string; label: string; on: boolean; run: () => void } => !!x);

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
            : menu === 'more'
            ? moreItems
            : menu === 'chapter'
            ? chapters.map((c, i) => ({
                key: `c${i}`,
                label: `${formatClock(c.time)} — ${c.title || `${t('player.chapters')} ${i + 1}`}`,
                on: time >= c.time && time < (chapters[i + 1]?.time ?? Infinity),
                run: () => void n.command('seek', c.time),
              }))
            : [];

  const openMenu = (kind: Exclude<Menu, null>) => () => setMenu(menu === kind ? null : kind);
  const menuList = (
    <div class="player-menu" role="menu">
      {items.map((m) => (
        <button
          key={m.key}
          role="menuitemradio"
          aria-checked={m.on}
          class={m.on ? 'on' : ''}
          onClick={() => {
            setMenu(null);
            m.run();
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
  const shownTime = scrub ?? time;

  return (
    <div
      class={`player overlay${shown ? ' show-ui' : ''}${menu ? ' menu-open' : ''}${couch ? ' couch-player' : ''}`}
      data-couch={couch ? 'on' : 'off'}
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
          {meta.sub && <PlayerSub text={meta.sub} />}
          <PlayerTech badges={liveTechNative(s, meta)} />
        </div>
        <PlayerClock remaining={duration - time} speed={speed} />
      </div>

      {/* À la pause : qui joue dans ce film. Un clic quitte la lecture (position gardée) pour la fiche de la personne. */}
      {paused && !menu && !!meta.cast?.length && showCast && (
        <div class={`pause-cast${xrayOn ? ' found' : ''}`}>
          <h3 data-xray={xray?.state ?? 'off'}>
            {xrayOn ? t('xray.onScreen') : t('item.cast')} {!xrayOn && <small>{xrayNote}</small>}
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

      {/* Regarder ensemble : qui est là, et ce que les autres viennent de faire. */}
      {meta.together && (
        <div class="player-together">
          <span class="pill">
            <Icon name="together" size={16} /> {meta.together.names.length ? meta.together.names.join(', ') : t('tog.alone')}
          </span>
          {meta.together.notice && meta.together.at && Date.now() - meta.together.at < 4000 && (
            <span class="pill notice" key={meta.together.at}>
              {meta.together.notice}
            </span>
          )}
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
          <span>−{formatClock(Math.max(0, duration - shownTime))}</span>
        </div>
        <div class="transport">
          <span class="tr-side tr-left">
            {meta.hasPrev && <Pill icon="prev" act="prev" label={t('player.prevEp')} onClick={() => n.action('prev')} />}
            <SkipButton seconds={-30} act="back" onClick={() => void n.command('seekBy', -30)} />
          </span>
          <button class="btn icon-btn play" data-act="toggle" aria-label={paused ? t('item.play') : 'Pause'} onClick={() => void n.command('toggle')}>
            <Icon name={paused ? 'play' : 'pause'} size={26} />
          </button>
          <span class="tr-side tr-right">
            <SkipButton seconds={30} act="fwd" onClick={() => void n.command('seekBy', 30)} />
            {meta.hasNext && <Pill icon="next" act="next" label={meta.nextTitle ? t('player.upNext') : t('player.next')} title={meta.nextTitle} onClick={() => n.action('next')} />}
          </span>
        </div>
        <div class="controls">
          {audio.length > 0 && <PillMenu icon="audio" act="audio" label={t('player.audio')} open={menu === 'audio'} menu={menuList} onClick={openMenu('audio')} />}
          {subs.length > 0 && <PillMenu icon="subtitles" act="sub" label={t('player.subs')} open={menu === 'sub'} menu={menuList} onClick={openMenu('sub')} />}
          <PillMenu icon="plus" act="more" label={t('player.more')} open={!!menu && menu !== 'audio' && menu !== 'sub'} menu={menuList} onClick={() => setMenu(menu ? null : 'more')} />
          <span class="side">
            <button class="btn icon-btn" data-act="mute" aria-label="Volume" aria-pressed={muted} onClick={() => void n.command('mute')}>
              <Icon name={muted || volume === 0 ? 'mute' : 'volume'} />
            </button>
            <input class="volume" type="range" aria-label="Volume" min={0} max={100} step={1} value={muted ? 0 : Math.min(100, volume)} style={{ '--fill': `${muted ? 0 : Math.min(100, volume)}%` }} onInput={(e) => void n.command('volume', Number(e.currentTarget.value))} />
            <button class="btn icon-btn" aria-label={t('player.fullscreen')} onClick={() => n.action('fullscreen')}>
              <Icon name="full" />
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
