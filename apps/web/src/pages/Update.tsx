import { effect, signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import changelog from '../changelog.json';
import versions from '../../../../versions.json';
import { platform } from '../platform';
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
  // Silencieuse par défaut : l'app de bureau télécharge seule et installe à la fermeture.
  effect(() => void native!.updates!.setAuto?.(settings.value.autoUpdate)?.catch(() => {}));
}

type Notes = { version: string; fr: string[]; en: string[] };
type Entry = { versions: Partial<Record<string, string>>; fr: string[]; en: string[] };
/** Nouveautés de cette plateforme seulement, avec son propre numéro, la plus récente d'abord. */
const LOG: Notes[] = (changelog as Entry[]).flatMap((e) => {
  const version = e.versions[platform];
  return version ? [{ version, fr: e.fr, en: e.en }] : [];
});
/** Version de cette plateforme (versions.json : bureau, web, Android et TV ont chacun la leur). */
export const VERSION: string = (versions as Record<string, string>)[platform];
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
function notesLines(raw: string | undefined, current = ''): string[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw) as { fr?: unknown; en?: unknown; log?: Notes[] };
    // Plusieurs versions manquées : tout ce qui a changé depuis celle qui est installée.
    if (Array.isArray(j.log) && current) {
      const missed = j.log.filter((n) => n && typeof n.version === 'string' && newer(n.version, current) && Array.isArray(n.fr) && Array.isArray(n.en));
      if (missed.length > 1) return missed.flatMap((n) => lines(n).map((l) => `${n.version} — ${l}`)).slice(0, 60);
    }
    const l = settings.value.lang === 'fr' ? j.fr : j.en;
    if (Array.isArray(l)) return l.filter((x): x is string => typeof x === 'string').slice(0, 20);
  } catch {
    /* texte libre */
  }
  return raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
}

/** Vrai dans l'application de bureau, où la mise à jour automatique existe. */
export const canUpdate = !!native?.updates;

/**
 * Bandeau discret en bas de l'écran. Mise à jour silencieuse (par défaut) : rien pendant le
 * téléchargement, puis « version prête » avec Redémarrer (installation silencieuse et relance
 * immédiate) ou Plus tard (installée alors au prochain lancement). Réglage coupé : la version
 * est d'abord proposée, téléchargée sur demande, puis prête à redémarrer.
 */
export function UpdateBanner() {
  const u = update.value;
  const [open, setOpen] = useState(false);
  const silent = settings.value.autoUpdate && !!native?.updates?.setAuto;
  if (!native?.updates) return null;
  if (!(silent ? ['ready'] : ['available', 'downloading', 'ready']).includes(u.status)) return null;
  if ((u.status === 'available' || u.status === 'ready') && dismissed.value === `${u.status}:${u.version}`) return null;
  const news = notesLines(u.notes, u.current);
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
          <button class="btn" onClick={() => (dismissed.value = `available:${u.version}`)}>
            {t('upd.later')}
          </button>
        </>
      )}
      {u.status === 'ready' && (
        <>
          <button class="btn primary" onClick={() => void native!.updates!.install()}>
            {t('upd.restart')}
          </button>
          {silent && (
            <button class="btn" title={t('upd.laterHint')} onClick={() => (dismissed.value = `ready:${u.version}`)}>
              {t('upd.later')}
            </button>
          )}
        </>
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
          {t('upd.version')} {t(`plat.${platform}`)} {VERSION}
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
          : u.status === 'ready' && settings.value.autoUpdate
            ? t(u.when === 'restart' ? 'upd.onRestart' : u.when === 'launch' ? 'upd.onLaunch' : 'upd.onQuit').replace('{v}', u.version ?? '')
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
