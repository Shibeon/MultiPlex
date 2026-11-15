import { describe, expect, it } from 'vitest';
import { DRAG_THRESHOLD_PX, dragEnd, dragMove, dragStart, glideStep, pastThreshold } from '../src';

describe('glisser une rangée à la souris', () => {
  it('sous le seuil, rien ne bouge et le clic passe', () => {
    const tr = dragStart(100, 100, 0, 400);
    expect(dragMove(tr, 103, 102, 10)).toBeNull();
    expect(dragMove(tr, 95, 97, 20)).toBeNull();
    expect(tr.dragging).toBe(false);
    expect(dragEnd(tr, 30)).toEqual({ click: true, velocity: 0 });
  });

  it('au seuil (6 px, toutes directions), c’est un glisser : la rangée suit et le clic est annulé', () => {
    expect(DRAG_THRESHOLD_PX).toBe(6);
    expect(pastThreshold(5.9, 0)).toBe(false);
    expect(pastThreshold(6, 0)).toBe(true);
    expect(pastThreshold(4, 5)).toBe(true);
    const tr = dragStart(100, 100, 0, 400);
    // Tirer vers la gauche fait avancer la rangée vers la droite.
    expect(dragMove(tr, 94, 100, 10)).toBe(406);
    expect(tr.dragging).toBe(true);
    // Une fois parti, même un retour près du point d’appui reste un glisser.
    expect(dragMove(tr, 99, 100, 20)).toBe(401);
    expect(dragMove(tr, 160, 130, 30)).toBe(340);
    expect(dragEnd(tr, 400).click).toBe(false);
  });

  it('un geste surtout vertical franchit aussi le seuil : pas de clic, la rangée ne suit que l’horizontale', () => {
    const tr = dragStart(0, 0, 0, 50);
    expect(dragMove(tr, 1, 8, 10)).toBe(49);
    expect(dragEnd(tr, 20).click).toBe(false);
  });

  it('vitesse au relâchement : derniers mouvements seulement, nulle si le pointeur s’est arrêté', () => {
    const tr = dragStart(500, 0, 0, 0);
    dragMove(tr, 480, 0, 16);
    dragMove(tr, 440, 0, 32);
    dragMove(tr, 400, 0, 48);
    // 100 px vers la gauche en 48 ms (fenêtre de 100 ms) : la rangée file vers la droite.
    expect(dragEnd(tr, 50).velocity).toBeCloseTo(100 / 48, 5);
    // Les mouvements plus anciens que la fenêtre ne comptent plus.
    const late = dragStart(0, 0, 0, 0);
    dragMove(late, -10, 0, 10);
    dragMove(late, -20, 0, 300);
    dragMove(late, -60, 0, 320);
    expect(dragEnd(late, 330).velocity).toBeCloseTo(40 / 20, 5);
    // Relâché après une pause : pas d’élan.
    expect(dragEnd(tr, 200).velocity).toBe(0);
  });

  it('l’élan s’amortit puis s’arrête', () => {
    let v = 2;
    let total = 0;
    let frames = 0;
    for (let step = glideStep(v, 16); step; step = glideStep(v, 16)) {
      total += step.dx;
      v = step.velocity;
      frames++;
      expect(frames).toBeLessThan(500);
    }
    expect(frames).toBeGreaterThan(10);
    expect(total).toBeGreaterThan(100);
    expect(glideStep(0.01, 16)).toBeNull();
    expect(glideStep(-3, 16)!.dx).toBeLessThan(0);
  });
});
