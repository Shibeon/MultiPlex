/**
 * Contournement : sur Windows, l'application de bureau désactive DirectComposition (sinon la
 * page recouvre la vidéo de mpv), et Chromium peut alors oublier de redessiner une image qui
 * finit de se charger : l'affiche n'apparaît qu'au survol de la souris. Le survol ne fait que
 * redessiner l'affiche ; on fait la même chose, seuls, dès qu'une image est chargée.
 */
export function initRepaintOnLoad(): void {
  const pending = new Set<HTMLImageElement>();
  let frame = 0;
  const flush = () => {
    frame = 0;
    const imgs = [...pending];
    pending.clear();
    for (const img of imgs) img.style.transform = 'translateZ(0)';
    requestAnimationFrame(() => {
      for (const img of imgs) img.style.removeProperty('transform');
    });
  };
  document.addEventListener(
    'load',
    (e) => {
      const img = e.target;
      if (!(img instanceof HTMLImageElement)) return;
      pending.add(img);
      if (!frame) frame = requestAnimationFrame(flush);
    },
    true,
  );
}
