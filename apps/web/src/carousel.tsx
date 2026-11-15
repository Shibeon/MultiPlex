import { rowWheel } from '@multiplex/core';
import type { ComponentChildren, JSX, RefObject } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { tvDevice } from './platform';

/** Animation coupée : réglage de l'app ou préférence du système. */
function reducedMotion(): boolean {
  return document.documentElement.classList.contains('reduce-motion') || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/**
 * Molette au-dessus d'une rangée horizontale : vers le bas, la rangée défile vers la droite ;
 * vers le haut, vers la gauche ; arrivée au bout, la page reprend la main. Les règles (zoom,
 * gestes horizontaux, rangée qui ne déborde pas, lignes et pages) sont dans `rowWheel`.
 *
 * Un cran de molette part en défilement fluide, celui du navigateur, qui se recale sur la
 * nouvelle cible à chaque cran : plusieurs crans rapides s'enchaînent sans à-coup. On garde
 * cette cible pour calculer le cran suivant (et savoir si on est au bout) avant la fin de
 * l'animation. Pavé tactile (petits pas continus), mouvement réduit ou téléviseur : suivi direct.
 */
export function useRowWheel(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let target: number | null = null;
    let timer = 0;
    const settle = () => {
      target = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.defaultPrevented) return;
      const from = target ?? el.scrollLeft;
      const move = rowWheel(e, { scrollLeft: from, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      if (!move) return;
      e.preventDefault();
      const smooth = move.smooth && !tvDevice && !reducedMotion();
      const left = from + move.dx;
      // Suivi direct : la position est déjà la bonne, pas de cible à retenir.
      target = smooth ? left : null;
      el.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
      // Filet de sécurité si `scrollend` n'existe pas (navigateurs de téléviseurs anciens).
      clearTimeout(timer);
      if (smooth) timer = window.setTimeout(settle, 700);
    };
    // Un autre moyen de défilement prend la main (doigt, barre, clavier) : la cible ne vaut plus.
    const others = ['scrollend', 'pointerdown', 'touchstart', 'keydown'] as const;
    el.addEventListener('wheel', onWheel, { passive: false });
    for (const type of others) el.addEventListener(type, settle, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener('wheel', onWheel);
      for (const type of others) el.removeEventListener(type, settle);
    };
  }, []);
}

type CarouselProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, 'ref' | 'class' | 'className'> & { class?: string; children?: ComponentChildren };

/**
 * Rangée horizontale (carrousel), la même partout : une seule ligne de cartes, jamais de retour
 * à la ligne, défilement au doigt, au pavé tactile, à la molette (voir `useRowWheel`), au clavier
 * et à la télécommande (le focus fait défiler, voir nav.ts). Mise en page : `.carousel` dans
 * styles.css (espacements partagés, carte suivante qui dépasse au bord de l'écran, barre fine).
 */
export function Carousel({ class: cls, children, ...rest }: CarouselProps) {
  const ref = useRef<HTMLDivElement>(null);
  useRowWheel(ref);
  return (
    <div {...rest} ref={ref} class={cls ? `carousel ${cls}` : 'carousel'}>
      {children}
    </div>
  );
}
