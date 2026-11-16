// Lecture aléatoire d'une série ou d'une saison : l'ordre est tiré une fois, au lancement.

/** Nombre maximal d'épisodes mis en file par une lecture aléatoire (une très longue série reste jouable). */
export const MAX_SHUFFLE = 500;

/**
 * Copie de `list` dans un ordre aléatoire uniforme (Fisher-Yates), sans toucher à `list`.
 * `random` rend un nombre dans [0, 1[ (Math.random par défaut, injectable pour les tests).
 */
export function shuffled<T>(list: readonly T[], random: () => number = Math.random): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Saisons qu'une lecture aléatoire de toute la série parcourt : les saisons numérotées, sans les
 * épisodes spéciaux (saison 0), sauf si la série n'a que ceux-là.
 */
export function shuffleSeasons<S extends { index?: number }>(seasons: readonly S[]): S[] {
  const numbered = seasons.filter((s) => (s.index ?? 0) > 0);
  return numbered.length ? numbered : seasons.slice();
}
