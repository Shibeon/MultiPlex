import { effect, signal } from '@preact/signals';

export interface Theme {
  name: string;
  vars: Record<string, string>;
}

/** Thèmes intégrés. Un thème n'est qu'un jeu de variables CSS. */
export const THEMES: Record<string, Theme> = {
  midnight: { name: 'Minuit', vars: { '--bg': '#0f1115', '--surface': '#181b22', '--surface-2': '#232733', '--text': '#eceef2', '--muted': '#9aa1ad', '--accent': '#e5a00d', '--on-accent': '#17130a' } },
  amoled: { name: 'AMOLED', vars: { '--bg': '#000000', '--surface': '#0c0c0e', '--surface-2': '#1a1a1e', '--text': '#f2f2f2', '--muted': '#8d8d93', '--accent': '#e5a00d', '--on-accent': '#17130a' } },
  nord: { name: 'Nord', vars: { '--bg': '#2e3440', '--surface': '#3b4252', '--surface-2': '#434c5e', '--text': '#eceff4', '--muted': '#b4bccb', '--accent': '#88c0d0', '--on-accent': '#1d2530' } },
  forest: { name: 'Forêt', vars: { '--bg': '#0e1512', '--surface': '#16211c', '--surface-2': '#203029', '--text': '#e8f0ea', '--muted': '#95a89c', '--accent': '#5fcf8a', '--on-accent': '#08170e' } },
  light: { name: 'Clair', vars: { '--bg': '#f4f5f7', '--surface': '#ffffff', '--surface-2': '#e6e8ec', '--text': '#16181d', '--muted': '#5b6270', '--accent': '#b87400', '--on-accent': '#ffffff' } },
};

export interface Settings {
  lang: 'fr' | 'en';
  theme: string;
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
}

export const DEFAULTS: Settings = {
  lang: typeof navigator !== 'undefined' && navigator.language?.startsWith('fr') ? 'fr' : 'en',
  theme: 'midnight',
  accent: '',
  customVars: {},
  customCss: '',
  cardSize: 160,
  radius: 10,
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

export const settings = signal<Settings>({ ...DEFAULTS, ...load<Partial<Settings>>(KEY) });

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

/** Applique thème, variables et CSS personnalisé au document, et persiste. */
export function initSettings(): void {
  const style = document.createElement('style');
  style.id = 'custom-css';
  document.head.appendChild(style);
  let applied: string[] = [];
  effect(() => {
    const s = settings.value;
    save(KEY, s);
    const root = document.documentElement;
    const vars: Record<string, string> = {
      ...(THEMES[s.theme] ?? THEMES.midnight).vars,
      ...s.customVars,
      '--card-w': `${s.cardSize}px`,
      '--radius': `${s.radius}px`,
    };
    if (s.accent) vars['--accent'] = s.accent;
    for (const k of applied) if (!(k in vars)) root.style.removeProperty(k);
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    applied = Object.keys(vars);
    root.style.fontSize = `${s.uiScale}%`;
    root.lang = s.lang;
    root.classList.toggle('reduce-motion', s.reduceMotion);
    root.classList.toggle('no-titles', !s.showTitles);
    style.textContent = s.customCss;
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', vars['--bg']);
  });
}
