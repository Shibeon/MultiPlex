import { describe, expect, it } from 'vitest';
import { WHEEL_LINE_PX, WHEEL_PAGE_SHARE, rowWheel, wheelPixels } from '../src';

const px = (deltaY: number, deltaX = 0) => ({ deltaX, deltaY, deltaMode: 0 });
// Rangée de 1000 px visibles sur 3000 : 2000 px de défilement possible.
const row = (scrollLeft: number, scrollWidth = 3000, clientWidth = 1000) => ({ scrollLeft, scrollWidth, clientWidth });

describe('molette au-dessus d’une rangée', () => {
  it('la molette vers le bas fait défiler vers la droite, vers le haut vers la gauche', () => {
    expect(rowWheel(px(100), row(500))).toEqual({ dx: 100, smooth: true });
    expect(rowWheel(px(-100), row(500))).toEqual({ dx: -100, smooth: true });
  });
  it('s’arrête au bout, puis laisse la page défiler', () => {
    expect(rowWheel(px(100), row(1950))?.dx).toBe(50);
    expect(rowWheel(px(100), row(2000))).toBeNull();
    expect(rowWheel(px(100), row(1999.5))).toBeNull();
    expect(rowWheel(px(-100), row(30))?.dx).toBe(-30);
    expect(rowWheel(px(-100), row(0))).toBeNull();
    // Au début, vers le bas : la rangée défile bien (seul le sens bloqué laisse passer).
    expect(rowWheel(px(100), row(0))?.dx).toBe(100);
    expect(rowWheel(px(-100), row(2000))?.dx).toBe(-100);
  });
  it('laisse passer un geste surtout horizontal (pavé tactile, molette inclinable)', () => {
    expect(rowWheel(px(10, 40), row(500))).toBeNull();
    expect(rowWheel(px(-30, -30), row(500))).toBeNull();
    expect(rowWheel(px(0, 80), row(500))).toBeNull();
  });
  it('un geste surtout vertical d’un pavé tactile reste suivi directement, sans animation', () => {
    expect(rowWheel(px(12, 3), row(500))).toEqual({ dx: 12, smooth: false });
  });
  it('ne touche pas au zoom (Ctrl + molette, pincement)', () => {
    expect(rowWheel({ ...px(100), ctrlKey: true }, row(500))).toBeNull();
  });
  it('laisse passer quand la rangée ne déborde pas', () => {
    expect(rowWheel(px(100), row(0, 1000, 1000))).toBeNull();
    expect(rowWheel(px(100), row(0, 1001, 1000))).toBeNull();
  });
  it('rien à faire sans mouvement vertical', () => {
    expect(rowWheel(px(0), row(500))).toBeNull();
  });
  it('convertit lignes et pages en pixels', () => {
    expect(wheelPixels(3, 1, 1000)).toBe(3 * WHEEL_LINE_PX);
    expect(wheelPixels(1, 2, 1000)).toBe(1000 * WHEEL_PAGE_SHARE);
    expect(wheelPixels(-57, 0, 1000)).toBe(-57);
    expect(rowWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 }, row(0))).toEqual({ dx: 3 * WHEEL_LINE_PX, smooth: true });
    expect(rowWheel({ deltaX: 0, deltaY: -1, deltaMode: 2 }, row(1500))).toEqual({ dx: -1000 * WHEEL_PAGE_SHARE, smooth: true });
    // Une page entière au-delà du bout : bornée.
    expect(rowWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 }, row(1800))?.dx).toBe(200);
  });
});
