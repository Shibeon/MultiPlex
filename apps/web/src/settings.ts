import { THEME_EFFECTS, isThemeImage, luminance } from '@multiplex/core';
import { effect, signal } from '@preact/signals';

export interface Theme {
  name: string;
  vars: Record<string, string>;
}

/** Thèmes intégrés. Un thème n'est qu'un jeu de variables CSS. */
export const THEMES: Record<string, Theme> = {
  cinema: { name: 'Cinéma', vars: { '--bg': '#000000', '--surface': '#1c1c1e', '--surface-2': '#2c2c2e', '--text': '#ffffff', '--muted': '#98989f', '--accent': '#ffffff', '--on-accent': '#000000', '--backdrop-opacity': '0.6' } },
  midnight: { name: 'Minuit', vars: { '--bg': '#0f1115', '--surface': '#181b22', '--surface-2': '#232733', '--text': '#eceef2', '--muted': '#9aa1ad', '--accent': '#e5a00d', '--on-accent': '#17130a' } },
  amoled: { name: 'AMOLED', vars: { '--bg': '#000000', '--surface': '#0c0c0e', '--surface-2': '#1a1a1e', '--text': '#f2f2f2', '--muted': '#8d8d93', '--accent': '#e5a00d', '--on-accent': '#17130a' } },
  nord: { name: 'Nord', vars: { '--bg': '#2e3440', '--surface': '#3b4252', '--surface-2': '#434c5e', '--text': '#eceff4', '--muted': '#b4bccb', '--accent': '#88c0d0', '--on-accent': '#1d2530' } },
  forest: { name: 'Forêt', vars: { '--bg': '#0e1512', '--surface': '#16211c', '--surface-2': '#203029', '--text': '#e8f0ea', '--muted': '#95a89c', '--accent': '#5fcf8a', '--on-accent': '#08170e' } },
  light: { name: 'Clair', vars: { '--bg': '#f4f5f7', '--surface': '#ffffff', '--surface-2': '#e6e8ec', '--text': '#16181d', '--muted': '#5b6270', '--accent': '#b87400', '--on-accent': '#ffffff' } },
};

export interface Settings {
  lang: 'fr' | 'en';
  theme: string;
  /** Nom du thème de la galerie appliqué (vide pour un thème intégré). */
  themeLabel: string;
  /** Illustration du thème appliqué (image embarquée) et son crédit. */
  themeImage: string;
  themeImageCredit: string;
  /** Mise en scène de l'illustration et devise du thème appliqué. */
  themeEffect: string;
  themeMotto: string;
  /** Adresse d'une galerie de thèmes en ligne (facultative, HTTPS). */
  galleryUrl: string;
  /** 'top' : barre flottante et affiche vedette ; 'side' : barre latérale classique. */
  layout: string;
  /** Couleur d'accent personnalisée ; vide = celle du thème. */
  accent: string;
  /** Surcharges de variables CSS (thème importé / personnalisé). */
  customVars: Record<string, string>;
  customCss: string;
  cardSize: number;
  radius: number;
  uiScale: number;
  showTitles: boolean;
  backdrops: boolean;
  reduceMotion: boolean;
  hiddenHubs: string[];
  hubOrder: string[];
  quality: string;
  directPlay: boolean;
  autoNext: boolean;
  autoSkipIntro: boolean;
  autoSkipCredits: boolean;
  seekStep: number;
  /**
   * Lecteur du navigateur, contenu HDR sur un écran qui ne l'est pas : laisser le
   * serveur convertir l'image en SDR plutôt que de s'en remettre au navigateur,
   * dont le rendu est souvent trop sombre.
   */
  hdrServerOnSdr: boolean;
  /** Application de bureau : lire avec le lecteur natif (mpv) plutôt qu'avec celui du navigateur. */
  nativePlayer: boolean;
  /** Lecteur natif : transmettre l'audio brut (Dolby, DTS, Atmos) à un ampli. */
  passthrough: boolean;
}

export const DEFAULTS: Settings = {
  lang: typeof navigator !== 'undefined' && navigator.language?.startsWith('fr') ? 'fr' : 'en',
  theme: 'cinema',
  themeLabel: '',
  themeImage: '',
  themeImageCredit: '',
  themeEffect: '',
  themeMotto: '',
  galleryUrl: '',
  layout: 'top',
  accent: '',
  customVars: {},
  customCss: '',
  cardSize: 160,
  radius: 14,
  uiScale: 100,
  showTitles: true,
  backdrops: true,
  reduceMotion: false,
  hiddenHubs: [],
  hubOrder: [],
  quality: 'original',
  directPlay: true,
  autoNext: true,
  autoSkipIntro: false,
  autoSkipCredits: false,
  seekStep: 10,
  hdrServerOnSdr: false,
  nativePlayer: true,
  passthrough: false,
};

const KEY = 'mp.settings';

export function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function save(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible (navigation privée, quota) : on continue sans */
  }
}

function initial(): Settings {
  const stored = load<Partial<Settings>>(KEY);
  // Réglages d'avant la disposition « barre flottante » : on adopte le nouveau style une fois.
  if (stored && stored.layout === undefined) Object.assign(stored, { theme: DEFAULTS.theme, radius: DEFAULTS.radius, accent: '', customVars: {} });
  return { ...DEFAULTS, ...stored };
}

export const settings = signal<Settings>(initial());

export function update(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
}

/** Ne garde que les clés connues, avec le bon type : un fichier importé n'est pas fiable. */
export function sanitize(input: unknown): Partial<Settings> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = (input as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (Array.isArray(def)) {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v;
    } else if (typeof def === 'object') {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = Object.fromEntries(
          Object.entries(v as Record<string, unknown>).filter(([name, val]) => name.startsWith('--') && typeof val === 'string'),
        );
      }
    } else if (typeof v === typeof def) out[k] = v;
  }
  return out as Partial<Settings>;
}

const isTv = () => innerHeight <= 620 && innerWidth >= 900;
const viewport = signal({ tv: typeof window !== 'undefined' && isTv() });

/** Largeur d'affiche effective, réduite sur téléviseur. */
export function cardWidth(): number {
  return Math.round(settings.value.cardSize * (viewport.value.tv ? 0.72 : 1));
}

/** Applique thème, variables et CSS personnalisé au document, et persiste. */
export function initSettings(): void {
  const style = document.createElement('style');
  style.id = 'custom-css';
  document.head.appendChild(style);
  let applied: string[] = [];
  addEventListener('resize', () => {
    if (viewport.value.tv !== isTv()) viewport.value = { tv: isTv() };
  });
  effect(() => {
    const s = settings.value;
    save(KEY, s);
    const root = document.documentElement;
    const vars: Record<string, string> = {
      ...(THEMES[s.theme] ?? THEMES.cinema).vars,
      ...s.customVars,
      '--card-w': `${cardWidth()}px`,
      '--radius': `${s.radius}px`,
    };
    if (s.accent) vars['--accent'] = s.accent;
    for (const k of applied) if (!(k in vars)) root.style.removeProperty(k);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    applied = Object.keys(vars);
    // Les téléviseurs exposent souvent un écran logique de 960×540 : on réduit l'échelle pour que tout tienne.
    root.style.fontSize = `${s.uiScale * (viewport.value.tv ? 0.72 : 1)}%`;
    root.classList.toggle('tv', viewport.value.tv);
    // Illustration du thème : uniquement une image embarquée, jamais une adresse à charger
  // (des réglages importés pourraient en contenir une).
    const art = isThemeImage(s.themeImage) ? s.themeImage : '';
    if (art) root.style.setProperty('--theme-art', `url("${art}")`);
    else root.style.removeProperty('--theme-art');
    root.classList.toggle('has-art', !!art);
    // Mise en scène : une classe par effet connu, et la devise passée au CSS comme texte.
    for (const fx of THEME_EFFECTS) root.classList.toggle(`fx-${fx}`, !!art && s.themeEffect === fx);
    if (art && s.themeMotto) root.style.setProperty('--theme-motto', JSON.stringify(s.themeMotto.slice(0, 60)));
    else root.style.removeProperty('--theme-motto');
    root.lang = s.lang;
    // Les champs de formulaire et les barres de défilement suivent la clarté du thème.
    root.style.colorScheme = (luminance(vars['--bg']) ?? 0) > 0.5 ? 'light' : 'dark';
    root.classList.toggle('reduce-motion', s.reduceMotion);
    root.classList.toggle('no-titles', !s.showTitles);
    style.textContent = s.customCss;
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', vars['--bg']);
  });
}
