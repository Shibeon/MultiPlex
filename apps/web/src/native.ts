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
  /** Sortie audio à utiliser (identifiant donné par audioDevices) ; absent = celle du système. */
  audioDevice?: string;
  /** Accorder la fréquence de l'écran à la cadence de la vidéo (Windows). */
  matchRefresh?: boolean;
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
  hasPrev?: boolean;
  /** Libellés Plex des pistes, dans l'ordre où mpv les numérote. */
  audioLabels?: string[];
  subLabels?: string[];
  /** Qualité en cours et choix proposés (« original » = fichier lu tel quel). */
  quality?: string;
  qualities?: { id: string; label: string }[];
}

export type NativeCommand = 'toggle' | 'pause' | 'seek' | 'seekBy' | 'volume' | 'mute' | 'speed' | 'aid' | 'sid' | 'stats' | 'key';
export type NativeEvent = 'state' | 'ended' | 'error' | 'next' | 'prev' | 'quality' | 'notice';

/** État de la mise à jour de l'application de bureau. */
export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error';
  /** Version installée. */
  current: string;
  /** Version proposée. */
  version?: string;
  percent?: number;
  /** Nouveautés de la version proposée : JSON { fr, en } ou texte libre. */
  notes?: string;
  message?: string;
}

export interface NativeApi {
  /** Mise à jour automatique ; absent des versions de l'app qui ne la connaissent pas. */
  updates?: {
    state(): Promise<UpdateState>;
    check(): Promise<unknown>;
    download(): Promise<unknown>;
    install(): Promise<unknown>;
    on(listener: (state: UpdateState) => void): () => void;
  };
  /** Sorties audio de la machine ; absent des versions de l'app qui ne le proposent pas. */
  audioDevices?(): Promise<{ id: string; label: string }[]>;
  platform?: string;
  /** Repères d'intro communautaires (IntroDB) pour un épisode ; absent hors application de bureau. */
  segments?(imdb: string, season: number, episode: number): Promise<{ intro?: { start_sec?: number; end_sec?: number } | null; outro?: { start_sec?: number; end_sec?: number } | null } | null>;
  available(): Promise<boolean>;
  play(opts: NativePlayOptions): Promise<unknown>;
  stop(): Promise<void>;
  command(name: NativeCommand, value?: unknown): Promise<unknown>;
  info(): Promise<Record<string, unknown>>;
  on(listener: (type: NativeEvent, data: Record<string, unknown>) => void): () => void;
  setMeta(meta: NativeMeta): void;
  overlayInit(): Promise<{ meta: NativeMeta; state: Record<string, unknown> }>;
  onMeta(listener: (meta: NativeMeta) => void): () => void;
  action(name: 'back' | 'fullscreen' | 'next' | 'prev' | `quality:${string}`): void;
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
