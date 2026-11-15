/**
 * Glisser à la souris une rangée horizontale (carrousel) : on appuie, on tire, la rangée suit ;
 * relâchée en mouvement, elle file encore un peu sur son élan (sauf mouvement réduit).
 *
 * Règles :
 * - tant que le pointeur n'a pas bougé de `DRAG_THRESHOLD_PX`, c'est un simple clic : la carte
 *   s'ouvre comme d'habitude ;
 * - au-delà, c'est un glisser : la rangée suit le pointeur et le clic qui suit le relâchement
 *   est annulé (on ne veut pas ouvrir la carte sur laquelle on a lâché) ;
 * - l'élan part de la vitesse des derniers instants du geste et s'amortit à chaque image.
 *
 * Ces fonctions sont pures : le composant `Carousel` (apps/web) les branche sur les événements.
 */

/** Distance (px) en deçà de laquelle un appui reste un clic. */
export const DRAG_THRESHOLD_PX = 6;
/** Fenêtre (ms) des derniers mouvements pris en compte pour la vitesse au relâchement. */
export const DRAG_VELOCITY_WINDOW_MS = 100;
/** Vitesse (px/ms) sous laquelle l'élan s'arrête. */
export const GLIDE_MIN_SPEED = 0.02;
/** Amortissement de l'élan : part de vitesse gardée par tranche de 16 ms. */
export const GLIDE_FRICTION = 0.95;

export interface DragSample {
  x: number;
  t: number;
}

export interface DragTrack {
  /** Position du pointeur à l'appui. */
  x0: number;
  y0: number;
  /** Position de la rangée à l'appui. */
  left0: number;
  /** Le seuil a été franchi : c'est un glisser, plus un clic. */
  dragging: boolean;
  /** Derniers mouvements, pour la vitesse au relâchement. */
  samples: DragSample[];
}

export function dragStart(x: number, y: number, t: number, scrollLeft: number): DragTrack {
  return { x0: x, y0: y, left0: scrollLeft, dragging: false, samples: [{ x, t }] };
}

/** Le pointeur s'est-il assez éloigné de l'appui pour que ce ne soit plus un clic ? */
export function pastThreshold(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(dx, dy) >= threshold;
}

/**
 * Mouvement du pointeur. Rend la nouvelle position de la rangée (`scrollLeft`) une fois le seuil
 * franchi, sinon `null` (rien ne bouge encore : c'est peut-être un clic).
 */
export function dragMove(track: DragTrack, x: number, y: number, t: number): number | null {
  const dx = x - track.x0;
  if (!track.dragging && !pastThreshold(dx, y - track.y0)) return null;
  track.dragging = true;
  track.samples.push({ x, t });
  while (track.samples.length > 2 && t - track.samples[0].t > DRAG_VELOCITY_WINDOW_MS) track.samples.shift();
  // La rangée suit le pointeur : tirer vers la gauche fait avancer vers la droite.
  return track.left0 - dx;
}

/**
 * Relâchement. `click` : le clic qui suit doit-il passer (pas de glisser) ?
 * `velocity` : vitesse de défilement de la rangée au relâchement, en px/ms (signe de `scrollLeft`).
 */
export function dragEnd(track: DragTrack, t: number): { click: boolean; velocity: number } {
  if (!track.dragging) return { click: true, velocity: 0 };
  const recent = track.samples.filter((s) => t - s.t <= DRAG_VELOCITY_WINDOW_MS);
  if (recent.length < 2) return { click: false, velocity: 0 };
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = last.t - first.t;
  // Pointeur immobile avant le relâchement (dernier mouvement trop ancien) : pas d'élan.
  if (dt <= 0 || t - last.t > 50) return { click: false, velocity: 0 };
  return { click: false, velocity: -(last.x - first.x) / dt };
}

/**
 * Une image d'élan : déplacement à appliquer et vitesse restante, ou `null` quand l'élan est épuisé.
 * `dt` en ms depuis l'image précédente.
 */
export function glideStep(velocity: number, dt: number): { dx: number; velocity: number } | null {
  if (Math.abs(velocity) < GLIDE_MIN_SPEED || dt <= 0) return null;
  const next = velocity * Math.pow(GLIDE_FRICTION, dt / 16);
  return { dx: velocity * dt, velocity: next };
}
