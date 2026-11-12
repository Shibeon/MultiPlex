import { randomId, streamsOf, type Metadata } from '@multiplex/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatClock, t } from '../i18n';
import { native } from '../native';
import { back, go, route } from '../router';
import { settings } from '../settings';
import { invalidate, server } from '../store';
import { Spinner, labels } from '../ui';

/** Touches de la page relayées à mpv tant que sa surface n'a pas le focus clavier. */
const KEYS: Record<string, string> = {
  ' ': 'SPACE',
  Enter: 'SPACE',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  Escape: 'ESC',
  Backspace: 'ESC',
  MediaPlayPause: 'SPACE',
};

/**
 * Lecture par le lecteur natif de l'application de bureau. mpv reçoit l'adresse
 * du fichier d'origine : aucun codec, aucune piste audio ni aucun sous-titre ne
 * passe par la conversion du serveur. mpv affiche ses propres commandes ; cette
 * page suit sa progression pour la remonter au serveur et enchaîner les épisodes.
 */
export function NativePlayer({ id }: { id: string }) {
  const srv = server.value!;
  const [item, setItem] = useState<Metadata | null>(null);
  const [error, setError] = useState('');
  const [state, setState] = useState({ time: 0, duration: 0, paused: false });
  const live = useRef({ time: 0, duration: 0, paused: false });
  const itemRef = useRef<Metadata | null>(null);
  const nextRef = useRef<Metadata | null>(null);
  const session = useRef(randomId());
  const skipped = useRef(new Set<number>());

  const report = (kind: 'playing' | 'paused' | 'stopped', time = live.current.time) => {
    const it = itemRef.current;
    if (!it || !time) return;
    srv
      .timeline({ ratingKey: it.ratingKey, state: kind, timeMs: time * 1000, durationMs: live.current.duration * 1000 || it.duration || 0, session: session.current })
      .catch(() => {});
  };

  useEffect(() => {
    if (!native) return;
    let alive = true;
    const off = native.on((type, data) => {
      if (!alive) return;
      if (type === 'state') {
        const l = live.current;
        if (data.name === 'time-pos' && typeof data.value === 'number') l.time = data.value;
        else if (data.name === 'duration' && typeof data.value === 'number') l.duration = data.value;
        else if (data.name === 'pause') {
          l.paused = !!data.value;
          report(l.paused ? 'paused' : 'playing');
        } else return;
        // Saut automatique de l'intro et du générique, d'après les marqueurs du serveur.
        const s = settings.value;
        for (const m of itemRef.current?.Marker ?? []) {
          const auto = (m.type === 'intro' && s.autoSkipIntro) || (m.type === 'credits' && s.autoSkipCredits);
          if (auto && l.time * 1000 >= m.startTimeOffset && l.time * 1000 < m.endTimeOffset - 1000 && !skipped.current.has(m.startTimeOffset)) {
            skipped.current.add(m.startTimeOffset);
            void native!.command('seek', m.endTimeOffset / 1000);
          }
        }
        setState((prev) => (Math.floor(prev.time) === Math.floor(l.time) && prev.paused === l.paused && prev.duration === l.duration ? prev : { ...l }));
      } else if (type === 'ended') {
        const time = typeof data.time === 'number' && data.time > 0 ? data.time : live.current.time;
        report('stopped', time);
        invalidate(`${srv.id}:`);
        if (data.eof && nextRef.current && settings.value.autoNext) go(`/play/${nextRef.current.ratingKey}?t=0`, true);
        else back();
      } else if (type === 'error') setError(String(data.message ?? t('player.error')));
    });

    srv
      .metadata(id)
      .then(async (it) => {
        if (!alive) return;
        itemRef.current = it;
        setItem(it);
        const part = it.Media?.[0]?.Part?.[0];
        if (!part) throw new Error(t('player.error'));
        // mpv numérote les pistes par type, dans l'ordre du fichier ; les sous-titres
        // externes (fichiers annexes) s'ajoutent après ceux du fichier.
        const rank = (type: number) => {
          const all = streamsOf(part, type);
          const embedded = all.filter((s) => !s.key);
          const external = all.filter((s) => s.key);
          const selected = all.find((s) => s.selected);
          const index = !selected ? 0 : selected.key ? embedded.length + external.indexOf(selected) + 1 : embedded.indexOf(selected) + 1;
          return { index, external, hasAny: all.length > 0 };
        };
        const audio = rank(2);
        const subs = rank(3);
        const t0 = route.value.query.get('t');
        const { title, sub } = labels(it);
        const file = srv.fileRequest(part.key);
        await native!.play({
          url: file.url,
          headers: file.headers,
          title: sub ? `${title} — ${sub}` : title,
          start: t0 !== null ? Number(t0) || 0 : (it.viewOffset ?? 0) / 1000,
          aid: audio.index || undefined,
          sid: subs.hasAny ? subs.index : undefined,
          subFiles: subs.external.map((s) => srv.fileRequest(s.key!).url),
          passthrough: settings.value.passthrough,
        });
        if (it.type === 'episode' && it.parentRatingKey) {
          const eps = await srv.children(it.parentRatingKey).catch(() => []);
          const i = eps.findIndex((e) => e.ratingKey === it.ratingKey);
          let following = i >= 0 ? eps[i + 1] : undefined;
          if (!following && i >= 0 && it.grandparentRatingKey) {
            const seasons = await srv.children(it.grandparentRatingKey).catch(() => []);
            const after = seasons.filter((s) => (s.index ?? 0) > (it.parentIndex ?? 0)).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0];
            if (after) following = (await srv.children(after.ratingKey).catch(() => []))[0];
          }
          if (alive) nextRef.current = following ?? null;
        }
      })
      .catch((e: Error) => alive && setError(e.message));

    const timer = setInterval(() => !live.current.paused && report('playing'), 10000);
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = KEYS[e.key] ?? (/^[a-z0-9]$/i.test(e.key) ? e.key : '');
      if (!key) return;
      e.preventDefault();
      e.stopPropagation();
      void native!.command('key', key);
    };
    addEventListener('keydown', onKey, true);

    // La surface vidéo de mpv, incrustée dans la fenêtre, ne reçoit pas la souris : c'est
    // cette page, cachée dessous, qui la reçoit. On la relaie pour que la barre de contrôle
    // de mpv apparaisse, se clique et se fasse glisser normalement.
    const BUTTONS = ['MBTN_LEFT', 'MBTN_MID', 'MBTN_RIGHT'];
    let pending: { x: number; y: number } | null = null;
    let idle = 0;
    const flush = () => {
      if (pending) void native!.command('mouse', pending);
      pending = null;
    };
    const onMove = (e: MouseEvent) => {
      const first = !pending;
      pending = { x: e.clientX * devicePixelRatio, y: e.clientY * devicePixelRatio };
      if (first) requestAnimationFrame(flush);
      // Le pointeur se masque avec la barre quand la souris ne bouge plus.
      document.body.style.cursor = '';
      clearTimeout(idle);
      idle = window.setTimeout(() => (document.body.style.cursor = 'none'), 2500);
    };
    const onButton = (action: 'down' | 'up') => (e: MouseEvent) => {
      const name = BUTTONS[e.button];
      if (!name) return;
      e.preventDefault();
      pending = { x: e.clientX * devicePixelRatio, y: e.clientY * devicePixelRatio };
      flush();
      void native!.command('button', { name, action });
    };
    const onDown = onButton('down');
    const onUp = onButton('up');
    const onDouble = () => void native!.command('button', { name: 'MBTN_LEFT_DBL', action: 'press' });
    const onWheel = (e: WheelEvent) => void native!.command('button', { name: e.deltaY < 0 ? 'WHEEL_UP' : 'WHEEL_DOWN', action: 'press' });
    const onMenu = (e: Event) => e.preventDefault();
    addEventListener('mousemove', onMove);
    addEventListener('mousedown', onDown);
    addEventListener('mouseup', onUp);
    addEventListener('dblclick', onDouble);
    addEventListener('wheel', onWheel, { passive: true });
    addEventListener('contextmenu', onMenu);
    return () => {
      removeEventListener('mousemove', onMove);
      removeEventListener('mousedown', onDown);
      removeEventListener('mouseup', onUp);
      removeEventListener('dblclick', onDouble);
      removeEventListener('wheel', onWheel);
      removeEventListener('contextmenu', onMenu);
      clearTimeout(idle);
      document.body.style.cursor = '';
      alive = false;
      off();
      clearInterval(timer);
      removeEventListener('keydown', onKey, true);
      report('stopped');
      void native!.stop();
      invalidate(`${srv.id}:`);
    };
  }, [id]);

  const head = item ? labels(item) : { title: '', sub: '' };
  return (
    <div class="player native show-ui" data-focus-scope>
      <div class="native-info">
        {error ? (
          <div class="player-error" role="alert">
            <p>{error}</p>
            <button class="btn primary" onClick={() => go(`/play/${id}?web=1`, true)}>
              {t('native.fallback')}
            </button>
            <button class="btn" onClick={back}>
              {t('common.back')}
            </button>
          </div>
        ) : (
          <>
            {!state.time && <Spinner />}
            <strong>{head.title}</strong>
            <span>{head.sub}</span>
            <span class="native-state">
              {state.paused ? t('live.paused') : t('live.playing')} · {formatClock(state.time)} / {formatClock(state.duration || (item?.duration ?? 0) / 1000)}
            </span>
            <small>{t('native.hint')}</small>
          </>
        )}
      </div>
    </div>
  );
}
