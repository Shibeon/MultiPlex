import { imdbIdOf, ratingBadges, techBadges, type Hub, type Metadata } from '@multiplex/core';
import { Carousel } from './carousel';
import { tvDevice } from './platform';
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { t } from './i18n';
import { openItemMenu } from './menu';
import { cardWidth, couchOn } from './settings';
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
  forward: 'M8.5 4L7 5.5l6.5 6.5L7 18.5 8.5 20l8-8z',
  check: 'M9 16.2l-3.5-3.6L4 14l5 5 11-11-1.5-1.4z',
  next: 'M5 4l10 8-10 8zm11 0h3v16h-3z',
  prev: 'M19 4L9 12l10 8zM5 4h3v16H5z',
  cast: 'M3 4h18a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-7v-2h6V6H4v3H2V5a1 1 0 0 1 1-1zM2 11a9 9 0 0 1 9 9H9a7 7 0 0 0-7-7zm0 4a5 5 0 0 1 5 5H5a3 3 0 0 0-3-3zm0 4a1 1 0 0 1 1 1H2z',
  history: 'M13 3a9 9 0 1 1-8.5 12h2.1A7 7 0 1 0 6 9.3L8.5 12H2V5.5l2.6 2.6A9 9 0 0 1 13 3zm-1 5h2v4.6l3.4 2-1 1.7L12 13.7z',
  friends: 'M12 3.5a3.25 3.25 0 1 1 0 6.5 3.25 3.25 0 0 1 0-6.5zM5.6 6a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zm12.8 0a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM12 11.5c3.5 0 6 2.2 6 5.3V19H6v-2.2c0-3.1 2.5-5.3 6-5.3zM5.4 12.4c.4 0 .8 0 1.2.1A6.6 6.6 0 0 0 4.5 17v.6H1v-1.4c0-2.3 1.9-3.8 4.4-3.8zm13.2 0c2.5 0 4.4 1.5 4.4 3.8v1.4h-3.5V17a6.6 6.6 0 0 0-2.1-4.5c.4-.1.8-.1 1.2-.1z',
  together: 'M8 4a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zm8.5 1a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM8 12.5c3.6 0 6 1.9 6 4.5v2H2v-2c0-2.6 2.4-4.5 6-4.5zm8.5.5c2.9 0 5.5 1.5 5.5 4v2h-6v-2c0-1.5-.6-2.9-1.7-3.9.7-.1 1.4-.1 2.2-.1z',
  tv: 'M3 5h18a1 1 0 011 1v11a1 1 0 01-1 1h-6l1.5 2.5h-9L9 18H3a1 1 0 01-1-1V6a1 1 0 011-1zm1 2v9h16V7z',
  lock: 'M7 10V7a5 5 0 0110 0v3h1a1 1 0 011 1v9a1 1 0 01-1 1H6a1 1 0 01-1-1v-9a1 1 0 011-1zm2 0h6V7a3 3 0 00-6 0z',
  full: 'M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z',
  up: 'M12 7l7 7-1.5 1.5L12 10l-5.5 5.5L5 14z',
  grip: 'M9 4.5a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5zm6 0a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5zM9 10.25a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5zm6 0a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5zM9 16a1.75 1.75 0 1 1 0 3.5A1.75 1.75 0 0 1 9 16zm6 0a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5z',
  down: 'M12 17l-7-7 1.5-1.5L12 14l5.5-5.5L19 10z',
  eye: 'M12 5c5 0 9 4 10 7-1 3-5 7-10 7S3 15 2 12c1-3 5-7 10-7zm0 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  volume: 'M4 9h4l5-4v14l-5-4H4zm12.5 3a4 4 0 0 0-2-3.5v7a4 4 0 0 0 2-3.5z',
  more: 'M12 5.5a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5zm0 5a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5zm0 5a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5z',
  share: 'M18 3a3 3 0 1 1-2.2 5l-6.9 3.5a3 3 0 0 1 0 1l6.9 3.5a3 3 0 1 1-.9 1.8l-6.9-3.5a3 3 0 1 1 0-4.6l6.9-3.5A3 3 0 0 1 18 3z',
  queue: 'M3 5h13v2H3zm0 5h13v2H3zm0 5h8v2H3zm12 0v-3l5 4-5 4z',
  list: 'M4 5h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zm-4 6h2v2H4zm4 0h12v2H8z',
  plus: 'M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z',
  close: 'M6.4 5L12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z',
  download: 'M11 3h2v9.2l3.3-3.3 1.4 1.4-5.7 5.7-5.7-5.7 1.4-1.4 3.3 3.3zM4 18h16v2H4z',
  dots: 'M5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  star: 'M12 17.3l-6.2 3.7 1.6-7L2 9.2l7.2-.6L12 2l2.8 6.6 7.2.6-5.4 4.8 1.6 7z',
  restart: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
  audio: 'M12 3a9 9 0 0 0-9 9v7c0 1.1.9 2 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3c1.1 0 2-.9 2-2v-7a9 9 0 0 0-9-9z',
  subtitles: 'M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6zm0 4h8v2H6zm10 0h2v2h-2zm-6-4h8v2h-8z',
  mute: 'M4 9h4l5-4v14l-5-4H4zm11.6 0L17 10.4 18.4 9l1.4 1.4-1.4 1.4 1.4 1.4-1.4 1.4-1.4-1.4-1.4 1.4-1.4-1.4 1.4-1.4-1.4-1.4z',
};

export function Icon({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <svg class="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" fill-rule="evenodd" d={ICONS[name] ?? ICONS.movie} />
    </svg>
  );
}

/**
 * Bulle au-dessus de la barre de lecture : l'heure visée et, quand on en a une, l'image
 * à cet endroit. `thumb` va chercher l'image d'une position (secondes).
 */
export function SeekPreview({ duration, thumb, children }: { duration: number; thumb?: (time: number) => Promise<string | null> | undefined; children: ComponentChildren }) {
  const [at, setAt] = useState<{ x: number; time: number } | null>(null);
  const [image, setImage] = useState('');
  const timer = useRef(0);
  const asked = useRef(-1);
  useEffect(() => () => clearTimeout(timer.current), []);

  const move = (e: MouseEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (!duration || !box.width) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const time = ratio * duration;
    // La bulle reste dans la barre, même près des bords.
    setAt({ x: Math.min(box.width - 84, Math.max(84, ratio * box.width)), time });
    if (!thumb) return;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      asked.current = time;
      void thumb(time)?.then((src) => src && asked.current === time && setImage(src));
    }, 70);
  };
  const clock = (sec: number) => {
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
  };
  return (
    <div class="seek-track" onMouseMove={move} onMouseLeave={() => (setAt(null), clearTimeout(timer.current))}>
      {children}
      {at && (
        <div class="seek-preview" style={{ left: `${at.x}px` }}>
          {image && <img src={image} alt="" />}
          <span>{clock(at.time)}</span>
        </div>
      )}
    </div>
  );
}

/** Pictogrammes des notes : dessins maison, pas les logos des services. */
const RATING_ART: Record<string, JSX.Element> = {
  // Tomate fraîche / éclaboussure.
  'rt-critic-1': (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="13.5" r="8.5" fill="#fa320a" />
      <path d="M12 6.5c-1.5-2.2-3.7-2.6-5.4-2 1.4.6 2.3 1.6 2.6 2.6-1.3-.5-2.9-.2-3.9.8 1.7.1 3.3.7 4.4 1.6 1.4-.8 3.2-.8 4.6 0 1.1-.9 2.7-1.5 4.4-1.6-1-1-2.6-1.3-3.9-.8.3-1 1.2-2 2.6-2.6-1.7-.6-3.9-.2-5.4 2z" fill="#00912d" />
    </svg>
  ),
  'rt-critic-0': (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.5l1.6 3.3 3.2-2-.4 3.8 3.8.2-2.6 2.8 3 2.3-3.7 1 1.2 3.6-3.6-1.2-1 3.7-2.3-3-2.8 2.6-.2-3.8-3.8.4 2-3.2-3.3-1.6 3.5-1.5-1.6-3.4 3.8.6.3-3.8z" fill="#0ac855" />
    </svg>
  ),
  // Pop-corn debout / renversé.
  'rt-audience-1': (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="8" cy="7.5" r="3.3" fill="#ffd700" />
      <circle cx="12" cy="6" r="3.6" fill="#ffe14d" />
      <circle cx="16" cy="7.5" r="3.3" fill="#ffd700" />
      <path d="M5.5 9.5h13l-1.6 12h-9.8z" fill="#fa320a" />
      <path d="M9.2 9.5l.7 12h1.6l-.4-12zm3.7 0l-.4 12h1.6l.7-12z" fill="#fff" />
    </svg>
  ),
  'rt-audience-0': (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <g transform="rotate(-70 12 13)">
        <path d="M5.5 9.5h13l-1.6 12h-9.8z" fill="#0ac855" />
        <path d="M9.2 9.5l.7 12h1.6l-.4-12zm3.7 0l-.4 12h1.6l.7-12z" fill="#fff" />
      </g>
      <circle cx="18.5" cy="17.5" r="2.4" fill="#ffd700" />
      <circle cx="20.5" cy="13" r="2" fill="#ffe14d" />
    </svg>
  ),
};

/** Les notes d'un titre : IMDb, Rotten Tomatoes (critiques et public), TMDB. */
export function Ratings({ item }: { item: Metadata }) {
  const badges = ratingBadges(item);
  if (!badges.length && !imdbIdOf(item)) return null;
  const names: Record<string, string> = { imdb: 'IMDb', 'rt-critic': 'Rotten Tomatoes — critiques', 'rt-audience': 'Rotten Tomatoes — public', tmdb: 'TMDB', other: 'Note' };
  return (
    <span class="ratings">
      {badges.map((b) => (
        <span key={b.source} class={`rating rating-${b.source}`} title={names[b.source]}>
          {b.source === 'imdb' ? <i class="rating-word">IMDb</i> : b.source === 'tmdb' ? <i class="rating-word">TMDB</i> : b.source === 'other' ? <i class="rating-word">★</i> : RATING_ART[`${b.source}-${b.fresh ? 1 : 0}`]}
          <b>{b.text}</b>
          <span class="sr-only">{names[b.source]}</span>
        </span>
      ))}
      {/* Letterboxd ne publie pas ses notes : on mène à la fiche du film, où elle se lit. */}
      {!tvDevice && item.type === 'movie' && imdbIdOf(item) && (
        <a class="rating rating-lb" href={`https://letterboxd.com/imdb/${imdbIdOf(item)}/`} target="_blank" rel="noreferrer" title="Letterboxd">
          <i class="rating-word">Letterboxd</i>
          <Icon name="next" size={10} />
        </a>
      )}
    </span>
  );
}

/** Note personnelle : cinq étoiles, par demi-étoile (clic sur la moitié gauche ou droite). */
export function StarRating({ value, onRate, disabled }: { value: number | undefined; onRate: (rating: number | null) => void; disabled?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <span class="stars" role="group" aria-label={t('item.myRating')} onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((n) => {
        const fill = shown >= n * 2 ? 100 : shown >= n * 2 - 1 ? 50 : 0;
        const pick = (e: MouseEvent) => (e.offsetX < (e.currentTarget as HTMLElement).offsetWidth / 2 ? n * 2 - 1 : n * 2);
        return (
          <button
            key={n}
            class="star"
            disabled={disabled}
            aria-label={`${n} / 5`}
            aria-pressed={(value ?? 0) >= n * 2 - 1}
            style={{ '--fill': `${fill}%` }}
            onMouseMove={(e) => setHover(pick(e))}
            onClick={(e) => {
              // Au clavier (pas de position de souris) : l'étoile entière. Recliquer la même note la retire.
              const r = e.detail === 0 ? n * 2 : pick(e);
              onRate(r === value ? null : r);
            }}
          />
        );
      })}
    </span>
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
    return { title: item.grandparentTitle ?? item.title, sub: `S${item.parentIndex ?? '?'} · E${item.index ?? '?'} · ${item.title}` };
  }
  if (item.type === 'season') return { title: item.parentTitle ?? item.title, sub: item.title };
  return { title: item.title, sub: item.year ? String(item.year) : '' };
}

export function isWatched(item: Metadata): boolean {
  if (item.leafCount !== undefined) return (item.viewedLeafCount ?? 0) >= item.leafCount;
  return !!item.viewCount;
}

/** Bouton « ⋯ » d'une affiche : le même menu que le clic droit. */
function MoreButton({ item }: { item: Metadata }) {
  return (
    <span
      class="card-more"
      role="button"
      aria-label={t('menu.more')}
      title={t('menu.more')}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openItemMenu(item, e.currentTarget as HTMLElement);
      }}
    >
      <Icon name="more" size={20} />
    </span>
  );
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
        {remaining > 0 ? (
          <span class="badge">{remaining}</span>
        ) : isWatched(item) ? (
          <span class="badge seen" title={t('item.seen')}>
            <Icon name="check" size={16} />
          </span>
        ) : null}
        {progress > 0 && (
          <span class="progress">
            <i style={{ width: `${progress * 100}%` }} />
          </span>
        )}
        <MoreButton item={item} />
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
        <MoreButton item={item} />
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
      <Carousel>{(hub.Metadata ?? []).map((m) => (wide ? <WideCard key={m.ratingKey} item={m} /> : <Card key={m.ratingKey} item={m} />))}</Carousel>
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
  // Affichage TV : l'affiche sélectionnée grossit et son titre descend (voir styles.css, --lift) ;
  // on écarte les rangées d'autant pour que l'année ne passe pas sous la rangée suivante.
  const couch = couchOn.value;
  const lift = (colW: number) => (couch ? colW * 1.5 * 0.045 + 10 : 0);

  useLayoutEffect(() => {
    let raf = 0;
    const calc = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const w = el.clientWidth;
      const cols = Math.max(1, Math.floor((w + gap) / (minWidth + gap)));
      const colW = (w - gap * (cols - 1)) / cols;
      const rowH = colW * 1.5 + extra + gap + lift(colW);
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
  }, [total, minWidth, extra, gap, couch]);

  const rowGap = gap + lift(v.colW);
  const rowH = v.colW * 1.5 + extra + rowGap;
  const start = v.first * v.cols;
  const end = Math.min(total, v.last * v.cols);
  useEffect(() => {
    if (end > start) onRange(start, end);
  }, [start, end]);

  const cells = [];
  for (let i = start; i < end; i++) {
    cells.push(
      <div key={i} class="vcell" style={{ height: `${rowH - rowGap}px` }}>
        {render(i)}
      </div>,
    );
  }
  return (
    <div ref={ref} class="vgrid-wrap" style={{ height: `${Math.ceil(total / v.cols) * rowH}px` }}>
      <div class="vgrid" style={{ transform: `translateY(${v.first * rowH}px)`, gridTemplateColumns: `repeat(${v.cols}, 1fr)`, rowGap: `${rowGap}px`, columnGap: `${gap}px` }}>
        {cells}
      </div>
    </div>
  );
}

