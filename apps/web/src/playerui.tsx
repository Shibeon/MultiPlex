import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from './i18n';
import { Icon } from './ui';

/** Bouton de saut : flèche circulaire, et la durée en dessous (« −30s », « +30s »). */
export function SkipButton({ seconds, onClick, act }: { seconds: number; onClick: () => void; act?: string }) {
  const label = seconds < 0 ? t('player.backN').replace('{n}', String(-seconds)) : t('player.fwdN').replace('{n}', String(seconds));
  return (
    <button class="btn icon-btn skipper" data-act={act} aria-label={label} title={label} onClick={onClick}>
      <svg class="icon" width={24} height={24} viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" transform={seconds > 0 ? 'translate(24 0) scale(-1 1)' : undefined} d="M12 4.5V1L7 5.5 12 10V6.5a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" />
      </svg>
      <small>
        {seconds < 0 ? '−' : '+'}
        {Math.abs(seconds)}s
      </small>
    </button>
  );
}

/** Pastilles du fichier lu (définition, plage dynamique, son), sous le titre. */
export function PlayerTech({ badges }: { badges: { kind: string; label: string }[] | undefined }) {
  if (!badges?.length) return null;
  return (
    <ul class="ptech" aria-label="Caractéristiques techniques">
      {badges.map((b) => (
        <li key={b.kind + b.label} class={`ptech-${b.kind}`} data-tech={b.label}>
          {b.label}
        </li>
      ))}
    </ul>
  );
}

const clockOf = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Heure qu'il est, et heure de fin estimée de la lecture. */
export function PlayerClock({ remaining, speed = 1 }: { remaining: number; speed?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(timer);
  }, []);
  const now = new Date();
  return (
    <div class="player-clock" aria-hidden="true">
      <b>{clockOf(now)}</b>
      {remaining > 0 && <small>{t('couch.ends').replace('{t}', clockOf(new Date(now.getTime() + (remaining * 1000) / (speed || 1))))}</small>}
    </div>
  );
}

/** Pastille du bas du lecteur : icône et libellé (seule l'icône sur les petits écrans). */
export function Pill({ icon, label, expanded, onClick, title, act }: { icon: string; label: string; expanded?: boolean; onClick: () => void; title?: string; act?: string }) {
  return (
    <button class="btn pill" data-act={act} aria-label={label} title={title ?? label} aria-expanded={expanded} onClick={onClick}>
      <Icon name={icon} /> <span>{label}</span>
    </button>
  );
}

/**
 * Bouton de réglage du lecteur qui s'ouvre sur ses options : la liste sort du bouton,
 * vers le haut, dans la même matière, pour qu'on voie d'où elle vient.
 */
export function PillMenu({ open, menu, ...pill }: { icon: string; label: string; open: boolean; menu: ComponentChildren; onClick: () => void; act?: string }) {
  return (
    <span class={`pill-wrap${open ? ' open' : ''}`}>
      {open && <div class="pill-panel">{menu}</div>}
      <Pill {...pill} expanded={open} />
    </span>
  );
}

/** Sous-titre du lecteur (« S2 · E3 · titre ») : les points y sont plus marqués, comme dans la maquette. */
export function PlayerSub({ text }: { text: string }) {
  const parts = text.split(' · ');
  return (
    <span class="player-sub">
      {parts.map((p, i) => (
        <>
          {i > 0 && <i class="psep" aria-hidden="true">•</i>}
          {p}
        </>
      ))}
    </span>
  );
}
