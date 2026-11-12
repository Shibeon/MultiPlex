import type { Metadata } from './types';

/** Une note à afficher sur une fiche. */
export interface RatingBadge {
  /** D'où vient la note. */
  source: 'imdb' | 'rt-critic' | 'rt-audience' | 'tmdb' | 'other';
  /** Telle qu'on la lit : « 8.6 » pour IMDb, « 95% » pour les autres. */
  text: string;
  /** Rotten Tomatoes : tomate fraîche / pop-corn debout (true), ou l'inverse (false). */
  fresh?: boolean;
}

function badge(image: string | undefined, value: number | undefined, type: string | undefined): RatingBadge | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const img = image ?? '';
  const pct = `${Math.round(value * 10)}%`;
  if (img.startsWith('imdb://')) return { source: 'imdb', text: value.toFixed(1) };
  if (img.startsWith('themoviedb://')) return { source: 'tmdb', text: pct };
  if (img.startsWith('rottentomatoes://')) {
    const audience = type === 'audience' || /upright|spilled/.test(img);
    return { source: audience ? 'rt-audience' : 'rt-critic', text: pct, fresh: !/rating\.(rotten|spilled)/.test(img) };
  }
  return { source: 'other', text: value.toFixed(1) };
}

const ORDER: RatingBadge['source'][] = ['imdb', 'rt-critic', 'rt-audience', 'tmdb', 'other'];

/** Les notes d'un titre, dans l'ordre de l'application Plex : IMDb, critiques, public, TMDB. */
export function ratingBadges(item: Pick<Metadata, 'Rating' | 'rating' | 'ratingImage' | 'audienceRating' | 'audienceRatingImage'>): RatingBadge[] {
  const raw = item.Rating?.length
    ? item.Rating.map((r) => badge(r.image, r.value, r.type))
    : // Anciennes bibliothèques : seulement les deux notes principales.
      [badge(item.ratingImage, item.rating, 'critic'), badge(item.audienceRatingImage, item.audienceRating, 'audience')];
  const seen = new Set<string>();
  return raw
    .filter((b): b is RatingBadge => !!b && !seen.has(b.source) && !!seen.add(b.source))
    .sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source));
}
