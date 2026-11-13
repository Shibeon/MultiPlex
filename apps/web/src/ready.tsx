import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

/** Au-delà, la page s'affiche quand même (serveur lent, image qui ne vient pas). */
const MAX_WAIT_MS = 2500;
const STABLE_MS = 160;

const inView = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  // Une image pas encore chargée peut n'avoir aucune taille : on regarde alors son cadre.
  if (!r.width && !r.height) return !!el.parentElement && el.parentElement !== document.body && inView(el.parentElement);
  return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
};

/**
 * Une page ne s'affiche qu'une fois prête : données reçues (plus de chargement à l'écran) et
 * images visibles téléchargées. On évite ainsi les affiches qui arrivent une à une.
 * `key` du parent : une nouvelle attente à chaque changement de page.
 */
export function ReadyGate({ children }: { children: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const start = performance.now();
    let timer = 0;
    // Prête, et rien de nouveau pendant un court instant : des rangées chargées à part
    // (accueil, fiche) ont le temps d'arriver avant l'affichage.
    let stableSince = 0;
    let lastCount = -1;
    const backgrounds = new Map<string, HTMLImageElement>();
    const check = () => {
      const el = box.current;
      if (!el) return;
      const loading = [...el.querySelectorAll('.spinner, .skeleton')].some(inView);
      const images = [...el.querySelectorAll('img')].filter((img) => img.getAttribute('src') && inView(img));
      // Fonds (fiche, accueil) posés en image d'arrière-plan : chargés à part pour savoir quand ils sont là.
      for (const bg of el.querySelectorAll<HTMLElement>('[style*="background-image"]')) {
        const url = /url\("?([^")]+)"?\)/.exec(bg.style.backgroundImage)?.[1];
        if (!url || !inView(bg)) continue;
        let img = backgrounds.get(url);
        if (!img) {
          img = new Image();
          img.src = url;
          backgrounds.set(url, img);
        }
        images.push(img);
      }
      const done = el.childElementCount > 0 && !loading && images.every((img) => img.complete);
      const now = performance.now();
      if (!done || images.length !== lastCount) stableSince = now;
      lastCount = images.length;
      if ((done && now - stableSince >= STABLE_MS) || now - start > MAX_WAIT_MS) setReady(true);
      else timer = window.setTimeout(check, 40);
    };
    check();
    return () => clearTimeout(timer);
  }, []);
  return (
    <div ref={box} class={`page-gate${ready ? ' ready' : ''}`}>
      {children}
    </div>
  );
}
