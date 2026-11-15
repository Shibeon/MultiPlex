/**
 * Flèches d'une rangée horizontale (carrousel) : de quel côté reste-t-il de quoi faire défiler,
 * et où aller quand on clique sur une flèche.
 *
 * Règles :
 * - une flèche n'apparaît que si la rangée peut encore défiler dans sa direction (à
 *   `ROW_EDGE_TOLERANCE_PX` près : les positions fractionnaires d'un écran mis à l'échelle ne
 *   laissent pas une flèche pour un demi-pixel) ;
 * - « suivant » amène au bord gauche la première carte qui n'est pas entièrement visible : elle
 *   n'est ni sautée ni montrée deux fois ;
 * - « précédent » fait l'inverse : la première carte entièrement visible passe juste à droite de
 *   la nouvelle vue ;
 * - le bord visible est en retrait de `inset` (la marge de la page où la rangée déborde, la même
 *   que son `scroll-padding-inline`) : une carte alignée l'est sur le texte de la page.
 *
 * Fonctions pures : le composant `Carousel` (apps/web) les branche sur la rangée.
 */

/** Tolérance (px) sous laquelle un reste de défilement ne compte pas. */
export const ROW_EDGE_TOLERANCE_PX = 2;

export interface RowMetrics {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

export interface RowItem {
  /** Bord gauche de la carte, dans le repère du contenu défilant (comme `scrollLeft`). */
  left: number;
  width: number;
}

/** De quel côté la rangée peut-elle encore défiler ? */
export function rowEdges(m: RowMetrics): { prev: boolean; next: boolean } {
  const max = m.scrollWidth - m.clientWidth;
  return { prev: m.scrollLeft > ROW_EDGE_TOLERANCE_PX, next: max - m.scrollLeft > ROW_EDGE_TOLERANCE_PX };
}

/** Position de défilement visée par un clic sur la flèche `dir` (−1 : précédent, 1 : suivant). */
export function rowPageTarget(m: RowMetrics & { inset: number; items: RowItem[] }, dir: -1 | 1): number {
  const max = Math.max(0, m.scrollWidth - m.clientWidth);
  const view = Math.max(1, m.clientWidth - 2 * m.inset);
  const start = m.scrollLeft + m.inset;
  const end = m.scrollLeft + m.clientWidth - m.inset;
  const clamp = (x: number) => Math.min(max, Math.max(0, Math.round(x)));
  const items = [...m.items].sort((a, b) => a.left - b.left);
  let target: number | undefined;
  if (dir > 0) {
    const cut = items.find((it) => it.left + it.width > end + 1);
    if (cut) target = cut.left - m.inset;
  } else {
    const first = items.find((it) => it.left >= start - 1);
    const from = first ? first.left : start;
    const land = items.find((it) => it.left >= from - view - 1 && it.left < from);
    if (land) target = land.left - m.inset;
  }
  // Pas de carte qui convienne (rangée vide, carte plus large que la vue) : une vue entière.
  if (target === undefined || (dir > 0 ? target <= m.scrollLeft + 1 : target >= m.scrollLeft - 1)) target = m.scrollLeft + dir * view;
  return clamp(target);
}
