import { describe, expect, it } from 'vitest';
import { shuffleSeasons, shuffled } from '../src';

/** Générateur déterministe (LCG) pour des tirages reproductibles. */
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

describe('lecture aléatoire', () => {
  it('garde chaque épisode une fois, sans modifier la liste d’origine', () => {
    const list = Array.from({ length: 50 }, (_, i) => i);
    const out = shuffled(list, seeded(7));
    expect(list).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect([...out].sort((a, b) => a - b)).toEqual(list);
    expect(out).not.toEqual(list);
  });

  it('tire chaque ordre de façon équitable', () => {
    const counts = new Map<string, number>();
    const rnd = seeded(42);
    for (let n = 0; n < 60000; n++) {
      const k = shuffled(['a', 'b', 'c'], rnd).join('');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    for (const c of counts.values()) expect(Math.abs(c - 10000)).toBeLessThan(600);
  });

  it('supporte un générateur qui rend sa borne haute', () => {
    expect(shuffled([1, 2, 3], () => 0.9999999999999999).sort()).toEqual([1, 2, 3]);
    expect(shuffled([], Math.random)).toEqual([]);
  });

  it('série : sans les épisodes spéciaux, sauf s’il n’y a que ça', () => {
    expect(shuffleSeasons([{ index: 0 }, { index: 1 }, { index: 2 }])).toEqual([{ index: 1 }, { index: 2 }]);
    expect(shuffleSeasons([{ index: 0 }])).toEqual([{ index: 0 }]);
  });
});
