import { AUDIO_MODES, THEME_EFFECTS, isThemeImage, luminance, type AudioMode } from '@multiplex/core';
import { computed, effect, signal } from '@preact/signals';
import { isOverlayWindow } from './native';

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
  /** Application de bureau : signaler les nouvelles versions. */
  autoUpdate: boolean;
  /** Lecteur natif : transmettre l'audio brut (Dolby, DTS, Atmos) à un ampli. */
  passthrough: boolean;
  /** Lecteur natif : sortie audio choisie (vide = celle du système). */
  audioDevice: string;
  /**
   * Tous les lecteurs : mode audio. « night » compresse la dynamique (scènes fortes moins fortes,
   * dialogues faibles plus audibles) ; « voice » relève le canal central (ou, en stéréo, compresse
   * doucement et met la voix en avant). Sans effet quand le son part brut vers un ampli.
   */
  audioMode: AudioMode;
  /** Lecteur natif, Windows : accorder la fréquence de l'écran à la cadence de la vidéo. */
  matchRefresh: boolean;
  /** Application de bureau : compléter les repères d'intro avec IntroDB quand Plex n'en fournit pas. */
  communityMarkers: boolean;
  /** Plex Home : demander « Qui regarde ? » à chaque lancement. */
  askProfile: boolean;
  /** Lecteur natif : aperçu en image au survol de la barre de lecture. */
  seekPreview: boolean;
  /** Lecteur natif : à la pause, reconnaître les acteurs présents à l'image (calcul local). */
  xray: boolean;
  /** Garder les recherches récentes sur cet appareil. */
  searchHistory: boolean;
  /** Adresse du relais « Regarder ensemble » (hébergé soi-même, par exemple sur un NAS). */
  togetherRelay: string;
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
  autoUpdate: true,
  passthrough: false,
  audioDevice: '',
  audioMode: 'off',
  matchRefresh: false,
  communityMarkers: true,
  askProfile: false,
  seekPreview: true,
  xray: true,
  searchHistory: true,
  togetherRelay: '',
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
    } else if (k === 'audioMode') {
      if (AUDIO_MODES.includes(v as AudioMode)) out[k] = v;
    } else if (typeof v === typeof def) out[k] = v;
  }
  return out as Partial<Settings>;
}

/** Agrandissement de l'interface : ce qui se lit à 60 cm doit se lire à 3 m. */
const COUCH_SCALE = 1.4;

/**
 * Téléphone : écran tactile dont le petit côté est court. En paysage, un grand téléphone
 * dépasse 900 px de large : sans ce garde-fou, il passerait en affichage TV (tout minuscule).
 */
const isPhone = () =>
  typeof matchMedia === 'function' && navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height, innerWidth, innerHeight) < 600;
const isTv = () => innerHeight <= 620 && innerWidth >= 900 && !isPhone();
/** Petits écrans (téléphones) : l'interface garde sa taille normale. */
const isWide = () => innerWidth >= 900 && !isPhone();
const viewport = signal({ tv: typeof window !== 'undefined' && isTv(), wide: typeof window === 'undefined' || isWide() });

/**
 * Affichage « TV » : interface agrandie, focus marqué, souris qui s'efface. C'est l'affichage
 * de toujours sur ordinateur et téléviseur ; sur téléphone, l'interface reste à taille normale.
 * Le plein écran, lui, ne se demande que dans le lecteur.
 */
export const couchOn = computed(() => viewport.value.wide);

/** Le système dessine-t-il des barres de défilement qui prennent de la place (Windows, Linux),
 *  plutôt que des barres superposées qui n'apparaissent qu'en défilant (macOS, Android) ? */
let solid: boolean | undefined;
function solidScrollbars(): boolean {
  if (solid === undefined) {
    if (!document.body) return false;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;top:-999px;width:100px;height:100px;overflow:scroll;scrollbar-width:thin';
    document.body.appendChild(probe);
    solid = probe.offsetHeight - probe.clientHeight > 0;
    probe.remove();
  }
  return solid;
}

/** Largeur d'affiche effective, réduite sur téléviseur. */
export function cardWidth(): number {
  return Math.round(settings.value.cardSize * (viewport.value.tv ? 0.72 : 1) * (couchOn.value ? COUCH_SCALE : 1));
}

/** Applique thème, variables et CSS personnalisé au document, et persiste. */
export function initSettings(): void {
  const style = document.createElement('style');
  style.id = 'custom-css';
  document.head.appendChild(style);
  let applied: string[] = [];
  addEventListener('resize', () => {
    if (viewport.value.tv !== isTv() || viewport.value.wide !== isWide()) viewport.value = { tv: isTv(), wide: isWide() };
  });
  // Affichage TV : la souris s'efface quand on ne s'en sert pas.
  let idle = 0;
  addEventListener('mousemove', () => {
    document.documentElement.classList.remove('idle');
    clearTimeout(idle);
    idle = window.setTimeout(() => document.documentElement.classList.add('idle'), 3000);
  });
  // Un réglage changé dans une autre fenêtre (lecteur ↔ fenêtre principale) s'applique ici aussitôt.
  let lastSaved = '';
  addEventListener('storage', (e) => {
    if (e.key !== KEY || !e.newValue || e.newValue === lastSaved) return;
    try {
      lastSaved = e.newValue;
      const next = { ...settings.value, ...(JSON.parse(e.newValue) as Partial<Settings>) };
      settings.value = next;
    } catch {
      /* valeur illisible : on garde la nôtre */
    }
  });
  effect(() => {
    const s = settings.value;
    const json = JSON.stringify(s);
    // Pas de réécriture d'une valeur déjà enregistrée : sinon deux fenêtres se la renverraient sans fin.
    if (json !== lastSaved) {
      lastSaved = json;
      save(KEY, s);
    }
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
    // Commandes du lecteur natif en mode TV : elles occupent tout l'écran, leur taille suit donc
    // celle de la fenêtre (référence : 1920×1080), quelle que soit la mise à l'échelle de Windows.
    // Sans cela, un téléviseur réglé à 200 % (960×540 logiques) les affiche deux fois trop grandes.
    root.style.fontSize =
      isOverlayWindow && couchOn.value
        ? `calc(${(s.uiScale / 100) * COUCH_SCALE} * min(${(100 / 1920) * 16}vw, ${(100 / 1080) * 16}vh))`
        : `${s.uiScale * (viewport.value.tv ? 0.72 : 1) * (couchOn.value ? COUCH_SCALE : 1)}%`;
    root.classList.toggle('tv', viewport.value.tv);
    root.classList.toggle('couch', couchOn.value);
    root.classList.toggle('solid-scrollbars', solidScrollbars());
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
