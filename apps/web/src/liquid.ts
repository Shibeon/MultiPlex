/**
 * « Verre liquide », à la manière d'iOS : les contrôles de verre réagissent au doigt et à la souris.
 *
 * - la lumière suit le pointeur (reflet sur le verre et liseré plus vif du côté du pointeur) ;
 * - à l'appui, le contrôle gonfle, s'éclaire depuis le point de contact et s'étire vers le doigt
 *   quand celui-ci glisse ; au relâcher, il revient en place avec un petit rebond (ressort).
 *
 * Le CSS (bloc « Verre liquide » de styles.css) dessine le reflet et le liseré à partir des
 * variables posées ici : --lg-x / --lg-y (position du pointeur), --lg-a (angle de la lumière),
 * --lg-p (intensité de l'appui, de 0 à 1).
 */

/** Contrôles concernés : ce qui est « en verre » et se touche. */
export const GLASS = '.btn, .nav-link, .social, .profile';

type Spring = { v: number; x: number };
type Live = {
  el: HTMLElement;
  /** Gonflement, étirement horizontal / vertical, déplacement, intensité de lumière. */
  s: Spring; sx: Spring; sy: Spring; tx: Spring; ty: Spring; p: Spring;
  target: { s: number; sx: number; sy: number; tx: number; ty: number; p: number };
  w: number; h: number;
};

const live = new Map<HTMLElement, Live>();
let frame = 0;
let last = 0;

const reduced = () =>
  document.documentElement.classList.contains('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

function state(el: HTMLElement): Live {
  let st = live.get(el);
  if (!st) {
    const r = el.getBoundingClientRect();
    const sp = (x: number): Spring => ({ v: 0, x });
    st = { el, s: sp(1), sx: sp(1), sy: sp(1), tx: sp(0), ty: sp(0), p: sp(0), target: { s: 1, sx: 1, sy: 1, tx: 0, ty: 0, p: 0 }, w: r.width, h: r.height };
    live.set(el, st);
  }
  return st;
}

/** Ressort amorti : raide à l'appui, plus souple au relâcher (d'où le rebond). */
function step(sp: Spring, to: number, dt: number, stiff: number, damp: number, eps = 0.001): boolean {
  const a = stiff * (to - sp.x) - damp * sp.v;
  sp.v += a * dt;
  sp.x += sp.v * dt;
  return Math.abs(to - sp.x) > eps || Math.abs(sp.v) > eps * 10;
}

function tick(now: number): void {
  const dt = Math.min(0.032, (now - last) / 1000 || 0.016);
  last = now;
  for (const st of live.values()) {
    const pressed = st.target.p > 0;
    const [k, c] = pressed ? [520, 26] : [260, 11];
    const t = st.target;
    let moving = false;
    moving = step(st.s, t.s, dt, k, c) || moving;
    moving = step(st.sx, t.sx, dt, k, c) || moving;
    moving = step(st.sy, t.sy, dt, k, c) || moving;
    moving = step(st.tx, t.tx, dt, k, c, 0.05) || moving;
    moving = step(st.ty, t.ty, dt, k, c, 0.05) || moving;
    moving = step(st.p, t.p, dt, pressed ? 400 : 120, pressed ? 30 : 22, 0.01) || moving;
    const el = st.el;
    if (!moving && !pressed) {
      el.style.removeProperty('scale');
      el.style.removeProperty('translate');
      el.style.removeProperty('--lg-p');
      live.delete(el);
      continue;
    }
    el.style.scale = `${(st.s.x * st.sx.x).toFixed(4)} ${(st.s.x * st.sy.x).toFixed(4)}`;
    el.style.translate = `${st.tx.x.toFixed(2)}px ${st.ty.x.toFixed(2)}px`;
    el.style.setProperty('--lg-p', clamp(st.p.x, 0, 1).toFixed(3));
  }
  frame = live.size ? requestAnimationFrame(tick) : 0;
}

function run(): void {
  if (!frame) {
    last = performance.now();
    frame = requestAnimationFrame(tick);
  }
}

/** Lumière : position du pointeur dans le contrôle, et angle du liseré qui s'oriente vers lui. */
function light(el: HTMLElement, x: number, y: number): void {
  const r = el.getBoundingClientRect();
  const lx = x - r.left;
  const ly = y - r.top;
  el.style.setProperty('--lg-x', `${lx.toFixed(1)}px`);
  el.style.setProperty('--lg-y', `${ly.toFixed(1)}px`);
  const a = (Math.atan2(ly - r.height / 2, lx - r.width / 2) * 180) / Math.PI + 90;
  el.style.setProperty('--lg-a', `${a.toFixed(1)}deg`);
}

let pressed: { el: HTMLElement; id: number; x0: number; y0: number } | null = null;

function press(el: HTMLElement, e: PointerEvent): void {
  const st = state(el);
  const r = el.getBoundingClientRect();
  st.w = r.width;
  st.h = r.height;
  // Les petits contrôles gonflent davantage (comme sur iOS), les grands à peine.
  const grow = reduced() ? 0 : clamp(14 / Math.min(r.width, r.height * 2.2), 0.04, 0.2);
  st.target = { s: 1 + grow, sx: 1, sy: 1, tx: 0, ty: 0, p: 1 };
  pressed = { el, id: e.pointerId, x0: e.clientX, y0: e.clientY };
  run();
}

/** Doigt qui glisse sans lâcher : le verre le suit un peu et s'étire dans sa direction. */
function drag(e: PointerEvent): void {
  if (!pressed || e.pointerId !== pressed.id) return;
  const st = live.get(pressed.el);
  if (!st || reduced()) return;
  const dx = e.clientX - pressed.x0;
  const dy = e.clientY - pressed.y0;
  const ease = (d: number, size: number) => Math.sign(d) * Math.min(size * 0.12 + 6, Math.abs(d) * 0.35);
  st.target.tx = ease(dx, st.w);
  st.target.ty = ease(dy, st.h);
  const stretchX = clamp(Math.abs(dx) / (st.w * 4), 0, 0.12);
  const stretchY = clamp(Math.abs(dy) / (st.h * 4), 0, 0.12);
  st.target.sx = 1 + stretchX - stretchY * 0.5;
  st.target.sy = 1 + stretchY - stretchX * 0.5;
  run();
}

function release(): void {
  if (!pressed) return;
  const st = live.get(pressed.el);
  if (st) st.target = { s: 1, sx: 1, sy: 1, tx: 0, ty: 0, p: 0 };
  pressed = null;
  run();
}

export function initLiquidGlass(): void {
  addEventListener(
    'pointermove',
    (e) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>(GLASS);
      if (el) light(el, e.clientX, e.clientY);
      if (pressed && pressed.el !== el) light(pressed.el, e.clientX, e.clientY);
      drag(e);
    },
    { passive: true },
  );
  addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0) return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>(GLASS);
      if (!el || (el as HTMLButtonElement).disabled) return;
      light(el, e.clientX, e.clientY);
      press(el, e);
    },
    { passive: true },
  );
  addEventListener('pointerup', release, { passive: true });
  addEventListener('pointercancel', release, { passive: true });
  addEventListener('blur', release);
}
