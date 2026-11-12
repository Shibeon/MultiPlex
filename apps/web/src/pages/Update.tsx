import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import changelog from '../changelog.json';
import { load, save } from '../settings';
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

type Notes = { version: string; fr: string[]; en: string[] };
const LOG = changelog as Notes[];
/** Version de l'interface : la première entrée du journal des nouveautés. */
export const VERSION = LOG[0].version;
const lines = (n: { fr: string[]; en: string[] }) => (settings.value.lang === 'fr' ? n.fr : n.en);

const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split('.').map((n) => Number(n) || 0));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/**
 * Versions dont les nouveautés n'ont pas encore été montrées. Une installation toute
 * neuve n'en a pas ; une installation d'avant ce journal voit celles de la version en cours.
 */
function unseen(): Notes[] {
  const seen = load<string>('mp.seenVersion');
  if (seen) return LOG.filter((n) => newer(n.version, seen));
  if (load('mp.auth') || load('mp.settings')) return LOG.slice(0, 1);
  save('mp.seenVersion', VERSION);
  return [];
}
const pending = signal<Notes[]>(isOverlayWindow ? [] : unseen());
/** Rouvre les nouveautés de la version en cours (depuis les réglages). */
export const showWhatsNew = () => (pending.value = LOG.slice(0, 1));

/** Après une mise à jour : ce qui a changé, une seule fois. */
export function WhatsNew() {
  const list = pending.value;
  if (!list.length) return null;
  const close = () => {
    save('mp.seenVersion', VERSION);
    pending.value = [];
  };
  return (
    <div class="whatsnew-veil" role="dialog" aria-modal="true" aria-label={t('new.title')} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div class="whatsnew">
        <h2>{t('new.title')}</h2>
        {list.map((n) => (
          <section key={n.version}>
            <h3>
              {t('upd.version')} {n.version}
            </h3>
            <ul>
              {lines(n).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </section>
        ))}
        <button class="btn primary" autofocus onClick={close}>
          {t('new.ok')}
        </button>
      </div>
    </div>
  );
}

/** Nouveautés d'une version proposée : liste dans la langue de l'interface, ou texte tel quel. */
function notesLines(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw) as { fr?: unknown; en?: unknown };
    const l = settings.value.lang === 'fr' ? j.fr : j.en;
    if (Array.isArray(l)) return l.filter((x): x is string => typeof x === 'string').slice(0, 20);
  } catch {
    /* texte libre */
  }
  return raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
}

/** Vrai dans l'application de bureau, où la mise à jour automatique existe. */
export const canUpdate = !!native?.updates;

/** Bandeau discret en bas de l'écran : une version est disponible, en cours de téléchargement, ou prête. */
export function UpdateBanner() {
  const u = update.value;
  const [open, setOpen] = useState(false);
  if (!native?.updates || !settings.value.autoUpdate) return null;
  if (!['available', 'downloading', 'ready'].includes(u.status)) return null;
  if (u.status === 'available' && dismissed.value === u.version) return null;
  const news = notesLines(u.notes);
  return (
    <div class="update-banner" role="status">
      {open && news.length > 0 && (
        <ul class="update-notes">
          {news.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <span>
        {u.status === 'ready' ? t('upd.ready') : u.status === 'downloading' ? `${t('upd.downloading')} ${u.percent ?? 0} %` : t('upd.available')} <strong>{u.version}</strong>
      </span>
      {u.status === 'downloading' && (
        <span class="progress">
          <i style={{ width: `${u.percent ?? 0}%` }} />
        </span>
      )}
      {news.length > 0 && (
        <button class="btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('upd.whatsNew')}
        </button>
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
  if (!native?.updates)
    return (
      <div class="set-row">
        <span>
          {t('upd.version')} {VERSION}
        </span>
        <button class="btn" onClick={showWhatsNew}>
          {t('new.show')}
        </button>
      </div>
    );
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
      <span class="inline">
        <button class="btn" onClick={showWhatsNew}>
          {t('new.show')}
        </button>
        <button class="btn" disabled={u.status === 'checking' || u.status === 'downloading'} onClick={() => void native!.updates!.check()}>
          {t('upd.check')}
        </button>
      </span>
    </div>
  );
}
