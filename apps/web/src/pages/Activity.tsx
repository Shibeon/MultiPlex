import { HttpError, type ActiveSession, type FriendActivity } from '@multiplex/core';
import { useEffect, useState } from 'preact/hooks';
import { formatClock, t } from '../i18n';
import { settings } from '../settings';
import { auth, community, server, useData } from '../store';
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

/** « il y a 3 heures », dans la langue de l'interface. */
function ago(date: string): string {
  const minutes = Math.max(0, (Date.now() - new Date(date).getTime()) / 60000);
  const rtf = new Intl.RelativeTimeFormat(settings.value.lang, { numeric: 'auto' });
  if (minutes < 60) return rtf.format(-Math.round(minutes), 'minute');
  if (minutes < 60 * 36) return rtf.format(-Math.round(minutes / 60), 'hour');
  return rtf.format(-Math.round(minutes / 1440), 'day');
}

function FriendCard({ a }: { a: FriendActivity }) {
  const body = (
    <>
      <div class="session-poster">{a.poster && <img loading="lazy" decoding="async" referrerpolicy="no-referrer" src={a.poster} alt="" />}</div>
      <div class="session-text">
        <div class="session-user">
          {a.user.avatar ? <img class="avatar" referrerpolicy="no-referrer" src={a.user.avatar} alt="" /> : <span class="avatar">{a.user.name.slice(0, 1).toUpperCase()}</span>}
          <strong>{a.user.name}</strong>
          <span class="chip">{ago(a.date)}</span>
        </div>
        <div class="session-title">{a.show ?? a.title}</div>
        <div class="muted">{a.show ? [a.episode, a.title].filter(Boolean).join(' — ') : a.year}</div>
      </div>
    </>
  );
  // La fiche du catalogue dit si le titre est disponible sur MultiPlex et permet de l'ajouter à sa liste.
  return a.discoverId ? (
    <a class="session" href={`#/discover/${a.discoverId}`}>
      {body}
    </a>
  ) : (
    <div class="session">{body}</div>
  );
}

/** Lectures en cours sur la bibliothèque : seul son propriétaire y a accès, les autres ne voient pas la section. */
function LiveNow() {
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

  if (error instanceof HttpError && [401, 403].includes(error.status)) return null;
  return (
    <section class="hub">
      <h2>
        {t('live.now')} {list && <span class="muted">{list.length}</span>}
      </h2>
      {error && !list ? (
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
    </section>
  );
}

/** Ce que les amis Plex ont regardé, et le choix de partager ou non ce qu'on regarde soi-même. */
function Friends() {
  const c = community.value!;
  const { data, error, reload } = useData('community:feed', () => c.feed());
  const [shares, setShares] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    c.sharesWatching().then(
      (v) => alive && setShares(v),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [c]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      await c.setSharesWatching(on);
      setShares(on);
    } catch {
      /* le réglage reste tel qu'il était */
    }
    setBusy(false);
  };

  return (
    <section class="hub">
      <h2>{t('live.friends')}</h2>
      <p class="muted">{t('live.friendsLead')}</p>
      {shares !== null && (
        <label class="set-row share-row">
          <span>
            {t('live.share')}
            <small class="muted"> — {t('live.shareHelp')}</small>
          </span>
          <input type="checkbox" checked={shares} disabled={busy} onChange={(e) => void toggle(e.currentTarget.checked)} />
        </label>
      )}
      {error && !data ? (
        <ErrorBox error={error} retry={reload} />
      ) : !data ? (
        <Spinner />
      ) : data.length === 0 ? (
        <p class="muted">{t('live.friendsNone')}</p>
      ) : (
        <div class="sessions">
          {data.map((a) => (
            <FriendCard key={a.id} a={a} />
          ))}
        </div>
      )}
    </section>
  );
}

export function ActivityPage() {
  return (
    <div class="page">
      <header class="page-head">
        <h1>{t('live.title')}</h1>
      </header>
      <LiveNow />
      {community.value && <Friends />}
    </div>
  );
}
