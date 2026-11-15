// « Regarder ensemble » : bouton, fenêtre de séance (créer, inviter, rejoindre, séances des amis),
// pastille des participants, indicateur du lecteur, et garde « une seule lecture ».
import { isRoomsAnswer, roomsUrl, type Metadata } from '@multiplex/core';
import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Carousel } from './carousel';
import { formatClock, t } from './i18n';
import { say } from './menu';
import { back, go, route } from './router';
import { settings, update } from './settings';
import { auth, server } from './store';
import {
  friendItem,
  friendSessions,
  friendTime,
  itemId,
  joinFriend,
  joinTogether,
  leaveTogether,
  parseCode,
  peers,
  playConflict,
  playingGuid,
  refreshFriendSessions,
  relayUrl,
  sessionTime,
  setVisible,
  shareTitle,
  startTogether,
  together,
  type FriendSession,
  type SharedItem,
  type TogetherState,
} from './together';
import { Icon, Spinner } from './ui';

/** Fenêtre ouverte, avec le titre depuis lequel on l'a ouverte (s'il y en a un). */
export const togetherOpen = signal<{ item?: Metadata } | null>(null);

export const noticeText = (n: NonNullable<TogetherState['notice']>) => t(n.action === 'pause' ? 'tog.paused' : n.action === 'play' ? 'tog.played' : 'tog.seeked').replace('{name}', n.name);

const errorText = (e: Error) =>
  t(e.message === 'code' ? 'tog.badCode' : e.message === 'relay' ? 'tog.noRelay' : e.message === 'notfound' ? 'tog.notFound' : e.message === 'nohost' ? 'tog.noHost' : 'tog.failed');

const inPlayer = () => {
  const k = route.value.parts[0];
  return k === 'play' || k === 'offline-play';
};

/** Lance chez soi un titre de la séance, à la position de la séance. */
export async function joinPlayback(item: SharedItem | undefined = together.value?.item, at = sessionTime()): Promise<void> {
  const srv = server.value;
  if (!item || !srv) return;
  const local =
    (item.guid ? await srv.findByGuid(item.guid).catch(() => undefined) : undefined) ??
    (item.server === srv.id && item.key ? await srv.metadata(item.key).catch(() => undefined) : undefined);
  if (!local) {
    say(t('tog.missing').replace('{title}', item.title));
    return;
  }
  go(`/play/${local.ratingKey}?t=${Math.max(0, Math.floor(at))}`);
}

/** Entre dans la séance d'un ami et lance la lecture là où elle en est. */
export async function joinFriendAndPlay(s: FriendSession): Promise<void> {
  await joinFriend(s);
  togetherOpen.value = null;
  await joinPlayback(together.value?.item ?? friendItem(s), sessionTime() || friendTime(s));
}

export function TogetherButton({ item }: { item: Metadata }) {
  const s = together.value;
  if (s?.host) {
    return (
      <button
        class="btn"
        onClick={() => {
          // « Lire ensemble » : ce titre devient celui de la séance, pour tout le monde.
          shareTitle(item);
          go(`/play/${item.ratingKey}?t=${Math.floor((item.viewOffset ?? 0) / 1000)}`);
        }}
        title={t('tog.title')}
      >
        <Icon name="together" size={18} /> {t('tog.playTogether')}
      </button>
    );
  }
  return (
    <button class="btn" onClick={() => (togetherOpen.value = { item })} title={t('tog.title')}>
      <Icon name="together" size={18} /> {t('tog.button')}
    </button>
  );
}

export const Avatar = ({ name, thumb }: { name: string; thumb?: string }) => (
  <span class="tog-avatar" title={name}>
    {thumb ? <img src={thumb} alt="" referrerpolicy="no-referrer" /> : <b>{name.slice(0, 1).toUpperCase()}</b>}
  </span>
);

/** Interrupteur « Visible par mes amis », avec ce qu'il implique. */
function VisibleSwitch({ on, onChange, note }: { on: boolean; onChange: (on: boolean) => void; note?: ComponentChildren }) {
  return (
    <div class="tog-visible">
      <label class="set-row">
        <span>{t('tog.visible')}</span>
        <input class="switch" type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.currentTarget.checked)} />
      </label>
      <small class="muted">{on ? t('tog.visibleHint') : t('tog.private')}</small>
      {note}
    </div>
  );
}

/** Séances visibles des amis : une carte par séance, « Rejoindre » sans code. */
export function FriendSessions({ list, busy, onJoin }: { list: FriendSession[]; busy?: string; onJoin: (s: FriendSession) => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Carousel class="tog-friends" aria-label={t('tog.friends')}>
      {list.map((s) => (
        <button key={s.room} class="tog-friend" disabled={!!busy} onClick={() => onJoin(s)}>
          <span class="tog-friend-head">
            <Avatar name={s.card.name} />
            <small>{t('tog.watching').replace('{name}', s.card.name)}</small>
          </span>
          <strong>{s.card.title}</strong>
          {s.card.sub && <span class="muted">{s.card.sub}</span>}
          <span class="tog-friend-meta">
            <Icon name={s.card.playing ? 'play' : 'pause'} size={14} /> {formatClock(friendTime(s))} · {t('tog.inSessionN').replace('{n}', String(s.count))}
          </span>
          <span class="tog-friend-join">{busy === s.room ? t('tog.joining') : t('tog.join')}</span>
        </button>
      ))}
    </Carousel>
  );
}

/** Rejoindre une séance d'ami, avec l'état (en cours, erreur) pour l'affichage. */
function useJoinFriend(onError: (msg: string) => void) {
  const [busy, setBusy] = useState('');
  const join = (s: FriendSession) => {
    setBusy(s.room);
    joinFriendAndPlay(s).then(
      () => setBusy(''),
      (e: Error) => {
        setBusy('');
        onError(errorText(e));
      },
    );
  };
  return { busy, join };
}

export function TogetherDialog() {
  const open = togetherOpen.value;
  const s = together.value;
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [visible, setVisibleChoice] = useState(settings.value.togetherVisible);
  const friend = useJoinFriend(setError);
  useEffect(() => {
    setError('');
    setBusy(false);
    setVisibleChoice(settings.value.togetherVisible);
    if (open && !together.peek()) void refreshFriendSessions().catch(() => {});
  }, [open]);
  if (!open) return null;
  const close = () => (togetherOpen.value = null);
  const relay = relayUrl();
  const run = (job: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    job().then(
      () => setBusy(false),
      (e: Error) => {
        setBusy(false);
        setError(errorText(e));
      },
    );
  };
  const copy = (text = s!.code) =>
    void navigator.clipboard?.writeText(text).then(
      () => say(t('tog.copied')),
      () => setError(t('tog.copyFailed')),
    );
  const list = friendSessions.value;

  return (
    <div class="whatsnew-veil" role="dialog" aria-modal="true" aria-label={t('tog.title')} onClick={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div class="whatsnew tog-dialog">
        <h2>
          <Icon name="together" /> {t('tog.title')}
        </h2>
        {!s ? (
          <>
            <p class="muted">{t('tog.lead')}</p>
            {list.length > 0 && (
              <section class="tog-friends-section">
                <h3>{t('tog.friends')}</h3>
                <FriendSessions list={list} busy={friend.busy} onJoin={friend.join} />
              </section>
            )}
            {relay ? (
              <>
                <VisibleSwitch on={visible} onChange={setVisibleChoice} />
                <button class="btn primary" disabled={busy} onClick={() => run(() => startTogether(open.item, { visible }))}>
                  {open.item ? t('tog.createWith').replace('{title}', open.item.title) : t('tog.create')}
                </button>
              </>
            ) : (
              <p class="tog-warn">
                {t('tog.noRelay')}{' '}
                <button
                  class="link"
                  onClick={() => {
                    close();
                    go('/settings');
                  }}
                >
                  {t('nav.settings')}
                </button>
              </p>
            )}
            <form
              class="tog-join"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => joinTogether(code));
              }}
            >
              <input type="text" placeholder={t('tog.codePlaceholder')} aria-label={t('tog.join')} value={code} onInput={(e) => setCode(e.currentTarget.value)} />
              <button class="btn" disabled={busy || !parseCode(code)}>
                {busy && parseCode(code) ? t('tog.searching') : t('tog.join')}
              </button>
            </form>
          </>
        ) : (
          <>
            <p>
              <span class={`tog-dot ${s.status}`} /> {s.status === 'open' ? t('tog.connected') : t('tog.connecting')}
              {s.item && (
                <>
                  {' · '}
                  <strong>{s.item.title}</strong>
                  {s.item.sub && <span class="muted"> — {s.item.sub}</span>}
                </>
              )}
            </p>
            <People state={s} />
            {s.host && (
              <VisibleSwitch
                on={s.visible}
                onChange={setVisible}
                note={s.visible && s.listed && <small class={s.listed === 'no' ? 'tog-warn' : 'tog-ok'}>{t(s.listed === 'yes' ? 'tog.listed' : s.listed === 'no' ? 'tog.notListed' : 'tog.listing')}</small>}
              />
            )}
            <label class="tog-code">
              <span>{t('tog.invite')}</span>
              <input readOnly value={s.code} spellcheck={false} onFocus={(e) => e.currentTarget.select()} />
            </label>
            <small class="muted">{t('tog.inviteHint')}</small>
            {s.host && s.discoverable === false && s.fullCode && (
              <small class="tog-warn">
                {t('tog.notDiscoverable')}{' '}
                <button class="link" onClick={() => copy(s.fullCode)}>
                  {t('tog.copyFull')}
                </button>
              </small>
            )}
            <div class="tog-actions">
              <button class="btn primary" onClick={() => copy()}>
                {t('tog.copy')}
              </button>
              {s.item && (s.host ? open.item : true) && (
                <button
                  class="btn"
                  onClick={() => {
                    close();
                    if (s.host && open.item) {
                      shareTitle(open.item);
                      go(`/play/${open.item.ratingKey}?t=${Math.floor((open.item.viewOffset ?? 0) / 1000)}`);
                    } else void joinPlayback();
                  }}
                >
                  <Icon name="play" size={18} /> {s.host ? t('tog.start') : t('tog.joinPlayback')}
                </button>
              )}
              <button
                class="btn"
                onClick={() => {
                  leaveTogether();
                  close();
                }}
              >
                {t('tog.leave')}
              </button>
            </div>
          </>
        )}
        {error && <p class="tog-warn">{error}</p>}
      </div>
    </div>
  );
}

function People({ state }: { state: TogetherState }) {
  return (
    <div class="tog-people">
      <span class="tog-person">
        <Avatar name={t('tog.me')} />
        {t('tog.me')}
        {state.host && <small>{t('tog.host')}</small>}
      </span>
      {peers.value.map((p) => (
        <span key={p.id} class="tog-person">
          <Avatar name={p.name} thumb={p.thumb} />
          {p.name}
          {p.host && <small>{t('tog.host')}</small>}
        </span>
      ))}
      {!peers.value.length && <span class="muted">{t('tog.alone')}</span>}
    </div>
  );
}

/** Séances des amis déjà annoncées par une notification (pour ne pas la répéter). */
const announced = new Set<string>();

/**
 * Pastille des participants hors du lecteur (dans le lecteur : l'indicateur près des commandes),
 * annonces des actions des autres, et notification discrète quand un ami lance une séance visible.
 */
export function TogetherBar() {
  const s = together.value;
  const notice = s?.notice;
  const playing = inPlayer();
  useEffect(() => {
    // Dans le lecteur, l'annonce s'affiche dans le lecteur (TogetherNotice).
    if (notice && !inPlayer() && Date.now() - notice.at < 3000) say(noticeText(notice));
  }, [notice?.at]);
  // L'hôte passe à l'épisode suivant (ou change de titre) : on le suit.
  const hostGuid = s?.item ? itemId(s.item) : undefined;
  useEffect(() => {
    if (s && !s.host && hostGuid && playingGuid.value && playingGuid.value !== hostGuid) void joinPlayback();
  }, [hostGuid]);
  // Invitation ouverte par un lien (#/together/MPX-…).
  useEffect(() => {
    const [kind, code] = route.value.parts;
    if (kind !== 'together' || !code) return;
    go('/', true);
    void joinTogether(decodeURIComponent(code)).then(
      () => (togetherOpen.value = {}),
      () => say(t('tog.badCode')),
    );
  }, [route.value.parts.join('/')]);
  // Séances des amis : relevées de temps en temps, tant qu'on peut les annoncer.
  const token = auth.value?.token;
  const notify = settings.value.togetherNotify;
  useEffect(() => {
    if (!token || !notify) return;
    const poll = () => {
      if (!document.hidden && !together.peek()) void refreshFriendSessions().catch(() => {});
    };
    const first = setTimeout(poll, 4000);
    const timer = setInterval(poll, 45_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [token, notify]);
  const list = friendSessions.value;
  useEffect(() => {
    const fresh = list.filter((f) => !announced.has(f.room));
    for (const f of fresh) announced.add(f.room);
    // Discrète : pas pendant une séance ni dans le lecteur, et une seule à la fois.
    const first = fresh[0];
    if (!first || !settings.peek().togetherNotify || together.peek() || inPlayer()) return;
    say(t('tog.friendStarted').replace('{name}', first.card.name).replace('{title}', first.card.title), {
      label: t('tog.join'),
      run: () =>
        void joinFriendAndPlay(first).catch((e: Error) => {
          say(errorText(e));
        }),
    });
  }, [list]);
  if (!s || playing) return null;
  return (
    <button class="tog-bar" onClick={() => (togetherOpen.value = {})} title={t('tog.title')}>
      <span class={`tog-dot ${s.status}`} />
      <span class="tog-faces">
        {peers.value.slice(0, 4).map((p) => (
          <Avatar key={p.id} name={p.name} thumb={p.thumb} />
        ))}
      </span>
      <span>{t('tog.count').replace('{n}', String(peers.value.length + 1))}</span>
      {!s.host && s.item && playingGuid.value !== itemId(s.item) && (
        <span
          class="tog-bar-join"
          role="button"
          onClick={(e) => {
            e.stopPropagation();
            void joinPlayback();
          }}
        >
          <Icon name="play" size={14} /> {t('tog.joinPlayback')}
        </span>
      )}
    </button>
  );
}

/** Un participant tel que l'indicateur du lecteur le montre (lecteur web et natif). */
export interface TogetherPerson {
  id: string;
  name: string;
  thumb?: string;
  host: boolean;
  me?: boolean;
  state: 'playing' | 'paused' | 'away';
}

/** Participants de la séance, moi d'abord. */
export function sessionPeople(): TogetherPerson[] {
  const s = together.value;
  if (!s) return [];
  return [
    { id: 'me', name: auth.value?.user?.title || t('tog.me'), host: s.host, me: true, state: 'playing' },
    ...peers.value.map((p): TogetherPerson => ({ id: p.id, name: p.name, thumb: p.thumb, host: p.host, state: !p.live ? 'away' : p.playing ? 'playing' : 'paused' })),
  ];
}

/**
 * Indicateur des participants, près des commandes du lecteur : point de connexion, visages et
 * nombre. Il s'ouvre (comme Audio ou Sous-titres) sur la liste complète. L'heure et l'heure de fin,
 * en haut à droite, restent ainsi toujours dégagées.
 */
export function TogetherPillView({ people, status, open, onToggle, onLeave, onInvite }: { people: TogetherPerson[]; status: string; open: boolean; onToggle: () => void; onLeave: () => void; onInvite?: () => void }) {
  const others = people.filter((p) => !p.me);
  const label = t('tog.indicator').replace('{n}', String(people.length));
  return (
    <span class={`pill-wrap tog-pill-wrap${open ? ' open' : ''}`}>
      {open && (
        <div class="pill-panel tog-panel" role="dialog" aria-label={t('tog.participants')}>
          <ul class="tog-panel-list">
            {people.map((p) => (
              <li key={p.id}>
                <Avatar name={p.name} thumb={p.thumb} />
                <span class="tog-panel-name">{p.me ? t('tog.me') : p.name}</span>
                {p.host && <small class="tog-host">{t('tog.host')}</small>}
                {!p.me && <small class="tog-panel-state">{t(p.state === 'playing' ? 'tog.statePlaying' : p.state === 'paused' ? 'tog.statePaused' : 'tog.stateAway')}</small>}
              </li>
            ))}
          </ul>
          <div class="tog-panel-actions">
            {onInvite && (
              <button class="btn" onClick={onInvite}>
                <Icon name="together" size={18} /> {t('tog.invitePeople')}
              </button>
            )}
            <button class="btn" onClick={onLeave}>
              {t('tog.leave')}
            </button>
          </div>
        </div>
      )}
      <button class="btn pill tog-pill" data-act="together" aria-label={label} title={label} aria-expanded={open} onClick={onToggle}>
        <i class={`tog-dot ${status}`} aria-hidden="true" />
        {others.length ? (
          <i class="tog-faces" aria-hidden="true">
            {others.slice(0, 3).map((p) => (
              <Avatar key={p.id} name={p.name} thumb={p.thumb} />
            ))}
          </i>
        ) : (
          <Icon name="together" />
        )}
        <b>{people.length}</b>
      </button>
    </span>
  );
}

/** Indicateur du lecteur web, d'après la séance en cours. */
export function TogetherPill({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const s = together.value;
  if (!s) return null;
  return (
    <TogetherPillView
      people={sessionPeople()}
      status={s.status}
      open={open}
      onToggle={onToggle}
      onInvite={() => {
        onToggle();
        togetherOpen.value = {};
      }}
      onLeave={() => {
        onToggle();
        leaveTogether();
      }}
    />
  );
}

/** Dernière action d'un autre participant, quelques secondes, au milieu en haut du lecteur. */
export function TogetherNotice({ text, at }: { text?: string; at?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!at) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, at + 4000 - Date.now()));
    return () => clearTimeout(timer);
  }, [at]);
  if (!text || !at || Date.now() - at >= 4000) return null;
  return (
    <div class="player-notice tog-notice" role="status" key={at}>
      <Icon name="together" size={18} />
      <span>{text}</span>
    </div>
  );
}

/**
 * Une seule lecture pendant une séance : avant d'ouvrir le lecteur sur un autre titre que celui
 * de la séance, on propose de quitter la séance (et, à l'hôte, de lancer ce titre pour tous).
 * La décision est prise une fois, à l'ouverture du lecteur.
 */
export function TogetherGate({ id, offline, children }: { id: string; offline?: boolean; children: ComponentChildren }) {
  const [state, setState] = useState<{ verdict: 'checking' | 'none' | 'switch' | 'leave'; item?: Metadata }>(() => ({ verdict: together.peek() ? 'checking' : 'none' }));
  useEffect(() => {
    if (state.verdict !== 'checking') return;
    if (offline) return setState({ verdict: 'leave' });
    let alive = true;
    server.value
      ?.metadata(id)
      .then(
        (m) => alive && setState({ verdict: playConflict(m), item: m }),
        () => alive && setState({ verdict: 'none' }),
      );
    return () => {
      alive = false;
    };
  }, [id]);
  const s = together.value;
  if (state.verdict === 'none' || !s) return <>{children}</>;
  if (state.verdict === 'checking') {
    return (
      <div class="player native show-ui">
        <Spinner />
      </div>
    );
  }
  const session = s.item?.title ?? t('tog.title');
  const title = state.item?.title ?? '';
  const lead = state.verdict === 'switch' ? t('tog.conflictHost') : title ? t('tog.conflictLeave') : t('tog.conflictLeaveAny');
  return (
    <div class="whatsnew-veil" role="dialog" aria-modal="true" aria-label={t('tog.conflictTitle')}>
      <div class="whatsnew tog-dialog">
        <h2>
          <Icon name="together" /> {t('tog.conflictTitle')}
        </h2>
        <p>{lead.replace('{title}', title).replace('{session}', session)}</p>
        <div class="tog-actions">
          {state.verdict === 'switch' && state.item && (
            <button
              class="btn primary"
              autoFocus
              onClick={() => {
                shareTitle(state.item!);
                setState({ verdict: 'none' });
              }}
            >
              {t('tog.playForAll')}
            </button>
          )}
          <button
            class={`btn${state.verdict === 'switch' ? '' : ' primary'}`}
            autoFocus={state.verdict !== 'switch'}
            onClick={() => {
              leaveTogether();
              setState({ verdict: 'none' });
            }}
          >
            {t('tog.leaveAndPlay')}
          </button>
          <button class="btn" onClick={back}>
            {t('tog.stay')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Page Amis : les séances visibles, quand il y en a. */
export function FriendSessionsSection() {
  const list = friendSessions.value;
  const [error, setError] = useState('');
  const friend = useJoinFriend(setError);
  useEffect(() => {
    if (!together.peek()) void refreshFriendSessions().catch(() => {});
  }, []);
  if (!list.length || together.value) return null;
  return (
    <section class="tog-friends-section">
      <h2>{t('tog.friends')}</h2>
      <p class="muted">{t('tog.friendsLead')}</p>
      <FriendSessions list={list} busy={friend.busy} onJoin={friend.join} />
      {error && <p class="tog-warn">{error}</p>}
    </section>
  );
}

/** Réglage : adresse du relais, avec un essai. */
export function RelaySetting() {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'ko' | 'nows' | 'old'>('idle');
  const value = settings.value.togetherRelay;
  const test = () => {
    const ws = relayUrl();
    if (!ws) return setState('ko');
    setState('testing');
    fetch(`${ws.replace(/^ws/, 'http')}/health`, { cache: 'no-store' })
      .then((r) => r.text())
      .then((txt) => {
        if (txt.trim() !== 'ok') return setState('ko');
        // Le relais répond ; reste à vérifier que le proxy laisse passer les WebSocket.
        const room = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
        const sock = new WebSocket(`${ws}/r/${room}`);
        const timer = setTimeout(() => {
          sock.close();
          setState('nows');
        }, 6000);
        sock.onopen = () => {
          clearTimeout(timer);
          sock.close();
          // Un relais d'avant les invitations courtes ne sait pas dire quelles salles existent.
          fetch(roomsUrl(ws, []), { cache: 'no-store' })
            .then((r) => r.json())
            .then((a) => setState(isRoomsAnswer(a) ? 'ok' : 'old'), () => setState('old'));
        };
        sock.onerror = () => {
          clearTimeout(timer);
          setState('nows');
        };
      })
      .catch(() => setState('ko'));
  };
  return (
    <span class="relay-setting">
      <input
        type="text"
        placeholder="https://relais.mon-nas.fr"
        value={value}
        spellcheck={false}
        onChange={(e) => {
          update({ togetherRelay: e.currentTarget.value.trim().slice(0, 300) });
          setState('idle');
        }}
      />
      <button class="btn" disabled={!value || state === 'testing'} onClick={test}>
        {t('tog.test')}
      </button>
      {state !== 'idle' && <small class={`relay-${state}`}>{t(`tog.test.${state}`)}</small>}
      <small class="muted relay-hint">{t('tog.relayHint')}</small>
    </span>
  );
}
