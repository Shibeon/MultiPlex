import { checkPin, createPin, pinAuthUrl, type PlexPin } from '@multiplex/core';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n';
import { auth, bootError, client, connect, connectManual, logout, resources, signIn, startDemo, status } from '../store';
import { Spinner } from '../ui';

function Shell({ children }: { children: ComponentChildren }) {
  return (
    <main class="gate">
      <div class="gate-card">
        <h1 class="brand">
          Multi<span>Plex</span>
        </h1>
        {children}
      </div>
    </main>
  );
}

export function Connecting() {
  return (
    <Shell>
      <Spinner />
      <p class="muted">{t('servers.connecting')}</p>
    </Shell>
  );
}

export function Login() {
  const [pins, setPins] = useState<{ strong: PlexPin; short: PlexPin } | null>(null);
  const [err, setErr] = useState('');
  const [gen, setGen] = useState(0);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    let polls = 0;
    setPins(null);
    (async () => {
      try {
        const [strong, short] = await Promise.all([createPin(client, true), createPin(client, false)]);
        if (!alive) return;
        setPins({ strong, short });
        const poll = async () => {
          if (!alive) return;
          try {
            for (const pin of [strong, short]) {
              const tok = await checkPin(client, pin);
              if (tok) return void (await signIn(tok));
            }
          } catch {
            /* coupure réseau passagère : on réessaie au prochain tour */
          }
          // Les codes expirent : on en redemande après ~10 minutes.
          if (++polls > 300) setGen((g) => g + 1);
          else timer = window.setTimeout(poll, 2000);
        };
        timer = window.setTimeout(poll, 2000);
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    })();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [gen]);

  const manual = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await connectManual(url, token);
    } catch {
      setErr(t('login.failed'));
    }
    setBusy(false);
  };

  return (
    <Shell>
      <h2>{t('login.title')}</h2>
      <p class="muted">{t('login.lead')}</p>
      {pins ? (
        <>
          <a class="btn primary big" href={pinAuthUrl(client, pins.strong)} target="_blank" rel="noopener noreferrer">
            {t('login.open')}
          </a>
          <p class="muted">{t('login.code')}</p>
          <div class="pin-code" aria-live="polite">
            {pins.short.code}
          </div>
          <p class="muted small">{t('login.waiting')}</p>
        </>
      ) : err ? null : (
        <Spinner />
      )}
      {err && (
        <p class="error-text" role="alert">
          {err}{' '}
          <button class="link" onClick={() => (setErr(''), setGen((g) => g + 1))}>
            {t('common.retry')}
          </button>
        </p>
      )}
      <button class="btn" onClick={() => void startDemo()}>
        {t('login.demo')}
      </button>
      <details class="manual">
        <summary>{t('login.manual')}</summary>
        <form onSubmit={manual}>
          <input type="url" required placeholder={t('login.url')} aria-label={t('login.url')} value={url} onInput={(e) => setUrl(e.currentTarget.value)} />
          <input type="password" required autocomplete="off" placeholder={t('login.token')} aria-label={t('login.token')} value={token} onInput={(e) => setToken(e.currentTarget.value)} />
          <button class="btn" disabled={busy}>
            {t('login.connect')}
          </button>
        </form>
      </details>
      <p class="muted small">{t('set.about')}</p>
    </Shell>
  );
}

export function ServerPicker() {
  return (
    <Shell>
      <h2>{t('servers.title')}</h2>
      {bootError.value && (
        <p class="error-text" role="alert">
          {t('servers.unreachable')} : {bootError.value}
        </p>
      )}
      {resources.value.length === 0 && <p class="muted">{t('servers.none')}</p>}
      <div class="server-list">
        {resources.value.map((r) => (
          <button key={r.clientIdentifier} class="btn big" onClick={() => void connect(r)}>
            {r.name}
          </button>
        ))}
      </div>
      <button class="btn" onClick={() => void startDemo()}>
        {t('login.demo')}
      </button>
      {auth.value && (
        <button class="link" onClick={logout}>
          {t('set.logout')} ({auth.value.user.username || auth.value.user.title})
        </button>
      )}
    </Shell>
  );
}

export function Gate() {
  const s = status.value;
  if (s === 'login') return <Login />;
  if (s === 'servers') return <ServerPicker />;
  return <Connecting />;
}
