// « Regarder ensemble » : bouton, fenêtre de séance (créer, inviter, rejoindre) et pastille des
// participants.
import type { Metadata } from '@multiplex/core';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { t } from './i18n';
import { say } from './menu';
import { go, route } from './router';
import { settings, update } from './settings';
import { server } from './store';
import { itemId, joinTogether, leaveTogether, parseCode, peers, playingGuid, relayUrl, sessionTime, startTogether, together, type TogetherState } from './together';
import { Icon } from './ui';

/** Fenêtre ouverte, avec le titre depuis lequel on l'a ouverte (s'il y en a un). */
export const togetherOpen = signal<{ item?: Metadata } | null>(null);

export const noticeText = (n: NonNullable<TogetherState['notice']>) => t(n.action === 'pause' ? 'tog.paused' : n.action === 'play' ? 'tog.played' : 'tog.seeked').replace('{name}', n.name);

/** Lance chez soi le titre de la séance, à la position de la séance. */
export async function joinPlayback(): Promise<void> {
  const item = together.value?.item;
  const srv = server.value;
  if (!item || !srv) return;
  const local =
    (item.guid ? await srv.findByGuid(item.guid).catch(() => undefined) : undefined) ??
    (item.server === srv.id && item.key ? await srv.metadata(item.key).catch(() => undefined) : undefined);
  if (!local) {
    say(t('tog.missing').replace('{title}', item.title));
    return;
  }
  go(`/play/${local.ratingKey}?t=${Math.max(0, Math.floor(sessionTime()))}`);
}

export function TogetherButton({ item }: { item: Metadata }) {
  const s = together.value;
  if (s?.host) {
    return (
      <button class="btn" onClick={() => go(`/play/${item.ratingKey}?t=${Math.floor((item.viewOffset ?? 0) / 1000)}`)} title={t('tog.title')}>
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

const Avatar = ({ name, thumb }: { name: string; thumb?: string }) => (
  <span class="tog-avatar" title={name}>
    {thumb ? <img src={thumb} alt="" referrerpolicy="no-referrer" /> : <b>{name.slice(0, 1).toUpperCase()}</b>}
  </span>
);

export function TogetherDialog() {
  const open = togetherOpen.value;
  const s = together.value;
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setError('');
    setBusy(false);
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
        setError(t(e.message === 'code' ? 'tog.badCode' : e.message === 'relay' ? 'tog.noRelay' : 'tog.failed'));
      },
    );
  };
  const copy = () =>
    void navigator.clipboard?.writeText(s!.code).then(
      () => say(t('tog.copied')),
      () => setError(t('tog.copyFailed')),
    );

  return (
    <div class="whatsnew-veil" role="dialog" aria-modal="true" aria-label={t('tog.title')} onClick={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div class="whatsnew tog-dialog">
        <h2>
          <Icon name="together" /> {t('tog.title')}
        </h2>
        {!s ? (
          <>
            <p class="muted">{t('tog.lead')}</p>
            {relay ? (
              <button class="btn primary" disabled={busy} onClick={() => run(() => startTogether(open.item))}>
                {open.item ? t('tog.createWith').replace('{title}', open.item.title) : t('tog.create')}
              </button>
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
                {t('tog.join')}
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
            <div class="tog-people">
              <span class="tog-person">
                <Avatar name={t('tog.me')} />
                {t('tog.me')}
                {s.host && <small>{t('tog.host')}</small>}
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
            <label class="tog-code">
              <span>{t('tog.invite')}</span>
              <input readOnly value={s.code} onFocus={(e) => e.currentTarget.select()} />
            </label>
            <small class="muted">{t('tog.inviteHint')}</small>
            <div class="tog-actions">
              <button class="btn primary" onClick={copy}>
                {t('tog.copy')}
              </button>
              {s.item && (s.host ? open.item : true) && (
                <button
                  class="btn"
                  onClick={() => {
                    close();
                    if (s.host && open.item) go(`/play/${open.item.ratingKey}?t=${Math.floor((open.item.viewOffset ?? 0) / 1000)}`);
                    else void joinPlayback();
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

/** Pastille des participants, tant qu'une séance est ouverte ; annonce les actions des autres. */
export function TogetherBar() {
  const s = together.value;
  const notice = s?.notice;
  useEffect(() => {
    if (notice && Date.now() - notice.at < 3000) say(noticeText(notice));
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
  if (!s) return null;
  const inPlayer = route.value.parts[0] === 'play';
  return (
    <button class={`tog-bar${inPlayer ? ' in-player' : ''}`} onClick={() => (togetherOpen.value = {})} title={t('tog.title')}>
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

/** Réglage : adresse du relais, avec un essai. */
export function RelaySetting() {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'ko' | 'nows'>('idle');
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
          setState('ok');
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
    </span>
  );
}
