import { castPick } from '../cast';
import { effect } from '@preact/signals';
import { attachPlayer, peers, together } from '../together';
import { noticeText } from '../togetherui';
import { QUALITIES, randomId, streamsOf, techBadges, type Metadata, type Stream } from '@multiplex/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { native, type NativeMeta } from '../native';
import { resumeAfter } from './Person';
import { back, go, route } from '../router';
import { withCommunityMarkers } from '../markers';
import { update } from '../settings';
import { settings } from '../settings';
import { invalidate, server } from '../store';
import { dequeue, upNext } from '../queue';
import { Spinner, labels } from '../ui';

const streamLabel = (s: Stream) => s.extendedDisplayTitle ?? s.displayTitle ?? s.title ?? s.language ?? `#${s.id}`;

/**
 * Lecture par le lecteur natif de l'application de bureau.
 *
 * En qualité « Original », mpv reçoit l'adresse du fichier : aucun codec, aucune
 * piste audio ni aucun sous-titre ne passe par la conversion du serveur. En
 * qualité limitée (connexion lente, lecture à distance), mpv lit le flux que le
 * serveur convertit au débit demandé.
 *
 * La vidéo de mpv recouvre cette page : les commandes sont dessinées par une
 * fenêtre transparente posée par-dessus (voir NativeOverlay). Cette page garde
 * la logique : pistes au démarrage, progression remontée au serveur, saut
 * automatique d'intro, enchaînement des épisodes, changement de qualité.
 */
const castOf = (it: Metadata) => (it.Role ?? []).slice(0, 40).map((r) => ({ key: r.tagKey, name: r.tag, role: r.role, thumb: r.thumb }));
const markersOf = (it: Metadata) => (it.Marker ?? []).filter((m) => m.type === 'intro' || m.type === 'credits').map((m) => ({ type: m.type, start: m.startTimeOffset / 1000, end: m.endTimeOffset / 1000 }));

export function NativePlayer({ id }: { id: string }) {
  const srv = server.value!;
  const [item, setItem] = useState<Metadata | null>(null);
  const [error, setError] = useState('');
  const live = useRef({ time: 0, duration: 0, paused: false });
  const itemRef = useRef<Metadata | null>(null);
  const nextRef = useRef<Metadata | null>(null);
  const prevRef = useRef<Metadata | null>(null);
  /** Distribution de la série, pour un épisode qui n'en a pas en propre. */
  const castRef = useRef<NonNullable<NativeMeta['cast']>>([]);
  const session = useRef(randomId());
  const skipped = useRef(new Set<number>());
  /** Session de conversion en cours côté serveur, à arrêter quand on la quitte. */
  const transcode = useRef('');
  const quality = useRef(settings.value.quality);

  // Regarder ensemble : la séance suit ce lecteur (position, pause, sauts, petite vitesse).
  useEffect(() => {
    if (!item) return;
    return attachPlayer(
      {
        time: () => live.current.time,
        paused: () => live.current.paused,
        ready: () => live.current.duration > 0 && live.current.time > 0,
        play: () => void native!.command('pause', false),
        pause: () => void native!.command('pause', true),
        seek: (at) => void native!.command('seek', at),
        rate: (r) => void native!.command('speed', r),
      },
      item,
    );
  }, [item?.ratingKey]);
  // Participants et dernières actions, affichés par-dessus la vidéo.
  useEffect(
    () =>
      effect(() => {
        const s = together.value;
        native!.setMeta({ together: s ? { names: peers.value.map((p) => p.name), notice: s.notice ? noticeText(s.notice) : undefined, at: s.notice?.at } : undefined });
      }),
    [],
  );

  const report = (kind: 'playing' | 'paused' | 'stopped', time = live.current.time) => {
    const it = itemRef.current;
    if (!it || !time) return;
    srv
      .timeline({ ratingKey: it.ratingKey, state: kind, timeMs: time * 1000, durationMs: live.current.duration * 1000 || it.duration || 0, session: session.current })
      .catch(() => {});
  };

  const stopTranscode = () => {
    if (transcode.current) srv.stopTranscode(transcode.current).catch(() => {});
    transcode.current = '';
  };

  /** (Re)lance mpv à la position donnée, dans la qualité courante. */
  const launch = async (at: number) => {
    const it = itemRef.current;
    const part = it?.Media?.[0]?.Part?.[0];
    if (!it || !part) throw new Error(t('player.error'));
    // mpv numérote les pistes par type, dans l'ordre du fichier ; les sous-titres
    // externes (fichiers annexes) s'ajoutent après ceux du fichier.
    const rank = (type: number) => {
      const all = streamsOf(part, type);
      const embedded = all.filter((s) => !s.key);
      const external = all.filter((s) => s.key);
      const selected = all.find((s) => s.selected);
      const index = !selected ? 0 : selected.key ? embedded.length + external.indexOf(selected) + 1 : embedded.indexOf(selected) + 1;
      return { index, selected, external, ordered: [...embedded, ...external], hasAny: all.length > 0 };
    };
    const audio = rank(2);
    const subs = rank(3);
    const { title, sub } = labels(it);
    const file = srv.fileRequest(part.key);
    const original = quality.current === 'original';
    stopTranscode();

    if (original) {
      await native!.play({
        url: file.url,
        headers: file.headers,
        title: sub ? `${title} — ${sub}` : title,
        start: at,
        aid: audio.index || undefined,
        sid: subs.hasAny ? subs.index : undefined,
        subFiles: subs.external.map((s) => srv.fileRequest(s.key!).url),
        passthrough: settings.value.passthrough,
        audioDevice: settings.value.audioDevice || undefined,
        matchRefresh: settings.value.matchRefresh,
        seekPreview: settings.value.seekPreview,
      });
    } else {
      // Qualité limitée : le serveur convertit, avec la piste audio et les sous-titres choisis.
      const plan = await srv.playback(it, {
        quality: quality.current,
        forceTranscode: true,
        canPlay: () => false,
        audioStreamId: audio.selected?.id,
        subtitleStreamId: subs.selected?.id,
      });
      transcode.current = plan.mode === 'hls' ? plan.session : '';
      // Le jeton quitte l'adresse pour un en-tête, comme pour le fichier d'origine.
      const url = new URL(plan.url);
      url.searchParams.delete('X-Plex-Token');
      await native!.play({ url: url.toString(), headers: file.headers, title: sub ? `${title} — ${sub}` : title, start: at, buffered: true, audioDevice: settings.value.audioDevice || undefined, matchRefresh: settings.value.matchRefresh });
    }

    // La fenêtre de contrôles ne connaît pas le serveur : on lui décrit le titre.
    native!.setMeta({
      title,
      sub,
      markers: markersOf(itemRef.current ?? it),
      audioLabels: original ? audio.ordered.map(streamLabel) : [],
      subLabels: original ? subs.ordered.map(streamLabel) : [],
      hasNext: !!nextRef.current,
      hasPrev: !!prevRef.current,
      cast: castRef.current.length ? castRef.current : castOf(it),
      xray: settings.value.xray,
      quality: quality.current,
      qualities: QUALITIES.map((q) => ({ id: q.id, label: q.label })),
      tech: techBadges(it.Media?.[0]),
      playMode: original ? 'direct' : 'transcode',
    });
  };

  useEffect(() => {
    if (!native) return;
    let alive = true;
    const playNext = () => nextRef.current && go(`/play/${nextRef.current.ratingKey}?t=0`, true);
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
      } else if (type === 'next') {
        playNext();
      } else if (type === 'prev') {
        if (prevRef.current) go(`/play/${prevRef.current.ratingKey}?t=0`, true);
      } else if (type === 'audioDevice') {
        // Sortie audio changée depuis les contrôles : on la garde pour la suite.
        update({ audioDevice: String(data.id ?? '') });
      } else if (type === 'quality') {
        // Changement de qualité depuis les contrôles : on reprend au même endroit.
        const wanted = String(data.id ?? '');
        if (!QUALITIES.some((q) => q.id === wanted) || wanted === quality.current) return;
        quality.current = wanted;
        launch(live.current.time).catch((e: Error) => alive && setError(e.message));
      } else if (type === 'ended') {
        const time = typeof data.time === 'number' && data.time > 0 ? data.time : live.current.time;
        report('stopped', time);
        stopTranscode();
        invalidate(`${srv.id}:`);
        if (data.cast && itemRef.current) {
          // Lecture envoyée vers un téléviseur : retour à la fiche, choix de l'appareil, même position.
          castPick.value = { item: itemRef.current, start: time };
          go(`/item/${itemRef.current.ratingKey}`, true);
        } else if (data.eof && nextRef.current && (settings.value.autoNext || nextRef.current.type === 'queued')) playNext();
        // Fiche d'une personne demandée depuis la distribution affichée à la pause.
        else if (typeof data.goto === 'string' && /^\/person\/[0-9a-f]+$/i.test(data.goto)) {
          const it = itemRef.current;
          if (it) resumeAfter.value = { key: it.ratingKey, title: labels(it).title };
          go(data.goto, true);
        }
        else back();
      } else if (type === 'error') setError(String(data.message ?? t('player.error')));
    });

    srv
      .metadata(id)
      .then(async (it) => {
        if (!alive) return;
        itemRef.current = it;
        setItem(it);
        // Sans repères de Plex (compte sans Plex Pass), ceux de la communauté arrivent en cours de route.
        void withCommunityMarkers(srv, it).then((full) => {
          if (!alive || full === it || itemRef.current !== it) return;
          itemRef.current = full;
          setItem(full);
          native!.setMeta({ markers: markersOf(full) });
        });
        castRef.current = [];
        if (it.type === 'episode' && !it.Role?.length && it.grandparentRatingKey) {
          // Un épisode n'a souvent pas de distribution à lui : on prend celle de la série.
          void srv.metadata(it.grandparentRatingKey).then(
            (show) => {
              if (!alive || itemRef.current?.ratingKey !== it.ratingKey) return;
              castRef.current = castOf(show);
              native!.setMeta({ cast: castRef.current });
            },
            () => {},
          );
        }
        dequeue(it.ratingKey);
        const queued = upNext.peek()[0];
        if (queued) {
          nextRef.current = { ratingKey: queued.ratingKey, title: queued.title, type: 'queued' };
          native!.setMeta({ hasNext: true, nextTitle: queued.title });
        }
        const t0 = route.value.query.get('t');
        await launch(t0 !== null ? Number(t0) || 0 : (it.viewOffset ?? 0) / 1000);
        if (!alive) return;
        if (it.type === 'episode' && it.parentRatingKey) {
          const eps = await srv.children(it.parentRatingKey).catch(() => []);
          const i = eps.findIndex((e) => e.ratingKey === it.ratingKey);
          let following = i >= 0 ? eps[i + 1] : undefined;
          if (!following && i >= 0 && it.grandparentRatingKey) {
            const seasons = await srv.children(it.grandparentRatingKey).catch(() => []);
            const after = seasons.filter((s) => (s.index ?? 0) > (it.parentIndex ?? 0)).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0];
            if (after) following = (await srv.children(after.ratingKey).catch(() => []))[0];
          }
          if (alive && following && !nextRef.current) {
            nextRef.current = following;
            native!.setMeta({ hasNext: true });
          }
          // Épisode précédent, y compris le dernier de la saison d'avant.
          let previous = i > 0 ? eps[i - 1] : undefined;
          if (!previous && i === 0 && it.grandparentRatingKey) {
            const all = await srv.children(it.grandparentRatingKey).catch(() => []);
            const before = all.filter((s) => (s.index ?? 0) > 0 && (s.index ?? 0) < (it.parentIndex ?? 0)).sort((a, b) => (b.index ?? 0) - (a.index ?? 0))[0];
            if (before) previous = (await srv.children(before.ratingKey).catch(() => [])).pop();
          }
          if (alive && previous) {
            prevRef.current = previous;
            native!.setMeta({ hasPrev: true });
          }
        }
      })
      .catch((e: Error) => alive && setError(e.message));

    const timer = setInterval(() => !live.current.paused && report('playing'), 10000);
    // Si le clavier revient à cette fenêtre (clic sur sa barre de titre), les touches essentielles restent actives.
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const step = settings.value.seekStep;
      if (e.key === ' ' || e.key === 'k') void native!.command('toggle');
      else if (e.key === 'ArrowLeft') void native!.command('seekBy', -step);
      else if (e.key === 'ArrowRight') void native!.command('seekBy', step);
      else if (e.key === 'Escape' || e.key === 'Backspace') native!.action('back');
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener('keydown', onKey, true);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
      removeEventListener('keydown', onKey, true);
      report('stopped');
      stopTranscode();
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
            <Spinner />
            <strong>{head.title}</strong>
            <span>{head.sub}</span>
          </>
        )}
      </div>
    </div>
  );
}
