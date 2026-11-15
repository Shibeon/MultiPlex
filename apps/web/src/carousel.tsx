import { dragEnd, dragMove, dragStart, glideStep, rowEdges, rowPageTarget, type DragTrack } from '@multiplex/core';
import type { ComponentChildren, JSX, RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { t } from './i18n';

/** Animation coupée : réglage de l'app ou préférence du système. */
function reducedMotion(): boolean {
  return document.documentElement.classList.contains('reduce-motion') || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** La rangée a-t-elle de quoi défiler ? */
function overflows(el: HTMLElement): boolean {
  return el.scrollWidth - el.clientWidth > 1;
}

/**
 * Glisser une rangée à la souris : on appuie, on tire, elle suit ; lâchée en mouvement, elle file
 * encore un peu (sauf mouvement réduit). Les règles (seuil de 6 px, clic annulé après un glisser,
 * vitesse, amortissement) sont dans `drag.ts` (@multiplex/core).
 *
 * Seule la souris (et les pointeurs qui se présentent comme elle, télécommande à pointeur) est
 * concernée : au doigt et au stylet, le défilement natif reste ; la molette et le pavé tactile
 * gardent leur comportement natif (la molette fait défiler la page, le geste horizontal la rangée).
 * Rien n'est empêché à l'appui : le focus, le clic, le clic droit et la sélection de texte
 * ailleurs fonctionnent comme avant. Pendant un glisser seulement, la sélection est coupée dans la
 * rangée et le glisser natif des liens et des images est empêché.
 */
export function useRowDrag(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let track: DragTrack | null = null;
    let pointer = -1;
    let glide = 0;
    let suppress = false;

    const stopGlide = () => {
      cancelAnimationFrame(glide);
      glide = 0;
    };
    const finish = () => {
      if (pointer >= 0 && el.hasPointerCapture?.(pointer)) el.releasePointerCapture(pointer);
      pointer = -1;
      track = null;
      el.classList.remove('dragging');
    };

    // Curseur « main » seulement quand la rangée déborde.
    const onEnter = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') el.classList.toggle('can-drag', overflows(el));
    };
    const onDown = (e: PointerEvent) => {
      stopGlide();
      suppress = false;
      if (e.pointerType !== 'mouse' || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      if (!overflows(el)) return;
      // Pas dans un champ de saisie : on y sélectionne du texte.
      if ((e.target as Element).closest?.('input, textarea, select, [contenteditable="true"]')) return;
      track = dragStart(e.clientX, e.clientY, e.timeStamp, el.scrollLeft);
      pointer = e.pointerId;
    };
    const onMove = (e: PointerEvent) => {
      if (!track || e.pointerId !== pointer) return;
      // Bouton relâché hors de la fenêtre : le glisser s'arrête là.
      if (!(e.buttons & 1)) return void finish();
      const was = track.dragging;
      const left = dragMove(track, e.clientX, e.clientY, e.timeStamp);
      if (left === null) return;
      if (!was) {
        // Le seuil est franchi : c'est un glisser. Le pointeur reste à la rangée même hors d'elle.
        el.classList.add('dragging');
        try {
          el.setPointerCapture(pointer);
        } catch {
          /* pointeur déjà relâché */
        }
        const sel = getSelection();
        if (sel && !sel.isCollapsed && sel.anchorNode && el.contains(sel.anchorNode)) sel.removeAllRanges();
      }
      e.preventDefault();
      el.scrollLeft = left;
    };
    const onUp = (e: PointerEvent) => {
      if (!track || e.pointerId !== pointer) return;
      const { click, velocity } = dragEnd(track, e.timeStamp);
      finish();
      if (click) return;
      // Le clic qui suit le relâchement n'ouvre pas la carte ; s'il ne vient pas, on oublie.
      suppress = true;
      setTimeout(() => (suppress = false), 0);
      if (!velocity || reducedMotion()) return;
      let v = velocity;
      let last = performance.now();
      const step = (now: number) => {
        const s = glideStep(v, Math.min(now - last, 64));
        last = now;
        const before = el.scrollLeft;
        if (!s) return void (glide = 0);
        el.scrollLeft = before + s.dx;
        v = s.velocity;
        // Bout atteint : l'élan s'arrête.
        glide = el.scrollLeft === before && Math.abs(s.dx) >= 1 ? 0 : requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId === pointer) finish();
    };
    const onClick = (e: MouseEvent) => {
      if (!suppress) return;
      suppress = false;
      e.preventDefault();
      e.stopPropagation();
    };
    // Glisser natif d'un lien ou d'une image : jamais pendant qu'on tient la rangée à la souris.
    const onDragStart = (e: DragEvent) => {
      if (track) e.preventDefault();
    };
    // Un autre moyen de défilement prend la main : l'élan s'arrête.
    const others = ['wheel', 'touchstart', 'keydown'] as const;

    el.addEventListener('pointerenter', onEnter);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('lostpointercapture', onCancel);
    el.addEventListener('click', onClick, true);
    el.addEventListener('dragstart', onDragStart);
    for (const type of others) el.addEventListener(type, stopGlide, { passive: true });
    return () => {
      stopGlide();
      el.removeEventListener('pointerenter', onEnter);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('lostpointercapture', onCancel);
      el.removeEventListener('click', onClick, true);
      el.removeEventListener('dragstart', onDragStart);
      for (const type of others) el.removeEventListener(type, stopGlide);
    };
  }, []);
}

/**
 * Flèches de la rangée : la classe `can-prev` / `can-next` du conteneur dit de quel côté il reste
 * de quoi défiler (règles dans `rowscroll.ts`, @multiplex/core). Recalculée au défilement, quand
 * la rangée change de taille et quand ses cartes arrivent.
 */
function useRowEdges(ref: RefObject<HTMLElement>, wrap: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = ref.current;
    const box = wrap.current;
    if (!el || !box) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const { prev, next } = rowEdges(el);
      box.classList.toggle('can-prev', prev);
      box.classList.toggle('can-next', next);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    el.addEventListener('scroll', schedule, { passive: true });
    const mo = new MutationObserver(schedule);
    mo.observe(el, { childList: true });
    // Anciens navigateurs de téléviseurs sans ResizeObserver : la taille de la fenêtre suffit.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    ro?.observe(el);
    if (!ro) addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', schedule);
      mo.disconnect();
      ro?.disconnect();
      if (!ro) removeEventListener('resize', schedule);
    };
  }, []);
}

/** Clic sur une flèche : une page de cartes dans sa direction, alignée sur une carte. */
function pageRow(el: HTMLElement, dir: -1 | 1): void {
  const box = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const inset = parseFloat(cs.scrollPaddingLeft) || parseFloat(cs.paddingLeft) || 0;
  const items = [...el.children].map((c) => {
    const r = c.getBoundingClientRect();
    return { left: r.left - box.left - el.clientLeft + el.scrollLeft, width: r.width };
  });
  const left = rowPageTarget({ scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, inset, items }, dir);
  el.scrollTo({ left, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

function RowArrow({ dir, row }: { dir: -1 | 1; row: RefObject<HTMLElement> }) {
  const label = t(dir < 0 ? 'row.prev' : 'row.next');
  return (
    <button
      type="button"
      class={`row-arrow ${dir < 0 ? 'prev' : 'next'}`}
      // Hors du parcours au clavier et à la télécommande (ils font déjà défiler la rangée, voir
      // nav.ts) ; un clic ne prend pas le focus à la carte sélectionnée.
      tabIndex={-1}
      data-nav-skip=""
      aria-label={label}
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => row.current && pageRow(row.current, dir)}
      // Geste horizontal du pavé tactile au-dessus d'une flèche : la rangée défile quand même.
      onWheel={(e) => {
        if (row.current && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          e.preventDefault();
          row.current.scrollLeft += e.deltaX;
        }
      }}
    >
      <svg class="icon" width={22} height={22} viewBox="0 0 24 24" aria-hidden="true">
        <path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d={dir < 0 ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
      </svg>
    </button>
  );
}

type CarouselProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, 'ref' | 'class' | 'className'> & { class?: string; children?: ComponentChildren };

/**
 * Rangée horizontale (carrousel), la même partout : une seule ligne de cartes, jamais de retour
 * à la ligne, défilement au doigt, au pavé tactile, à la souris en la faisant glisser (voir
 * `useRowDrag`), au clavier et à la télécommande (le focus fait défiler, voir nav.ts). La molette
 * fait défiler la page, comme partout. Pas de barre de défilement visible : la carte suivante qui
 * dépasse au bord de l'écran dit qu'il y a une suite et, à la souris, deux flèches discrètes
 * apparaissent au survol du côté où l'on peut aller. Mise en page : `.carousel` et
 * `.carousel-wrap` dans styles.css.
 */
export function Carousel({ class: cls, children, ...rest }: CarouselProps) {
  const ref = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useRowDrag(ref);
  useRowEdges(ref, wrap);
  return (
    <div ref={wrap} class="carousel-wrap">
      <div {...rest} ref={ref} class={cls ? `carousel ${cls}` : 'carousel'}>
        {children}
      </div>
      <RowArrow dir={-1} row={ref} />
      <RowArrow dir={1} row={ref} />
    </div>
  );
}
