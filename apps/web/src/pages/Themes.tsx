import { THEME_REQUIRED, getJson, parseGallery, parseTheme, type ThemeFile } from '@multiplex/core';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../i18n';
import { THEMES, settings, update } from '../settings';
import { ErrorBox, Icon, Spinner } from '../ui';

/** Thèmes livrés avec l'application, présentés au même format que ceux de la galerie. */
const BUILT_IN: ThemeFile[] = Object.entries(THEMES).map(([id, th]) => ({
  id,
  name: th.name,
  author: 'MultiPlex',
  mode: id === 'light' ? 'light' : 'dark',
  vars: th.vars,
}));

const isApplied = (theme: ThemeFile, builtIn: boolean) => settings.value.theme === (builtIn ? theme.id : `gallery:${theme.id}`);

function apply(theme: ThemeFile, builtIn: boolean): void {
  // Un thème de la galerie n'est qu'un jeu de variables posé par-dessus le thème de base.
  const art = { themeImage: theme.image ?? '', themeImageCredit: theme.imageCredit ?? '', themeEffect: theme.effect ?? '', themeMotto: theme.motto ?? '' };
  if (builtIn) update({ theme: theme.id, customVars: {}, accent: '', themeLabel: '', ...art });
  else update({ theme: `gallery:${theme.id}`, customVars: theme.vars, accent: '', themeLabel: theme.name, ...art, ...(theme.radius !== undefined ? { radius: theme.radius } : {}) });
}

/** Aperçu : une maquette miniature de l'interface, dessinée avec les couleurs du thème. */
function ThemeCard({ theme, builtIn }: { theme: ThemeFile; builtIn: boolean }) {
  const on = isApplied(theme, builtIn);
  return (
    <article class={`theme-card${on ? ' on' : ''}`}>
      <div class="theme-preview" style={{ ...theme.vars, borderRadius: `${theme.radius ?? 14}px` }} aria-hidden="true">
        {theme.image && <img class="tp-art" src={theme.image} alt="" />}
        <div class="tp-bar">
          <i />
          <i />
          <i />
        </div>
        <div class="tp-title">Aa</div>
        <div class="tp-sub" />
        <div class="tp-row">
          <span class="tp-btn" />
          <span class="tp-ghost" />
        </div>
        <div class="tp-posters">
          <b />
          <b />
          <b />
          <b />
        </div>
      </div>
      <div class="theme-text">
        <strong>{theme.name}</strong>
        <small class="muted">
          {theme.author}
          {theme.mode === 'light' ? ` · ${t('themes.light')}` : ''}
        </small>
        {theme.description && <p class="muted">{theme.description}</p>}
        {theme.imageCredit && <p class="muted theme-credit">{theme.imageCredit}</p>}
      </div>
      <button class={`btn${on ? '' : ' primary'}`} disabled={on} onClick={() => apply(theme, builtIn)}>
        {on ? (
          <>
            <Icon name="check" size={16} /> {t('themes.applied')}
          </>
        ) : (
          t('themes.apply')
        )}
      </button>
    </article>
  );
}

export function ThemesPage() {
  const s = settings.value;
  const [community, setCommunity] = useState<ThemeFile[] | null>(null);
  const [remote, setRemote] = useState<ThemeFile[]>([]);
  const [remoteError, setRemoteError] = useState('');
  const [message, setMessage] = useState('');
  const [url, setUrl] = useState(s.galleryUrl);

  useEffect(() => {
    // La galerie embarquée n'est chargée qu'à l'ouverture de cette page.
    import('../gallery/themes.json').then((m) => setCommunity(parseGallery(m.default))).catch(() => setCommunity([]));
  }, []);

  useEffect(() => {
    setRemote([]);
    setRemoteError('');
    if (!s.galleryUrl) return;
    let alive = true;
    getJson<unknown>(s.galleryUrl, { timeout: 8000 })
      .then((data) => alive && setRemote(parseGallery(data)))
      .catch(() => alive && setRemoteError(t('themes.remoteError')));
    return () => {
      alive = false;
    };
  }, [s.galleryUrl]);

  const share = () => {
    // Le thème tel qu'il est affiché en ce moment, couleur d'accent personnalisée comprise.
    const style = getComputedStyle(document.documentElement);
    const vars: Record<string, string> = {};
    for (const key of [...THEME_REQUIRED, '--on-accent']) vars[key] = style.getPropertyValue(key).trim();
    const name = s.themeLabel || THEMES[s.theme]?.name || 'Mon thème';
    const id =
      name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'mon-theme';
    const theme = parseTheme({ id, name, author: '', vars, radius: s.radius, image: s.themeImage || undefined, imageCredit: s.themeImageCredit || undefined, effect: s.themeEffect || undefined, motto: s.themeMotto || undefined });
    if (!theme) return setMessage(t('themes.shareError'));
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(theme, null, 2) + '\n'], { type: 'application/json' }));
    link.download = `${theme.id}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    setMessage(t('themes.shared'));
  };

  const importFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const theme = parseTheme(JSON.parse(await file.text()));
      if (!theme) throw new Error('invalid');
      apply(theme, false);
      setMessage(`${t('themes.imported')} ${theme.name}`);
    } catch {
      setMessage(t('themes.importError'));
    }
  };

  const saveUrl = (e: Event) => {
    e.preventDefault();
    const clean = url.trim();
    // Une galerie en ligne ne se charge qu'en HTTPS.
    if (clean && !/^https:\/\//i.test(clean)) return setRemoteError(t('themes.httpsOnly'));
    update({ galleryUrl: clean });
  };

  const section = (title: string, list: ThemeFile[], builtIn: boolean) =>
    list.length > 0 && (
      <section class="theme-section">
        <h2>
          {title} <span class="muted">{list.length}</span>
        </h2>
        <div class="theme-grid">
          {list.map((th) => (
            <ThemeCard key={th.id} theme={th} builtIn={builtIn} />
          ))}
        </div>
      </section>
    );

  return (
    <div class="page themes">
      <header class="page-head">
        <h1>{t('themes.title')}</h1>
        <span class="spacer" />
        <button class="btn" onClick={share}>
          {t('themes.share')}
        </button>
        <label class="btn" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.querySelector('input') as HTMLInputElement).click()}>
          {t('themes.import')}
          <input type="file" accept="application/json,.json" hidden onChange={(e) => void importFile(e)} />
        </label>
      </header>
      <p class="muted">{t('themes.lead')}</p>
      {message && (
        <p class="theme-message" role="status">
          {message}
        </p>
      )}

      {section(t('themes.builtIn'), BUILT_IN, true)}
      {community === null ? <Spinner /> : section(t('themes.community'), community, false)}
      {section(t('themes.online'), remote, false)}

      <section class="theme-section">
        <h2>{t('themes.onlineTitle')}</h2>
        <p class="muted">{t('themes.onlineHelp')}</p>
        <form class="theme-url" onSubmit={saveUrl}>
          <input type="url" placeholder="https://…/themes.json" aria-label={t('themes.onlineTitle')} value={url} onInput={(e) => setUrl(e.currentTarget.value)} />
          <button class="btn">{t('themes.load')}</button>
        </form>
        {remoteError && <ErrorBox error={remoteError} />}
        <p class="muted small">{t('themes.contribute')}</p>
      </section>
    </div>
  );
}
