import { techBadges, type Hub, type Metadata } from '@multiplex/core';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from './i18n';
import { cardWidth } from './settings';
import { server } from './store';

const ICONS: Record<string, string> = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  search: 'M10.5 3a7.5 7.5 0 0 1 5.9 12.1l4.3 4.3-1.4 1.4-4.3-4.3A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z',
  settings: 'M4 7h9v2H4zm13 0h3v2h-3zM4 15h3v2H4zm7 0h9v2h-9zM14 5h2v6h-2zM8 13h2v6H8z',
  movie: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v2h2V6zm0 5v2h2v-2zm0 5v2h2v-2zM17 6v2h2V6zm0 5v2h2v-2zm0 5v2h2v-2zM9 6v12h6V6z',
  show: 'M3 6h18a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm1 2v8h16V8zm3 12h10v2H7z',
  artist: 'M9 3h10v3h-8v11a3 3 0 1 1-2-2.8z',
  photo: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 12h14l-4.5-6-3.5 4.5-2.5-3z',
  play: 'M7 4l13 8-13 8z',
  bookmark: 'M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1zm1 2v12.6l5-2.9 5 2.9V5z',
  info: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm-1 6h2v7h-2zm0-3h2v2h-2z',
  pip: 'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1 2v10h16V7zm8 4h6v4h-6z',
  live: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM5.6 5.6L7 7a7 7 0 0 0 0 10l-1.4 1.4a9 9 0 0 1 0-12.8zm12.8 0a9 9 0 0 1 0 12.8L17 17a7 7 0 0 0 0-10z',
  pause: 'M6 4h4v16H6zm8 0h4v16h-4z',
  back: 'M15.5 4l1.5 1.5L10.5 12l6.5 6.5-1.5 1.5-8-8z',
  check: 'M9 16.2l-3.5-3.6L4 14l5 5 11-11-1.5-1.4z',
  next: 'M5 4l10 8-10 8zm11 0h3v16h-3z',
  prev: 'M19 4L9 12l10 8zM5 4h3v16H5z',
  lock: 'M7 10V7a5 5 0 0110 0v3h1a1 1 0 011 1v9a1 1 0 01-1 1H6a1 1 0 01-1-1v-9a1 1 0 011-1zm2 0h6V7a3 3 0 00-6 0z',
  full: 'M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z',
  up: 'M12 7l7 7-1.5 1.5L12 10l-5.5 5.5L5 14z',
  down: 'M12 17l-7-7 1.5-1.5L12 14l5.5-5.5L19 10z',
  eye: 'M12 5c5 0 9 4 10 7-1 3-5 7-10 7S3 15 2 12c1-3 5-7 10-7zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  volume: 'M4 9h4l5-4v14l-5-4H4zm12.5 3a4 4 0 0 0-2-3.5v7a4 4 0 0 0 2-3.5z',
  mute: 'M4 9h4l5-4v14l-5-4H4zm11.6 0L17 10.4 18.4 9l1.4 1.4-1.4 1.4 1.4 1.4-1.4 1.4-1.4-1.4-1.4 1.4-1.4-1.4 1.4-1.4-1.4-1.4z',
};

export function Icon({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" fill-rule="evenodd" d={ICONS[name] ?? ICONS.movie} />
    </svg>
  );
}

/** Pastilles des technologies d'un fichier : définition, codec, plage dynamique, son. */
export function TechBadges({ item }: { item: Metadata }) {
  const badges = techBadges(item.Media?.[0]);
  if (!badges.length) return null;
  return (
    <ul class="tech" aria-label="Caractéristiques techniques">
      {badges.map((b) => (
        <li key={b.kind + b.label} class={`tech-${b.kind}`} data-tech={b.label}>
          {b.label}
        </li>
      ))}
    </ul>
  );
}

export function Spinner() {
  return <div class="spinner" role="status" aria-label={t('common.loading')} />;
}

export function ErrorBox({ error, retry }: { error: Error | string; retry?: () => void }) {
  return (
    <div class="error-box" role="alert">
      <p>{t('common.error')}</p>
      <small>{typeof error === 'string' ? error : error.message}</small>
      {retry && (
        <button class="btn" onClick={retry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

/** Largeur d'image demandée au serveur, arrondie pour maximiser les réutilisations du cache. */
function imgWidth(css: number): number {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  return Math.ceil((css * dpr) / 80) * 80;
}

/**
 * Taille à demander pour une image de fond : celle de l'écran, densité comprise,
 * jusqu'à la 4K. Arrondie par paliers pour que le cache d'images resserve.
 */
export function artSize(): [number, number] {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.min(3840, Math.max(1280, Math.ceil((window.innerWidth * dpr) / 640) * 640));
  return [w, Math.round((w * 9) / 16)];
}

export function labels(item: Metadata): { title: string; sub: string } {
  if (item.type === 'episode') {
    return { title: item.grandparentTitle ?? item.title, sub: `S${item.parentIndex ?? '?'} · E${item.index ?? '?'} — ${item.title}` };
  }
  if (item.type === 'season') return { title: item.parentTitle ?? item.title, sub: item.title };
  return { title: item.title, sub: item.year ? String(item.year) : '' };
}

export function isWatched(item: Metadata): boolean {
  if (item.leafCount !== undefined) return (item.viewedLeafCount ?? 0) >= item.leafCount;
  return !!item.viewCount;
}

export function Card({ item }: { item: Metadata }) {
  const srv = server.value!;
  const w = imgWidth(cardWidth());
  const { title, sub } = labels(item);
  const thumb = item.type === 'episode' ? (item.grandparentThumb ?? item.thumb) : (item.thumb ?? item.parentThumb);
  const progress = item.viewOffset && item.duration ? Math.min(1, item.viewOffset / item.duration) : 0;
  const remaining = item.leafCount !== undefined ? item.leafCount - (item.viewedLeafCount ?? 0) : 0;
  return (
    <a class="card" href={`#/item/${item.ratingKey}`} title={title}>
      <div class="poster">
        <span class="poster-fallback">{title}</span>
        {thumb && <img loading="lazy" decoding="async" src={srv.image(thumb, w, Math.round(w * 1.5))} alt="" />}
        {remaining > 0 ? <span class="badge">{remaining}</span> : !isWatched(item) && !progress ? <span class="badge dot" /> : null}
        {progress > 0 && (
          <span class="progress">
            <i style={{ width: `${progress * 100}%` }} />
          </span>
        )}
      </div>
      <div class="card-text">
        <div class="card-title">{title}</div>
        <div class="card-sub">{sub}</div>
      </div>
    </a>
  );
}

/** Vignette paysage (rangée « Reprendre ») : image large, titre incrusté, progression. */
export function WideCard({ item }: { item: Metadata }) {
  const srv = server.value!;
  const w = imgWidth(cardWidth() * 1.9);
  const { title, sub } = labels(item);
  const image = item.type === 'episode' ? (item.thumb ?? item.art) : (item.art ?? item.thumb);
  const progress = item.viewOffset && item.duration ? Math.min(1, item.viewOffset / item.duration) : 0;
  return (
    <a class="card wide" href={`#/item/${item.ratingKey}`} title={title}>
      <div class="poster">
        <span class="poster-fallback">{title}</span>
        {image && <img loading="lazy" decoding="async" src={srv.image(image, w, Math.round((w * 9) / 16))} alt="" />}
        <span class="wide-caption">
          <strong>{title}</strong>
          <small>{sub}</small>
        </span>
        {progress > 0 && (
          <span class="progress">
            <i style={{ width: `${progress * 100}%` }} />
          </span>
        )}
      </div>
    </a>
  );
}

export function HubRow({ hub }: { hub: Hub }) {
  // Les rangées de reprise s'affichent en vignettes paysage, comme une file « À suivre ».
  const wide = /continue|ondeck|inprogress/i.test(hub.hubIdentifier);
  return (
    <section class="hub" data-hub={hub.hubIdentifier}>
      <h2>{hub.title}</h2>
      <div class="row">
        {(hub.Metadata ?? []).map((m) => (wide ? <WideCard key={m.ratingKey} item={m} /> : <Card key={m.ratingKey} item={m} />))}
      </div>
    </section>
  );
}

interface GridProps {
  total: number;
  minWidth: number;
  /** Hauteur de la zone de texte sous l'affiche. */
  extra: number;
  gap?: number;
  onRange: (start: number, end: number) => void;
  render: (index: number) => ComponentChildren;
}

/**
 * Grille virtualisée : seules les rangées visibles (plus une marge) existent
 * dans le DOM, ce qui garde une bibliothèque de 20 000 titres aussi fluide
 * qu'une de 50 — indispensable sur TV et mobiles modestes.
 */
export function VirtualGrid({ total, minWidth, extra, gap = 16, onRange, render }: GridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [v, setV] = useState({ cols: 1, colW: minWidth, first: 0, last: 0 });

  useLayoutEffect(() => {
    let raf = 0;
    const calc = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const w = el.clientWidth;
      const cols = Math.max(1, Math.floor((w + gap) / (minWidth + gap)));
      const colW = (w - gap * (cols - 1)) / cols;
      const rowH = colW * 1.5 + extra + gap;
      const top = el.getBoundingClientRect().top;
      const first = Math.max(0, Math.floor(-top / rowH) - 2);
      const last = Math.min(Math.ceil(total / cols), Math.ceil((innerHeight - top) / rowH) + 2);
      setV((p) => (p.cols === cols && p.colW === colW && p.first === first && p.last === last ? p : { cols, colW, first, last }));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(calc);
    };
    calc();
    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', schedule);
    return () => {
      removeEventListener('scroll', schedule);
      removeEventListener('resize', schedule);
      cancelAnimationFrame(raf);
    };
  }, [total, minWidth, extra, gap]);

  const rowH = v.colW * 1.5 + extra + gap;
  const start = v.first * v.cols;
  const end = Math.min(total, v.last * v.cols);
  useEffect(() => {
    if (end > start) onRange(start, end);
  }, [start, end]);

  const cells = [];
  for (let i = start; i < end; i++) {
    cells.push(
      <div key={i} class="vcell" style={{ height: `${rowH - gap}px` }}>
        {render(i)}
      </div>,
    );
  }
  return (
    <div ref={ref} class="vgrid-wrap" style={{ height: `${Math.ceil(total / v.cols) * rowH}px` }}>
      <div class="vgrid" style={{ transform: `translateY(${v.first * rowH}px)`, gridTemplateColumns: `repeat(${v.cols}, 1fr)`, gap: `${gap}px` }}>
        {cells}
      </div>
    </div>
  );
}
