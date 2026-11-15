import versions from '../../../versions.json';
import { native } from './native';

/**
 * Plateforme sur laquelle tourne ce build web : chacune a son propre numéro de version
 * (versions.json à la racine) et ses propres nouveautés dans le journal.
 */
export type Platform = 'desktop' | 'web' | 'android' | 'tv';

function detect(): Platform {
  if (typeof window === 'undefined') return 'web';
  if (native) return 'desktop';
  const w = window as unknown as { Capacitor?: { getPlatform?(): string }; tizen?: unknown; PalmSystem?: unknown; webOS?: unknown };
  if (w.Capacitor?.getPlatform?.() === 'android') return 'android';
  if (w.tizen || w.PalmSystem || w.webOS || /Web0S|webOS|Tizen/i.test(navigator.userAgent)) return 'tv';
  return 'web';
}

export const platform: Platform = detect();

/**
 * Téléviseur : LG webOS, Samsung Tizen, ou Android sans écran tactile (Android TV, Fire TV).
 * On s'y sert d'une télécommande : pas de clavier ni de navigateur à ouvrir pour se connecter.
 */
export const tvDevice: boolean =
  platform === 'tv' || (platform === 'android' && typeof navigator !== 'undefined' && (navigator.maxTouchPoints === 0 || /\bTV\b|AFT/.test(navigator.userAgent)));

/** Version de cette plateforme (versions.json : bureau, web, Android et TV ont chacun la leur). */
export const VERSION: string = (versions as Record<string, string>)[platform];
