import { signal } from '@preact/signals';
import { t } from '../i18n';
import { isOverlayWindow, native, type UpdateState } from '../native';
import { settings } from '../settings';

/** État de la mise à jour de l'application de bureau ; reste « idle » dans un navigateur. */
export const update = signal<UpdateState>({ status: 'idle', current: '' });
const dismissed = signal('');

if (native?.updates && !isOverlayWindow) {
  native.updates
    .state()
    .then((s) => (update.value = s))
    .catch(() => {});
  native.updates.on((s) => (update.value = s));
}

/** Vrai dans l'application de bureau, où la mise à jour automatique existe. */
export const canUpdate = !!native?.updates;

/** Bandeau discret en bas de l'écran : une version est disponible, en cours de téléchargement, ou prête. */
export function UpdateBanner() {
  const u = update.value;
  if (!native?.updates || !settings.value.autoUpdate) return null;
  if (!['available', 'downloading', 'ready'].includes(u.status)) return null;
  if (u.status === 'available' && dismissed.value === u.version) return null;
  return (
    <div class="update-banner" role="status">
      <span>
        {u.status === 'ready' ? t('upd.ready') : u.status === 'downloading' ? `${t('upd.downloading')} ${u.percent ?? 0} %` : t('upd.available')} <strong>{u.version}</strong>
      </span>
      {u.status === 'downloading' && (
        <span class="progress">
          <i style={{ width: `${u.percent ?? 0}%` }} />
        </span>
      )}
      {u.status === 'available' && (
        <>
          <button class="btn primary" onClick={() => void native!.updates!.download()}>
            {t('upd.download')}
          </button>
          <button class="btn" onClick={() => (dismissed.value = u.version ?? '')}>
            {t('upd.later')}
          </button>
        </>
      )}
      {u.status === 'ready' && (
        <button class="btn primary" onClick={() => void native!.updates!.install()}>
          {t('upd.restart')}
        </button>
      )}
    </div>
  );
}

/** Ligne des réglages : version installée et recherche manuelle. */
export function UpdateSettings() {
  const u = update.value;
  if (!native?.updates) return null;
  const label =
    u.status === 'checking'
      ? t('upd.checking')
      : u.status === 'none'
        ? t('upd.none')
        : u.status === 'error'
          ? t('upd.error')
          : u.status === 'available' || u.status === 'downloading' || u.status === 'ready'
            ? `${t('upd.available')} ${u.version}`
            : '';
  return (
    <div class="set-row">
      <span>
        {t('upd.version')} {u.current}
        {label && <small class="muted"> — {label}</small>}
      </span>
      <button class="btn" disabled={u.status === 'checking' || u.status === 'downloading'} onClick={() => void native!.updates!.check()}>
        {t('upd.check')}
      </button>
    </div>
  );
}
