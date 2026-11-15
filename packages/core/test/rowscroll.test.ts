import { describe, expect, it } from 'vitest';
import { ROW_EDGE_TOLERANCE_PX, rowEdges, rowPageTarget, type RowItem } from '../src';

// Rangée type : marge de page de 40 px de chaque côté, cartes de 160 px espacées de 16 px.
const INSET = 40;
const items = (n: number, w = 160, gap = 16): RowItem[] => Array.from({ length: n }, (_, i) => ({ left: INSET + i * (w + gap), width: w }));
const row = (scrollLeft: number, n = 20, clientWidth = 1000) => {
  const its = items(n);
  const last = its[its.length - 1];
  return { scrollLeft, clientWidth, scrollWidth: last.left + last.width + INSET, inset: INSET, items: its };
};

describe('flèches d’une rangée : de quel côté défiler', () => {
  it('au début, seulement « suivant » ; au bout, seulement « précédent » ; au milieu, les deux', () => {
    const r = row(0);
    const max = r.scrollWidth - r.clientWidth;
    expect(rowEdges(r)).toEqual({ prev: false, next: true });
    expect(rowEdges({ ...r, scrollLeft: max })).toEqual({ prev: true, next: false });
    expect(rowEdges({ ...r, scrollLeft: 500 })).toEqual({ prev: true, next: true });
  });

  it('une rangée qui tient à l’écran n’a aucune flèche', () => {
    expect(rowEdges({ scrollLeft: 0, scrollWidth: 800, clientWidth: 800 })).toEqual({ prev: false, next: false });
    expect(rowEdges({ scrollLeft: 0, scrollWidth: 600, clientWidth: 800 })).toEqual({ prev: false, next: false });
  });

  it('un reste de défilement d’un pixel ou deux (écran mis à l’échelle) ne fait pas apparaître de flèche', () => {
    expect(ROW_EDGE_TOLERANCE_PX).toBe(2);
    expect(rowEdges({ scrollLeft: 1.5, scrollWidth: 1001.5, clientWidth: 1000 })).toEqual({ prev: false, next: false });
    expect(rowEdges({ scrollLeft: 3, scrollWidth: 1006, clientWidth: 1000 })).toEqual({ prev: true, next: true });
  });
});

describe('flèches d’une rangée : où aller', () => {
  it('« suivant » amène au bord la première carte coupée, sans en sauter', () => {
    // Vue : de 40 à 960. Cartes à 40, 216, 392, 568, 744 (fin 904), 920 (fin 1080, coupée).
    expect(rowPageTarget(row(0), 1)).toBe(920 - INSET);
    // Une page plus loin, même règle.
    expect(rowPageTarget(row(880), 1)).toBe(1800 - INSET);
  });

  it('« précédent » ramène la première carte entière juste à droite de la vue', () => {
    // Vue à 880 : première carte entière à 920 ; 5 cartes (880 px) tiennent avant elle.
    const t = rowPageTarget(row(880), -1);
    expect(t).toBe(0);
    const t2 = rowPageTarget(row(1760), -1);
    // Première carte entière : 1800. La nouvelle vue commence à une carte et finit avant 1800.
    const r = row(t2);
    expect(t2).toBeLessThan(1760);
    const visible = r.items.filter((it) => it.left >= t2 + INSET - 1 && it.left + it.width <= t2 + r.clientWidth - INSET + 1);
    expect(visible[visible.length - 1].left + 176).toBe(1800);
  });

  it('aller-retour : suivant puis précédent revient au départ', () => {
    const a = rowPageTarget(row(0), 1);
    expect(rowPageTarget(row(a), -1)).toBe(0);
  });

  it('jamais hors des bornes', () => {
    const r = row(0, 7);
    const max = r.scrollWidth - r.clientWidth;
    expect(rowPageTarget({ ...r, scrollLeft: max - 10 }, 1)).toBe(max);
    expect(rowPageTarget(row(30), -1)).toBe(0);
  });

  it('sans carte exploitable (rangée vide, carte plus large que la vue), une vue entière', () => {
    expect(rowPageTarget({ scrollLeft: 100, scrollWidth: 5000, clientWidth: 1000, inset: INSET, items: [] }, 1)).toBe(100 + 920);
    expect(rowPageTarget({ scrollLeft: 2000, scrollWidth: 5000, clientWidth: 1000, inset: INSET, items: [{ left: 0, width: 5000 }] }, -1)).toBe(2000 - 920);
  });
});
