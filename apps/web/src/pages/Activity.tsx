import { HttpError, type ActiveSession } from '@multiplex/core';
import { useEffect, useState } from 'preact/hooks';
import { formatClock, t } from '../i18n';
import { auth, server } from '../store';
import { ErrorBox, Icon, Spinner, labels } from '../ui';

const REFRESH_MS = 10000;

function SessionCard({ s }: { s: ActiveSession }) {
  const srv = server.value!;
  const { title, sub } = labels(s.item);
  const thumb = s.item.type === 'episode' ? (s.item.grandparentThumb ?? s.item.thumb) : s.item.thumb;
  const pos = (s.item.viewOffset ?? 0) / 1000;
  const dur = (s.item.duration ?? 0) / 1000;
  const me = auth.value && [auth.value.user.username, auth.value.user.title].includes(s.user);
  return (
    <a class="session" href={`#/item/${s.item.ratingKey}`}>
      <div class="session-poster">{thumb && <img loading="lazy" decoding="async" src={srv.image(thumb, 240, 360)} alt="" />}</div>
      <div class="session-text">
        <div class="session-user">
          {s.userThumb ? <img class="avatar" src={srv.image(s.userThumb, 64, 64)} alt="" /> : <span class="avatar">{s.user.slice(0, 1).toUpperCase()}</span>}
          <strong>{s.user}</strong>
          {me && <span class="muted">({t('live.you')})</span>}
          <span class={`chip state-${s.state}`}>
            <Icon name={s.state === 'paused' ? 'pause' : 'play'} size={12} /> {t(s.state === 'paused' ? 'live.paused' : s.state === 'buffering' ? 'live.buffering' : 'live.playing')}
          </span>
        </div>
        <div class="session-title">{title}</div>
        <div class="muted">{sub}</div>
        {dur > 0 && (
          <div class="session-progress">
            <span class="progress">
              <i style={{ width: `${Math.min(100, (pos / dur) * 100)}%` }} />
            </span>
            <small class="muted">
              {formatClock(pos)} / {formatClock(dur)}
            </small>
          </div>
        )}
        <small class="muted">
          {[s.player, s.platform !== s.player && s.platform, t(s.transcoding ? 'live.transcode' : 'live.direct')].filter(Boolean).join(' · ')}
        </small>
      </div>
    </a>
  );
}

/** Lectures en cours sur le serveur, rafraîchies tant que la page est visible. */
export function ActivityPage() {
  const srv = server.value!;
  const [list, setList] = useState<ActiveSession[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.hidden) return;
      srv.sessions().then(
        (l) => alive && (setList(l), setError(null)),
        (e: Error) => alive && setError(e),
      );
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [srv, tick]);

  const forbidden = error instanceof HttpError && [401, 403].includes(error.status);
  return (
    <div class="page">
      <header class="page-head">
        <h1>{t('live.title')}</h1>
        {list && <span class="muted">{list.length}</span>}
      </header>
      {forbidden ? (
        <p class="muted">{t('live.forbidden')}</p>
      ) : error && !list ? (
        <ErrorBox error={error} retry={() => setTick((n) => n + 1)} />
      ) : !list ? (
        <Spinner />
      ) : list.length === 0 ? (
        <p class="muted">{t('live.none')}</p>
      ) : (
        <div class="sessions">
          {list.map((s) => (
            <SessionCard key={s.id} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}
