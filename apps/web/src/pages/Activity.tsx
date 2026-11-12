import { HttpError, type ActiveSession, type FriendActivity } from '@multiplex/core';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { formatClock, t } from '../i18n';
import { settings } from '../settings';
import { auth, community, server, useData } from '../store';
import { ErrorBox, Icon, Spinner, labels } from '../ui';

const REFRESH_MS = 10000;

function Avatar({ name, src }: { name: string; src?: string }) {
  return src ? <img class="avatar" referrerpolicy="no-referrer" loading="lazy" src={src} alt="" /> : <span class="avatar">{name.slice(0, 1).toUpperCase()}</span>;
}

/** Une lecture en cours sur la bibliothèque. */
function LiveCard({ s }: { s: ActiveSession }) {
  const srv = server.value!;
  const { title, sub } = labels(s.item);
  const thumb = s.item.type === 'episode' ? (s.item.grandparentThumb ?? s.item.thumb) : s.item.thumb;
  const pos = (s.item.viewOffset ?? 0) / 1000;
  const dur = (s.item.duration ?? 0) / 1000;
  const me = auth.value && [auth.value.user.username, auth.value.user.title].includes(s.user);
  return (
    <a class="live-card" href={`#/item/${s.item.ratingKey}`}>
      <div class="live-poster">{thumb && <img loading="lazy" decoding="async" src={srv.image(thumb, 240, 360)} alt="" />}</div>
      <div class="live-text">
        <div class="live-user">
          <Avatar name={s.user} src={s.userThumb ? srv.image(s.userThumb, 64, 64) : undefined} />
          <strong>{s.user}</strong>
          {me && <span class="muted">({t('live.you')})</span>}
        </div>
        <div class="live-title">{title}</div>
        {sub && <div class="muted">{sub}</div>}
        {dur > 0 && (
          <span class="progress">
            <i style={{ width: `${Math.min(100, (pos / dur) * 100)}%` }} />
          </span>
        )}
        <small class="muted">
          <span class={`live-state state-${s.state}`}>{t(s.state === 'paused' ? 'live.paused' : s.state === 'buffering' ? 'live.buffering' : 'live.playing')}</span>
          {dur > 0 && ` · ${formatClock(pos)} / ${formatClock(dur)}`}
          {` · ${[s.player, t(s.transcoding ? 'live.transcode' : 'live.direct')].filter(Boolean).join(' · ')}`}
        </small>
      </div>
    </a>
  );
}

/** Lectures en cours sur la bibliothèque : seul son propriétaire y a accès, les autres ne voient pas la section. */
function LiveNow() {
  const srv = server.value!;
  const [list, setList] = useState<ActiveSession[] | null>(null);
  const [error, setError] = useState<Error | null>(null);

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
  }, [srv]);

  // Pas d'accès (compte invité), erreur passagère ou personne devant l'écran : la section s'efface.
  if (error instanceof HttpError || !list?.length) return null;
  return (
    <section class="live-now">
      <h2>
        <i class="live-dot" /> {t('live.now')}
      </h2>
      <div class="live-row">
        {list.map((s) => (
          <LiveCard key={s.id} s={s} />
        ))}
      </div>
    </section>
  );
}

/** « il y a 3 heures », dans la langue de l'interface. */
function ago(date: string): string {
  const minutes = Math.max(0, (Date.now() - new Date(date).getTime()) / 60000);
  const rtf = new Intl.RelativeTimeFormat(settings.value.lang, { numeric: 'auto' });
  if (minutes < 60) return rtf.format(-Math.round(minutes), 'minute');
  if (minutes < 60 * 24) return rtf.format(-Math.round(minutes / 60), 'hour');
  return new Date(date).toLocaleTimeString(settings.value.lang, { hour: '2-digit', minute: '2-digit' });
}

const dayKey = (date: string) => new Date(date).toDateString();

/** « Aujourd'hui », « Hier », puis la date en toutes lettres. */
function dayLabel(date: string): string {
  const d = new Date(date);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (days <= 1) {
    const word = new Intl.RelativeTimeFormat(settings.value.lang, { numeric: 'auto' }).format(-Math.max(0, days), 'day');
    return word.charAt(0).toUpperCase() + word.slice(1);
  }
  const text = d.toLocaleDateString(settings.value.lang, { weekday: 'long', day: 'numeric', month: 'long' });
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Une publication du fil : un ami, un film ou une série, et les épisodes vus d'affilée. */
interface Post {
  id: string;
  first: FriendActivity;
  episodes: FriendActivity[];
}

/** Regroupe les épisodes d'une même série vus à la suite par la même personne, le même jour. */
export function toPosts(feed: FriendActivity[]): Post[] {
  const posts: Post[] = [];
  for (const a of feed) {
    const last = posts[posts.length - 1];
    if (last && a.show && last.first.show === a.show && last.first.user.id === a.user.id && dayKey(last.first.date) === dayKey(a.date)) last.episodes.push(a);
    else posts.push({ id: a.id, first: a, episodes: a.show ? [a] : [] });
  }
  return posts;
}

function PostCard({ p }: { p: Post }) {
  const a = p.first;
  const n = p.episodes.length;
  const u = auth.value?.user;
  const me = !!u && (a.user.username === u.username || [u.uuid, String(u.id)].includes(a.user.id));
  const verb = n > 1 ? t('feed.episodes').replace('{n}', String(n)) : n === 1 ? t('feed.episode') : t('feed.movie');
  const media = (
    <>
      {a.art && <i class="post-art" style={{ backgroundImage: `url("${a.art}")` }} />}
      <div class="post-poster">
        <span>{(a.show ?? a.title).slice(0, 1)}</span>
        {a.poster && <img loading="lazy" decoding="async" referrerpolicy="no-referrer" src={a.poster} alt="" />}
      </div>
      <div class="post-info">
        <div class="post-title">{a.show ?? a.title}</div>
        {n === 0 && a.year && <div class="muted">{a.year}</div>}
        {n > 0 && (
          <ul class="post-episodes">
            {/* Dans l'ordre où ils ont été vus : le fil, lui, va du plus récent au plus ancien. */}
            {[...p.episodes].reverse().map((e) => (
              <li key={e.id}>
                {e.episode && <b>{e.episode}</b>}
                <span>{e.title}</span>
              </li>
            ))}
          </ul>
        )}
        {a.discoverId && (
          <span class="post-open">
            {t('feed.open')} <Icon name="next" size={12} />
          </span>
        )}
      </div>
    </>
  );
  return (
    <article class="post">
      <Avatar name={a.user.name} src={a.user.avatar} />
      <div class="post-body">
        <header>
          <strong>{me ? t('feed.me') : a.user.name}</strong> <span>{verb}</span>
          <time dateTime={a.date}>{ago(a.date)}</time>
        </header>
        {a.discoverId ? (
          <a class="post-media" href={`#/discover/${a.discoverId}`}>
            {media}
          </a>
        ) : (
          <div class="post-media">{media}</div>
        )}
      </div>
    </article>
  );
}

/** Le fil : ce que les amis Plex ont regardé, et le choix de partager ou non ce qu'on regarde soi-même. */
function Feed() {
  const c = community.value!;
  const { data, error, reload } = useData('community:feed', () => c.feed(80));
  const [who, setWho] = useState('');
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

  // Les amis présents dans le fil, du plus actif au moins actif.
  const friends = useMemo(() => {
    const seen = new Map<string, { user: FriendActivity['user']; count: number }>();
    for (const a of data ?? []) {
      const f = seen.get(a.user.id) ?? { user: a.user, count: 0 };
      f.count++;
      seen.set(a.user.id, f);
    }
    return [...seen.values()].sort((x, y) => y.count - x.count);
  }, [data]);
  const days = useMemo(() => {
    const out: { key: string; label: string; posts: Post[] }[] = [];
    for (const p of toPosts((data ?? []).filter((a) => !who || a.user.id === who))) {
      const key = dayKey(p.first.date);
      if (out[out.length - 1]?.key !== key) out.push({ key, label: dayLabel(p.first.date), posts: [] });
      out[out.length - 1].posts.push(p);
    }
    return out;
  }, [data, who]);

  return (
    <section class="feed">
      {friends.length > 1 && (
        <div class="feed-friends" role="tablist" aria-label={t('live.friends')}>
          <button role="tab" aria-selected={!who} class={`feed-friend${!who ? ' on' : ''}`} onClick={() => setWho('')}>
            <span class="avatar all">
              <Icon name="live" size={18} />
            </span>
            <small>{t('feed.all')}</small>
          </button>
          {friends.map((f) => (
            <button key={f.user.id} role="tab" aria-selected={who === f.user.id} class={`feed-friend${who === f.user.id ? ' on' : ''}`} onClick={() => setWho(who === f.user.id ? '' : f.user.id)}>
              <Avatar name={f.user.name} src={f.user.avatar} />
              <small>{f.user.name}</small>
            </button>
          ))}
        </div>
      )}

      {error && !data ? (
        <ErrorBox error={error} retry={reload} />
      ) : !data ? (
        <Spinner />
      ) : data.length === 0 ? (
        <p class="muted">{t('live.friendsNone')}</p>
      ) : (
        days.map((d) => (
          <div key={d.key} class="feed-day">
            <h3>{d.label}</h3>
            {d.posts.map((p) => (
              <PostCard key={p.id} p={p} />
            ))}
          </div>
        ))
      )}

      {shares !== null && (
        <label class="feed-share">
          <input type="checkbox" checked={shares} disabled={busy} onChange={(e) => void toggle(e.currentTarget.checked)} />
          <span>
            <strong>{t('live.share')}</strong>
            <small class="muted">{t(shares ? 'feed.shareOn' : 'feed.shareOff')}</small>
          </span>
        </label>
      )}
    </section>
  );
}

export function ActivityPage() {
  return (
    <div class="page activity">
      <header class="page-head">
        <h1>{t('live.title')}</h1>
        <span class="muted">{t('live.friendsLead')}</span>
      </header>
      <LiveNow />
      {community.value ? <Feed /> : <p class="muted">{t('disc.needAccount')}</p>}
    </div>
  );
}
