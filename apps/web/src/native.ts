import { signal } from '@preact/signals';

/** Lecteur natif (mpv) fourni par l'application de bureau ; absent dans un navigateur. */
export interface NativePlayOptions {
  url: string;
  /** En-têtes HTTP envoyés par le lecteur (jeton du serveur). */
  headers?: Record<string, string>;
  title: string;
  /** Position de départ en secondes. */
  start: number;
  /** Rang de la piste dans le fichier (1 = première), 0 = aucune, absent = choix de mpv. */
  aid?: number;
  sid?: number;
  /** Sous-titres externes à charger en plus de ceux du fichier. */
  subFiles?: string[];
  /** Transmettre le flux audio brut (Dolby, DTS, Atmos) à un ampli. */
  passthrough?: boolean;
}

export interface NativeApi {
  available(): Promise<boolean>;
  play(opts: NativePlayOptions): Promise<unknown>;
  stop(): Promise<void>;
  command(name: 'toggle' | 'pause' | 'seek' | 'seekBy' | 'fullscreen' | 'key' | 'mouse' | 'button', value?: unknown): Promise<unknown>;
  info(): Promise<Record<string, unknown>>;
  on(listener: (type: 'state' | 'ended' | 'error', data: Record<string, unknown>) => void): () => void;
}

export const native = (window as unknown as { multiplexNative?: NativeApi }).multiplexNative;

/** Vrai une fois confirmé que mpv est présent sur la machine. */
export const nativeAvailable = signal(false);

native
  ?.available()
  .then((ok) => (nativeAvailable.value = ok))
  .catch(() => {});
