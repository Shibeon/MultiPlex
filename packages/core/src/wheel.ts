/**
 * Molette au-dessus d'une rangée horizontale (carrousel) : la molette d'une souris ne fait défiler
 * que verticalement ; au-dessus d'une rangée, on la convertit en défilement horizontal.
 *
 * Règles, dans l'ordre :
 * - Ctrl + molette, c'est le zoom (et le pincement d'un pavé tactile) : on n'y touche pas ;
 * - geste surtout horizontal (pavé tactile, molette inclinable, Maj + molette sous Windows) :
 *   le navigateur sait déjà faire, deltaX passe tel quel ;
 * - rangée qui ne déborde pas : rien à faire défiler, la page défile ;
 * - rangée déjà au bout dans le sens demandé : la page reprend la main et défile verticalement.
 */

/** Ce qu'on lit d'un `WheelEvent`. */
export interface WheelInput {
  deltaX: number;
  deltaY: number;
  /** 0 : pixels, 1 : lignes (Firefox), 2 : pages. */
  deltaMode: number;
  ctrlKey?: boolean;
}

/** Position de la rangée ; `scrollLeft` est la cible d'un défilement en cours, s'il y en a un. */
export interface RowScroll {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/** Hauteur d'une « ligne » de molette en pixels (Firefox envoie 3 lignes par cran : ~120 px, comme Chrome). */
export const WHEEL_LINE_PX = 40;
/** Une « page » de molette : cette part de la largeur visible de la rangée. */
export const WHEEL_PAGE_SHARE = 0.9;
/** À partir de cette amplitude, c'est un cran de molette : défilement animé. En dessous, un pavé tactile : suivi direct. */
export const WHEEL_NOTCH_PX = 50;

export interface RowWheel {
  /** Déplacement horizontal à appliquer, en pixels, déjà borné aux extrémités. */
  dx: number;
  /** Cran de molette (animation fluide) plutôt que flux continu d'un pavé tactile (suivi direct). */
  smooth: boolean;
}

/** Amplitude verticale du geste en pixels, selon son unité. */
export function wheelPixels(delta: number, deltaMode: number, pageWidth: number): number {
  if (deltaMode === 1) return delta * WHEEL_LINE_PX;
  if (deltaMode === 2) return delta * pageWidth * WHEEL_PAGE_SHARE;
  return delta;
}

/**
 * Déplacement horizontal d'une rangée pour un geste de molette, ou `null` si la rangée laisse
 * passer le geste (la page, ou le navigateur, s'en charge alors normalement).
 */
export function rowWheel(e: WheelInput, row: RowScroll): RowWheel | null {
  if (e.ctrlKey) return null;
  const { deltaX, deltaY } = e;
  if (!deltaY || Math.abs(deltaX) >= Math.abs(deltaY)) return null;
  const max = row.scrollWidth - row.clientWidth;
  if (max <= 1) return null;
  const at = Math.min(Math.max(row.scrollLeft, 0), max);
  const want = wheelPixels(deltaY, e.deltaMode, row.clientWidth);
  const dx = want > 0 ? Math.min(want, max - at) : Math.max(want, -at);
  // Bout atteint (à un pixel près : les positions fractionnaires s'arrondissent) : la page défile.
  if (Math.abs(dx) < 1) return null;
  return { dx, smooth: e.deltaMode !== 0 || Math.abs(deltaY) >= WHEEL_NOTCH_PX };
}
