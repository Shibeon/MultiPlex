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
  /** Flux produit en direct par le serveur : mettre davantage en tampon avant de reprendre. */
  buffered?: boolean;
}

/** Ce que la page principale sait du titre en cours et transmet à la fenêtre de contrôles. */
export interface NativeMeta {
  title?: string;
  sub?: string;
  /** Marqueurs d'intro et de générique, en secondes. */
  markers?: { type: string; start: number; end: number }[];
  hasNext?: boolean;
  /** Libellés Plex des pistes, dans l'ordre où mpv les numérote. */
  audioLabels?: string[];
  subLabels?: string[];
  /** Qualité en cours et choix proposés (« original » = fichier lu tel quel). */
  quality?: string;
  qualities?: { id: string; label: string }[];
}

export type NativeCommand = 'toggle' | 'pause' | 'seek' | 'seekBy' | 'volume' | 'mute' | 'speed' | 'aid' | 'sid' | 'stats' | 'key';
export type NativeEvent = 'state' | 'ended' | 'error' | 'next' | 'quality';

export interface NativeApi {
  available(): Promise<boolean>;
  play(opts: NativePlayOptions): Promise<unknown>;
  stop(): Promise<void>;
  command(name: NativeCommand, value?: unknown): Promise<unknown>;
  info(): Promise<Record<string, unknown>>;
  on(listener: (type: NativeEvent, data: Record<string, unknown>) => void): () => void;
  setMeta(meta: NativeMeta): void;
  overlayInit(): Promise<{ meta: NativeMeta; state: Record<string, unknown> }>;
  onMeta(listener: (meta: NativeMeta) => void): () => void;
  action(name: 'back' | 'fullscreen' | 'next' | `quality:${string}`): void;
}

export const native = (window as unknown as { multiplexNative?: NativeApi }).multiplexNative;

/** Cette fenêtre est-elle la couche de contrôles posée par-dessus la vidéo ? */
export const isOverlayWindow = !!native && location.hash.startsWith('#/overlay');

/** Vrai une fois confirmé que mpv est présent sur la machine. */
export const nativeAvailable = signal(false);

if (!isOverlayWindow) {
  native
    ?.available()
    .then((ok) => (nativeAvailable.value = ok))
    .catch(() => {});
}
