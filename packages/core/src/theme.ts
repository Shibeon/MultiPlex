/**
 * Format des thèmes partagés. Un thème n'est qu'un jeu de couleurs : il ne peut
 * contenir ni CSS libre ni adresse, pour qu'un thème venu d'ailleurs (galerie en
 * ligne, fichier reçu d'un ami) ne puisse rien charger ni rien exécuter.
 */
export interface ThemeFile {
  /** Identifiant stable : minuscules, chiffres et tirets. */
  id: string;
  name: string;
  author?: string;
  description?: string;
  mode: 'dark' | 'light';
  vars: Record<string, string>;
  /** Arrondi des affiches, en pixels. */
  radius?: number;
  /**
   * Illustration du thème (portrait, emblème), embarquée dans le fichier sous forme
   * de données. Une adresse en ligne est toujours refusée : afficher le thème ne doit
   * déclencher aucun chargement.
   */
  image?: string;
  /** Auteur et licence de l'illustration. */
  imageCredit?: string;
  /**
   * Mise en scène de l'illustration, à choisir parmi celles que l'application sait
   * jouer. Un thème ne peut pas apporter son propre CSS : il désigne un effet existant.
   */
  effect?: ThemeEffect;
  /** Courte devise affichée par la mise en scène (plaque, tampon, légende). */
  motto?: string;
}

/** 'aura' : ciel étoilé, rayons et halo ; 'cadre' : portrait encadré accroché au mur, tampon. */
export const THEME_EFFECTS = ['aura', 'cadre'] as const;
export type ThemeEffect = (typeof THEME_EFFECTS)[number];

/** Taille maximale d'une illustration embarquée (caractères de l'adresse de données). */
export const THEME_IMAGE_MAX = 300_000;
const IMAGE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Vrai si la chaîne est une image embarquée acceptable (et non une adresse à charger). */
export function isThemeImage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= THEME_IMAGE_MAX && IMAGE.test(value);
}

/** Couleurs qu'un thème doit définir. */
export const THEME_REQUIRED = ['--bg', '--surface', '--surface-2', '--text', '--muted', '--accent'];
const OPTIONAL = ['--on-accent', '--backdrop-opacity'];

const COLOR = /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]{1,40}\))$/;
const NUMBER = /^(?:0|1|0?\.[0-9]{1,3})$/;

const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** Luminance relative (0 = noir, 1 = blanc) d'une couleur hexadécimale ; null si autre notation. */
export function luminance(color: string): number | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (!m || m[1].length === 5 || m[1].length === 7) return null;
  // Notations courtes (#rgb, #rgba) et longues (#rrggbb, #rrggbbaa) ; la transparence est ignorée.
  const hex = m[1].length <= 4 ? [...m[1].slice(0, 3)].map((c) => c + c).join('') : m[1].slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Valide un thème d'origine inconnue. Renvoie null s'il est inutilisable. */
export function parseTheme(input: unknown): ThemeFile | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const id = typeof o.id === 'string' && /^[a-z0-9][a-z0-9-]{1,39}$/.test(o.id) ? o.id : null;
  const name = text(o.name, 40);
  if (!id || !name || !o.vars || typeof o.vars !== 'object') return null;

  const vars: Record<string, string> = {};
  for (const key of [...THEME_REQUIRED, ...OPTIONAL]) {
    const v = (o.vars as Record<string, unknown>)[key];
    if (typeof v !== 'string') continue;
    const value = v.trim();
    if (key === '--backdrop-opacity' ? NUMBER.test(value) : COLOR.test(value)) vars[key] = value;
  }
  if (THEME_REQUIRED.some((k) => !vars[k])) return null;

  // Texte posé sur la couleur d'accent : noir ou blanc selon ce qui se lit le mieux.
  if (!vars['--on-accent']) vars['--on-accent'] = (luminance(vars['--accent']) ?? 0.5) > 0.4 ? '#000000' : '#ffffff';
  const bg = luminance(vars['--bg']);
  const mode = o.mode === 'light' || o.mode === 'dark' ? o.mode : bg !== null && bg > 0.5 ? 'light' : 'dark';
  const radius = typeof o.radius === 'number' && o.radius >= 0 && o.radius <= 24 ? Math.round(o.radius) : undefined;
  const image = isThemeImage(o.image) ? o.image : undefined;
  const effect = image && THEME_EFFECTS.includes(o.effect as ThemeEffect) ? (o.effect as ThemeEffect) : undefined;
  return { id, name, author: text(o.author, 40), description: text(o.description, 140), mode, vars, radius, image, imageCredit: image ? text(o.imageCredit, 200) : undefined, effect, motto: image ? text(o.motto, 60) : undefined };
}

/** Valide une galerie (tableau de thèmes, ou objet `{ themes: [...] }`), sans doublon d'identifiant. */
export function parseGallery(input: unknown, max = 300): ThemeFile[] {
  const list = Array.isArray(input) ? input : input && typeof input === 'object' ? (input as { themes?: unknown }).themes : null;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: ThemeFile[] = [];
  for (const raw of list.slice(0, max)) {
    const theme = parseTheme(raw);
    if (theme && !seen.has(theme.id)) {
      seen.add(theme.id);
      out.push(theme);
    }
  }
  return out;
}
