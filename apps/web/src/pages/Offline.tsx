import { audioModeOf, streamsOf, type Metadata } from '@multiplex/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { transfers } from '../downloads';
import { formatDuration, t } from '../i18n';
import { native, type OfflineEntry } from '../native';
import { canKeepOffline, keepOffline, offlineApi, offlineEntry, offlineInfo, refreshOffline } from '../offline';
import { say } from '../menu';
import { back, go, route } from '../router';
import { settings, update } from '../settings';
import { retryOnline, server, status } from '../store';
import { Icon, Spinner } from '../ui';

const size = (n?: number) => (n === undefined ? '?' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} Go` : `${Math.round(n / 1e6)} Mo`);
const byEpisode = (a: OfflineEntry, b: OfflineEntry) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0);

/** Avancement d'un titre en cours de téléchargement, d'après le panneau des téléchargements. */
function useTransfer(e: OfflineEntry) {
  const x = transfers.value.find((d) => d.offlineId === e.id);
  return x && x.total ? Math.round((x.received / x.total) * 100) : null;
}

function StateLine({ e }: { e: OfflineEntry }) {
  const pct = useTransfer(e);
  if (e.missing) return <small class="off-state bad">{t('off.missing')}</small>;
  if (e.state === 'failed') return <small class="off-state bad">{t('off.failed')}</small>;
  if (e.state === 'downloading') return <small class="off-state">{pct === null ? t('off.starting') : `${t('off.downloading')} · ${pct} %`}</small>;
  const left = e.viewOffset && e.meta.duration ? Math.round((e.meta.duration - e.viewOffset) / 60000) : 0;
  return <small class="off-state ok">{e.watched ? t('off.watched') : left > 0 ? `${left} min ${t('item.left')}` : formatDuration(e.meta.duration)} · {size(e.size)}</small>;
}

/** Supprimer en deux temps : un premier clic demande confirmation. */
function RemoveButton({ e }: { e: OfflineEntry }) {
  const [ask, setAsk] = useState(false);
  useEffect(() => {
    if (!ask) return;
    const timer = setTimeout(() => setAsk(false), 4000);
    return () => clearTimeout(timer);
  }, [ask]);
  return (
    <button
      class={`btn icon-btn off-remove${ask ? ' ask' : ''}`}
      aria-label={ask ? t('off.confirmRemove') : t('off.remove')}
      title={ask ? t('off.confirmRemove') : t('off.remove')}
      onClick={(ev) => {
        ev.stopPropagation();
        if (!ask) return setAsk(true);
        void offlineApi!.remove(e.id).then(refreshOffline);
      }}
    >
      {ask ? t('off.confirmShort') : <Icon name="close" size={16} />}
    </button>
  );
}

function RetryButton({ e }: { e: OfflineEntry }) {
  const srv = server.value;
  const [busy, setBusy] = useState(false);
  if (!srv || srv.id !== e.serverId) return null;
  return (
    <button
      class="btn"
      disabled={busy}
      onClick={(ev) => {
        ev.stopPropagation();
        setBusy(true);
        void offlineApi!
          .remove(e.id)
          .then(() => keepOffline(srv, { ...e.meta, ratingKey: e.ratingKey, type: e.type }))
          .finally(() => setBusy(false));
      }}
    >
      {t('off.retry')}
    </button>
  );
}

function MovieCard({ e }: { e: OfflineEntry }) {
  const ready = e.state === 'ready' && !e.missing;
  const pct = useTransfer(e);
  const progress = e.state === 'downloading' ? (pct ?? 0) / 100 : e.viewOffset && e.meta.duration ? e.viewOffset / e.meta.duration : 0;
  return (
    <div class={`card off-card${ready ? '' : ' pending'}`}>
      <button class="poster" disabled={!ready} onClick={() => go(`/offline-play/${encodeURIComponent(e.id)}`)} aria-label={`${t('item.play')} ${e.title}`}>
        <span class="poster-fallback">{e.title}</span>
        {e.poster && <img src={e.poster} alt="" />}
        {progress > 0 && (
          <span class={`progress${e.state === 'downloading' ? ' dl' : ''}`}>
            <i style={{ width: `${progress * 100}%` }} />
          </span>
        )}
        {ready && (
          <span class="off-play">
            <Icon name="play" size={34} />
          </span>
        )}
      </button>
      <div class="card-text off-text">
        <div class="card-title">{e.title}</div>
        <StateLine e={e} />
      </div>
      <div class="off-actions">
        {e.state === 'failed' && <RetryButton e={e} />}
        <RemoveButton e={e} />
      </div>
    </div>
  );
}

function ShowBlock({ eps }: { eps: OfflineEntry[] }) {
  const first = eps[0];
  return (
    <section class="off-show">
      <div class="off-show-head">
        {first.poster && <img src={first.poster} alt="" />}
        <div>
          <h3>{first.show?.title ?? first.title}</h3>
          <small class="muted">
            {eps.length} {t('off.episodes')} · {size(eps.reduce((n, e) => n + (e.size || 0), 0))}
          </small>
        </div>
      </div>
      <ul class="off-episodes">
        {eps.map((e) => {
          const ready = e.state === 'ready' && !e.missing;
          return (
            <li key={e.id}>
              <button class="off-episode" disabled={!ready} onClick={() => go(`/offline-play/${encodeURIComponent(e.id)}`)}>
                <span class="off-num">
                  S{e.season} · E{e.episode}
                </span>
                <span class="off-ep-text">
                  <strong>{e.meta.title}</strong>
                  <StateLine e={e} />
                </span>
                {e.watched && <Icon name="check" size={18} />}
              </button>
              <div class="off-actions">
                {e.state === 'failed' && <RetryButton e={e} />}
                <RemoveButton e={e} />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function OfflinePage() {
  const info = offlineInfo.value;
  const [dirNote, setDirNote] = useState('');
  useEffect(() => void refreshOffline(), []);
  if (!offlineApi) return <p class="page muted">{t('off.desktopOnly')}</p>;
  if (!info) return <Spinner />;
  const movies = info.entries.filter((e) => e.type === 'movie').sort((a, b) => b.addedAt - a.addedAt);
  const shows = new Map<string, OfflineEntry[]>();
  for (const e of info.entries.filter((x) => x.type === 'episode')) {
    const k = `${e.serverId}:${e.show?.ratingKey ?? e.show?.title}`;
    shows.set(k, [...(shows.get(k) ?? []), e]);
  }
  const chooseDir = async () => {
    const r = await offlineApi!.chooseDir();
    setDirNote(r.error === 'not-empty' ? t('off.dirNotEmpty') : '');
    if (r.ok) void refreshOffline();
  };
  return (
    <div class="page offline-page">
      <header class="page-head">
        <h1>{t('nav.offline')}</h1>
        <span class="muted count">
          {size(info.used)} {t('off.used')}
          {info.free !== undefined && ` · ${size(info.free)} ${t('off.free')}`}
        </span>
      </header>
      {status.value === 'offline' && (
        <p class="off-banner">
          <Icon name="live" size={18} /> {t('off.noServer')}{' '}
          <button class="btn" onClick={() => void retryOnline()}>
            {t('off.reconnect')}
          </button>
        </p>
      )}
      <p class="muted off-dir">
        {t('off.folder')} <code>{info.dir}</code>{' '}
        <button class="link" onClick={() => void chooseDir()}>
          {t('off.changeDir')}
        </button>
        {dirNote && <span class="error-text"> {dirNote}</span>}
      </p>
      {!info.entries.length && <p class="muted">{t('off.empty')}</p>}
      {movies.length > 0 && (
        <section class="hub">
          <h2>{t('off.movies')}</h2>
          <div class="card-grid">
            {movies.map((e) => (
              <MovieCard key={e.id} e={e} />
            ))}
          </div>
        </section>
      )}
      {shows.size > 0 && (
        <section class="hub">
          <h2>{t('off.shows')}</h2>
          {[...shows.values()].map((eps) => (
            <ShowBlock key={eps[0].id} eps={eps.sort(byEpisode)} />
          ))}
        </section>
      )}
    </div>
  );
}

/** Lecture d'un titre téléchargé : le fichier sur le disque, sans serveur. */
export function OfflinePlayer({ id }: { id: string }) {
  const [error, setError] = useState('');
  const [entry, setEntry] = useState<OfflineEntry | null>(null);
  const live = useRef({ time: 0, duration: 0, paused: false });

  useEffect(() => {
    if (!native || !offlineApi) return;
    let alive = true;
    let e: OfflineEntry | undefined;
    let next: OfflineEntry | undefined;
    let prev: OfflineEntry | undefined;
    const skipped = new Set<number>();
    const save = (watched = false) => {
      if (!e || (!live.current.time && !watched)) return;
      offlineApi!.progress(e.id, watched ? 0 : live.current.time * 1000, watched || e.watched);
    };
    const off = native.on((type, data) => {
      if (!alive || !e) return;
      if (type === 'state') {
        const l = live.current;
        if (data.name === 'time-pos' && typeof data.value === 'number') l.time = data.value;
        else if (data.name === 'duration' && typeof data.value === 'number') l.duration = data.value;
        else if (data.name === 'pause') {
          l.paused = !!data.value;
          save();
        } else return;
        const s = settings.value;
        for (const m of e.meta.Marker ?? []) {
          const auto = (m.type === 'intro' && s.autoSkipIntro) || (m.type === 'credits' && s.autoSkipCredits);
          if (auto && l.time * 1000 >= m.startTimeOffset && l.time * 1000 < m.endTimeOffset - 1000 && !skipped.has(m.startTimeOffset)) {
            skipped.add(m.startTimeOffset);
            void native!.command('seek', m.endTimeOffset / 1000);
          }
        }
      } else if (type === 'next') {
        if (next) go(`/offline-play/${encodeURIComponent(next.id)}?t=0`, true);
      } else if (type === 'prev') {
        if (prev) go(`/offline-play/${encodeURIComponent(prev.id)}?t=0`, true);
      } else if (type === 'audioDevice') {
        update({ audioDevice: String(data.id ?? '') });
      } else if (type === 'ended') {
        const time = typeof data.time === 'number' && data.time > 0 ? data.time : live.current.time;
        live.current.time = time;
        // Vu : arrivé au bout, ou à plus de 90 %.
        const dur = live.current.duration || (e.meta.duration ?? 0) / 1000;
        const watched = !!data.eof || (dur > 0 && time / dur > 0.9);
        save(watched);
        if (watched) e = { ...e, watched: true };
        if (data.eof && next && settings.value.autoNext) go(`/offline-play/${encodeURIComponent(next.id)}?t=0`, true);
        else back();
      } else if (type === 'error') setError(String(data.message ?? t('player.error')));
    });

    void (async () => {
      const info = await refreshOffline();
      e = info?.entries.find((x) => x.id === id);
      if (!alive) return;
      if (!e || e.state !== 'ready' || e.missing) return setError(t('off.unavailable'));
      setEntry(e);
      // Épisodes voisins déjà téléchargés, pour « suivant » et « précédent ».
      if (e.type === 'episode') {
        const eps = info!.entries.filter((x) => x.type === 'episode' && x.state === 'ready' && x.serverId === e!.serverId && x.show?.ratingKey === e!.show?.ratingKey).sort(byEpisode);
        const i = eps.findIndex((x) => x.id === e!.id);
        next = eps[i + 1];
        prev = i > 0 ? eps[i - 1] : undefined;
      }
      // Pistes : celles du fichier, puis les sous-titres téléchargés à côté, dans le même ordre que le lecteur.
      const part = e.meta.Media?.[0]?.Part?.[0];
      const audio = streamsOf(part, 2);
      const embeddedSubs = streamsOf(part, 3).filter((s) => !s.key);
      const externalSubs = streamsOf(part, 3).filter((s) => s.key);
      const label = (s: { extendedDisplayTitle?: string; displayTitle?: string; title?: string; language?: string; id: number }) => s.extendedDisplayTitle ?? s.displayTitle ?? s.title ?? s.language ?? `#${s.id}`;
      const selectedSub = streamsOf(part, 3).find((s) => s.selected);
      const sid = !selectedSub ? 0 : selectedSub.key ? embeddedSubs.length + 1 + e.subs.findIndex((x) => x.index === externalSubs.indexOf(selectedSub)) : embeddedSubs.indexOf(selectedSub) + 1;
      const aid = audio.findIndex((s) => s.selected) + 1;
      const t0 = route.value.query.get('t');
      const start = t0 !== null ? Number(t0) || 0 : e.watched ? 0 : e.viewOffset / 1000;
      const title = e.sub ? `${e.title} — ${e.sub}` : e.title;
      try {
        await offlineApi!.play(e.id, {
          title,
          start,
          aid: aid || undefined,
          sid: streamsOf(part, 3).length || e.subs.length ? Math.max(0, sid) : undefined,
          passthrough: settings.value.passthrough,
          audioDevice: settings.value.audioDevice || undefined,
          audioMode: audioModeOf(settings.value.audioMode),
          matchRefresh: settings.value.matchRefresh,
          seekPreview: settings.value.seekPreview,
        });
      } catch (err) {
        if (alive) setError((err as Error).message || t('off.unavailable'));
        return;
      }
      if (!alive) return;
      native!.setMeta({
        title: e.title,
        sub: e.sub,
        markers: (e.meta.Marker ?? []).filter((m) => m.type === 'intro' || m.type === 'credits').map((m) => ({ type: m.type, start: m.startTimeOffset / 1000, end: m.endTimeOffset / 1000 })),
        audioLabels: audio.map(label),
        subLabels: [...embeddedSubs.map(label), ...e.subs.map((s) => s.label)],
        hasNext: !!next,
        hasPrev: !!prev,
        cast: [],
        xray: false,
        quality: 'original',
        qualities: [],
      });
    })();

    const timer = setInterval(() => !live.current.paused && save(), 10000);
    return () => {
      alive = false;
      off();
      clearInterval(timer);
      save();
      void native!.stop();
      void refreshOffline();
    };
  }, [id]);

  return (
    <div class="player native show-ui" data-focus-scope>
      <div class="native-info">
        {error ? (
          <div class="player-error" role="alert">
            <p>{error}</p>
            <button class="btn" onClick={back}>
              {t('common.back')}
            </button>
          </div>
        ) : (
          <>
            <Spinner />
            <strong>{entry?.title}</strong>
            <span>{entry?.sub}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Sur une fiche : garder le titre hors ligne, voir où il en est, ou y aller. */
export function OfflineButton({ item }: { item: Metadata }) {
  const srv = server.value!;
  const [busy, setBusy] = useState(false);
  const single = item.type === 'movie' || item.type === 'episode';
  const kept = single ? offlineEntry(srv.id, item.ratingKey) : undefined;
  const x = transfers.value.find((d) => kept && d.offlineId === kept.id);
  if (!canKeepOffline(item) || srv.id === 'demo') return null;
  if (kept?.state === 'ready')
    return (
      <a class="btn on" href="#/offline">
        <Icon name="check" size={18} /> {t('off.availableShort')}
      </a>
    );
  if (kept?.state === 'downloading')
    return (
      <a class="btn" href="#/offline">
        <Icon name="download" size={18} /> {x?.total ? `${Math.round((x.received / x.total) * 100)} %` : t('off.starting')}
      </a>
    );
  return (
    <button
      class="btn"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        say(t('off.adding'));
        void keepOffline(srv, item)
          .then((c) => say(c.failed && !c.added ? t('menu.failed') : t('off.added').replace('{n}', String(c.added + c.already)), { label: t('nav.offline'), run: () => go('/offline') }))
          .finally(() => setBusy(false));
      }}
    >
      <Icon name="download" size={18} /> {item.type === 'season' ? t('off.keepSeasonShort') : item.type === 'show' ? t('off.keepShowShort') : t('off.keepShort')}
    </button>
  );
}
