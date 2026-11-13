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
  /** Préparer les aperçus en image de la barre de lecture. */
  seekPreview?: boolean;
  /** Flux produit en direct par le serveur : mettre davantage en tampon avant de reprendre. */
  buffered?: boolean;
}

/** Ce que la page principale sait du titre en cours et transmet à la fenêtre de contrôles. */
export interface NativeMeta {
  /** Regarder ensemble : participants et dernière action annoncée. */
  together?: { names: string[]; notice?: string; at?: number };
  title?: string;
  sub?: string;
  /** Marqueurs d'intro et de générique, en secondes. */
  markers?: { type: string; start: number; end: number }[];
  hasNext?: boolean;
  /** Titre suivant pris dans la file d'attente (sinon : épisode suivant). */
  nextTitle?: string;
  hasPrev?: boolean;
  /** Distribution du titre, montrée à la pause. */
  cast?: { key?: string; name: string; role?: string; thumb?: string }[];
  /** Chercher à la pause qui est à l'écran. */
  xray?: boolean;
  /** Libellés Plex des pistes, dans l'ordre où mpv les numérote. */
  audioLabels?: string[];
  subLabels?: string[];
  /** Qualité en cours et choix proposés (« original » = fichier lu tel quel). */
  quality?: string;
  qualities?: { id: string; label: string }[];
  /** Pastilles du fichier : définition, plage dynamique, son. */
  tech?: { kind: string; label: string }[];
}

export type NativeCommand = 'toggle' | 'pause' | 'seek' | 'seekBy' | 'volume' | 'mute' | 'speed' | 'aid' | 'sid' | 'stats' | 'key' | 'audioDevice';
export type NativeEvent = 'state' | 'ended' | 'error' | 'next' | 'prev' | 'quality' | 'notice' | 'audioDevice';

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
  /** Application de bureau : télécharge le fichier d'un titre ; Windows demande où l'enregistrer. */
  /** Renvoie le numéro du téléchargement (0 = refusé). */
  download?(url: string, headers: Record<string, string>, name: string): Promise<number>;
  downloadAction?(id: number, action: 'cancel' | 'pause' | 'resume'): void;
  /** Bibliothèque hors ligne (application de bureau ; contrat que d'autres plateformes pourront remplir). */
  offline?: OfflineApi;
  showFile?(file: string): void;
  /** Envoi vers un téléviseur (Google Cast) ; absent hors de l'application de bureau. */
  cast?: CastApi;
  onDownload?(listener: (e: DownloadEvent) => void): () => void;
  /** « Qui est à l'écran ? » : ce que l'application fournit à la reconnaissance de visages. */
  xray?: {
    model(name: string): Promise<Uint8Array | null>;
    frame(): Promise<string | null>;
    photo(url: string): Promise<string | null>;
    run?(kind: 'who' | 'warm', cast: { key?: string; name: string; thumb?: string }[]): Promise<{ faces: number; onScreen: number[] } | null>;
    cancel?(): void;
  };
  xrayWorker?: {
    ready(): void;
    onJob(listener: (id: number, kind: 'who' | 'warm', cast: { key?: string; name: string; thumb?: string }[]) => void): () => void;
    onCancel(listener: () => void): () => void;
    result(id: number, result: unknown): void;
  };
  /** Aperçu en image à une position (secondes) ; null s'il n'y en a pas. */
  thumb?(time: number): Promise<string | null>;
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
  action(name: 'back' | 'cast' | 'fullscreen' | 'next' | 'prev' | `quality:${string}` | `person:${string}`): void;
}

/** Un titre gardé pour le hors ligne. */
export interface OfflineEntry {
  id: string;
  serverId: string;
  ratingKey: string;
  type: 'movie' | 'episode';
  title: string;
  sub: string;
  show?: { ratingKey: string; title: string };
  season?: number;
  episode?: number;
  /** Fiche du titre telle qu'au téléchargement (pistes, repères, résumé…). */
  meta: import('@multiplex/core').Metadata;
  /** Adresses file: des images enregistrées. */
  poster?: string;
  art?: string;
  subs: { file: string; label: string; index: number }[];
  state: 'downloading' | 'ready' | 'failed';
  size: number;
  addedAt: number;
  /** Position en millisecondes. */
  viewOffset: number;
  watched: boolean;
  /** Position ou état à renvoyer au serveur. */
  dirty: boolean;
  /** Le fichier a disparu du disque. */
  missing?: boolean;
}

export interface OfflineInfo {
  dir: string;
  free?: number;
  used: number;
  entries: OfflineEntry[];
}

export interface OfflineApi {
  info(): Promise<OfflineInfo>;
  chooseDir(): Promise<{ ok: boolean; error?: string }>;
  add(payload: {
    serverId: string;
    ratingKey: string;
    url: string;
    headers: Record<string, string>;
    fileName: string;
    title: string;
    sub: string;
    meta: import('@multiplex/core').Metadata;
    images: { kind: 'poster' | 'art'; url: string }[];
    subs: { url: string; label: string; ext: string }[];
  }): Promise<{ ok: boolean; id?: string; already?: boolean; error?: string }>;
  remove(id: string): Promise<boolean>;
  progress(id: string, viewOffset: number, watched: boolean): void;
  synced(ids: string[]): void;
  play(id: string, opts: Omit<NativePlayOptions, 'url' | 'headers' | 'subFiles'>): Promise<unknown>;
  onChanged(listener: () => void): () => void;
}

export interface DownloadEvent {
  id: number;
  /** waiting : emplacement pas encore choisi ; stalled : coupure, reprise possible. */
  state: 'waiting' | 'progressing' | 'paused' | 'stalled' | 'completed' | 'cancelled' | 'interrupted';
  name: string;
  received: number;
  total: number;
  /** Octets par seconde. */
  rate?: number;
  path?: string;
  /** Titre lisible (téléchargements hors ligne). */
  title?: string;
  offline?: boolean;
  offlineId?: string;
}

export const native = (window as unknown as { multiplexNative?: NativeApi }).multiplexNative;

/** Cette fenêtre est-elle la couche de contrôles posée par-dessus la vidéo ? */
export const isOverlayWindow = !!native && location.hash.startsWith('#/overlay');
/** Fenêtre invisible où tourne la reconnaissance de visages. */
export const isXrayWindow = !!native && location.hash.startsWith('#/xray-worker');

/** Vrai une fois confirmé que mpv est présent sur la machine. */
export const nativeAvailable = signal(false);

if (!isOverlayWindow && !isXrayWindow) {
  native
    ?.available()
    .then((ok) => (nativeAvailable.value = ok))
    .catch(() => {});
}

export interface CastDevice {
  id: string;
  name: string;
  model: string;
}

export interface CastStatus {
  state: 'connecting' | 'playing' | 'paused' | 'buffering' | 'idle' | 'closed';
  time: number;
  duration: number;
  volume: number;
  muted: boolean;
  ended?: boolean;
  error?: string;
  reason?: string;
  device: string;
}

export interface CastMedia {
  url: string;
  contentType: 'video/mp4' | 'application/x-mpegURL';
  title: string;
  sub?: string;
  kind: string;
  image?: string;
  start: number;
  duration: number;
}

export interface CastApi {
  /** Le navigateur affiche lui-même la liste des appareils (pas de recherche de notre côté). */
  browserPicker?: boolean;
  /** Vérification au démarrage (Android : services Google présents ou non). */
  available?(): Promise<boolean>;
  scan(): Promise<CastDevice[]>;
  start(deviceId: string, media: CastMedia): Promise<{ ok: boolean; error?: string }>;
  control(action: 'play' | 'pause' | 'seek' | 'volume' | 'mute', value?: number | boolean): void;
  stop(): Promise<boolean>;
  onStatus(listener: (s: CastStatus) => void): () => void;
}
