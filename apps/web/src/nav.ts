import { back } from './router';

/**
 * Navigation spatiale : les flèches (clavier, télécommande TV, manette)
 * déplacent le focus vers l'élément le plus proche dans la direction voulue.
 */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,summary,[tabindex="0"]';
const DIRS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
/** Touche Retour des télécommandes Tizen (10009) et webOS (461). */
const BACK_KEYCODES = [10009, 461];

function visible(el: HTMLElement): DOMRect | null {
  const r = el.getBoundingClientRect();
  return r.width && r.height ? r : null;
}

export function moveFocus(dx: number, dy: number): boolean {
  const cur = document.activeElement as HTMLElement | null;
  const scope = document.querySelector<HTMLElement>('[data-focus-scope]') ?? document.body;
  const all = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const from = cur && cur !== document.body ? visible(cur) : null;
  if (!from) {
    all.find(visible)?.focus();
    return true;
  }
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of all) {
    if (el === cur) continue;
    const r = visible(el);
    if (!r) continue;
    const ex = r.left + r.width / 2;
    const ey = r.top + r.height / 2;
    // Distance le long de l'axe de déplacement, et écart sur l'axe perpendiculaire.
    const along = dx ? (ex - cx) * dx : (ey - cy) * dy;
    if (along < 4) continue;
    const overlap = dx ? r.top < from.bottom && r.bottom > from.top : r.left < from.right && r.right > from.left;
    const across = overlap ? 0 : dx ? Math.abs(ey - cy) : Math.abs(ex - cx);
    const score = along + across * 3;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return false;
  best.focus({ preventScroll: true });
  best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  return true;
}

/** Vrai tant que l'utilisateur pilote au clavier ou à la télécommande (et non au doigt ou à la souris). */
let usingKeys = false;

/**
 * Après un changement de page, l'élément qui avait le focus a disparu : on le
 * redonne à l'action principale, sinon la télécommande ne peut plus rien valider.
 */
export function focusPage(): void {
  // Dans le lecteur, rien ne doit capter le focus : OK = lecture/pause, flèches = avance/retour.
  if (!usingKeys || document.querySelector('[data-focus-scope]')) return;
  const active = document.activeElement;
  if (active && active !== document.body && document.body.contains(active)) return;
  const scope = document.querySelector<HTMLElement>('[data-focus-scope]') ?? document.querySelector<HTMLElement>('.content') ?? document.body;
  const target = scope.querySelector<HTMLElement>('.btn.primary:not([disabled])') ?? [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].find(visible);
  target?.focus({ preventScroll: true });
}

export function initNav(): void {
  addEventListener('keydown', () => (usingKeys = true), true);
  // Boutons « précédent » et « suivant » sur le côté des souris.
  addEventListener('mouseup', (e) => {
    if (e.button === 3) back();
    else if (e.button === 4) history.forward();
    else return;
    e.preventDefault();
  });
  addEventListener('pointerdown', () => (usingKeys = false), true);
  // Les pages chargent leurs données de façon asynchrone : on réessaie brièvement.
  addEventListener('hashchange', () => [80, 400, 1200].forEach((ms) => setTimeout(focusPage, ms)));
  // Tizen ne transmet les touches multimédia qu'aux applications qui les réclament.
  try {
    const tv = (window as unknown as { tizen?: { tvinputdevice?: { registerKeyBatch(keys: string[]): void } } }).tizen?.tvinputdevice;
    tv?.registerKeyBatch(['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind']);
  } catch {
    /* hors Tizen, ou touches non disponibles sur ce modèle */
  }

  addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.target as HTMLElement;
    const tag = el.tagName;
    const typing = tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'color', 'button'].includes((el as HTMLInputElement).type));
    if (BACK_KEYCODES.includes(e.keyCode) || (e.key === 'Backspace' && !typing)) {
      e.preventDefault();
      back();
      return;
    }
    const dir = DIRS[e.key];
    if (!dir) return;
    // On laisse au champ ses propres flèches : curseur du texte, valeur d'un curseur ou d'une liste.
    if (tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (typing && dir[0]) return;
    if (tag === 'INPUT' && (el as HTMLInputElement).type === 'range' && dir[0]) return;
    if (moveFocus(dir[0], dir[1])) e.preventDefault();
  });
}
