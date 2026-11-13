import { useEffect } from 'preact/hooks';

/**
 * Lecteur en paysage, comme les applications de streaming : sur téléphone, lancer une lecture
 * fait pivoter l'écran en paysage, et le lecteur n'apparaît jamais en portrait. En le quittant,
 * la rotation redevient libre.
 *
 * Dans l'application Android, un petit module natif (ScreenPlugin) fixe l'orientation. Dans un
 * navigateur, on tente l'API d'orientation, que les navigateurs n'acceptent qu'en plein écran :
 * si elle refuse, rien ne se passe.
 */
type Screen = { landscape(): Promise<void>; release(): Promise<void> };
type Cap = { isNativePlatform?(): boolean; isPluginAvailable?(n: string): boolean; registerPlugin?<T>(n: string): T };

let plugin: Screen | null | undefined;
function nativeScreen(): Screen | null {
  if (plugin !== undefined) return plugin;
  const cap = (window as unknown as { Capacitor?: Cap }).Capacitor;
  plugin = cap?.isNativePlatform?.() && cap.isPluginAvailable?.('MultiplexScreen') && cap.registerPlugin ? cap.registerPlugin<Screen>('MultiplexScreen') : null;
  return plugin;
}

type Lockable = ScreenOrientation & { lock?(o: string): Promise<void> };

export function lockLandscape(): void {
  const n = nativeScreen();
  if (n) return void n.landscape().catch(() => {});
  if (!matchMedia('(pointer: coarse)').matches) return;
  void (screen.orientation as Lockable | undefined)?.lock?.('landscape')?.catch(() => {});
}

export function releaseOrientation(): void {
  const n = nativeScreen();
  if (n) return void n.release().catch(() => {});
  try {
    screen.orientation?.unlock?.();
  } catch {
    /* pas de verrou en cours */
  }
}

/** Le temps que le composant est affiché, l'écran reste en paysage. */
export function useLandscape(): void {
  useEffect(() => {
    lockLandscape();
    return releaseOrientation;
  }, []);
}
