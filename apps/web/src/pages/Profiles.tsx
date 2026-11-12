import type { HomeUser } from '@multiplex/core';
import { useState } from 'preact/hooks';
import { t } from '../i18n';
import { go } from '../router';
import { auth, home, switchProfile } from '../store';
import { Icon } from '../ui';

/** « Qui regarde ? » : les profils du foyer Plex Home, avec code PIN pour ceux qui sont protégés. */
export function ProfilesPage() {
  const users = home.value;
  const current = auth.value?.user.uuid;
  const [asking, setAsking] = useState<HomeUser | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const enter = async (u: HomeUser, code?: string) => {
    if (u.uuid === current) return go('/');
    if (u.protected && code === undefined) {
      setAsking(u);
      setPin('');
      setError('');
      return;
    }
    setBusy(u.uuid);
    setError('');
    try {
      await switchProfile(u.uuid, code);
      go('/');
    } catch {
      setError(t(u.protected ? 'home.badPin' : 'home.failed'));
      setPin('');
    }
    setBusy('');
  };

  return (
    <div class="page profiles">
      <h1>{t('home.title')}</h1>
      <div class="profile-grid">
        {users.map((u) => (
          <button key={u.uuid} class={`profile${u.uuid === current ? ' on' : ''}`} disabled={!!busy} onClick={() => void enter(u)}>
            <span class="profile-face">
              {u.thumb ? <img referrerpolicy="no-referrer" src={u.thumb} alt="" /> : <b>{u.title.slice(0, 1).toUpperCase()}</b>}
              {u.protected && (
                <i class="profile-lock" title={t('home.protected')}>
                  <Icon name="lock" size={14} />
                </i>
              )}
            </span>
            <strong>{u.title}</strong>
            <small class="muted">{busy === u.uuid ? t('servers.connecting') : u.uuid === current ? t('home.current') : u.admin ? t('home.admin') : u.restricted ? t('home.managed') : ' '}</small>
          </button>
        ))}
      </div>

      {asking && (
        <form
          class="profile-pin"
          onSubmit={(e) => {
            e.preventDefault();
            if (pin.length === 4) void enter(asking, pin);
          }}
        >
          <label>
            {t('home.pin')} <strong>{asking.title}</strong>
            <input
              type="password"
              inputMode="numeric"
              autocomplete="off"
              pattern="[0-9]{4}"
              maxLength={4}
              autofocus
              value={pin}
              onInput={(e) => {
                const v = e.currentTarget.value.replace(/\D/g, '').slice(0, 4);
                setPin(v);
                // Quatre chiffres : on n'attend pas la touche Entrée.
                if (v.length === 4) void enter(asking, v);
              }}
            />
          </label>
          <button type="button" class="btn" onClick={() => setAsking(null)}>
            {t('common.cancel')}
          </button>
        </form>
      )}
      {error && (
        <p class="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
