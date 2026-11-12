/** Identité du client envoyée à Plex (X-Plex-*). */
export interface ClientInfo {
  clientId: string;
  product: string;
  version: string;
  platform: string;
  device: string;
  deviceName: string;
}

export interface PlexUser {
  id: number;
  uuid: string;
  username: string;
  title: string;
  thumb?: string;
}

export interface PlexPin {
  id: number;
  code: string;
}

export interface PlexConnection {
  uri: string;
  local: boolean;
  relay: boolean;
  protocol: string;
  address: string;
  port: number;
}

export interface PlexResource {
  name: string;
  clientIdentifier: string;
  provides: string;
  accessToken: string;
  owned: boolean;
  connections: PlexConnection[];
}

export interface Library {
  key: string;
  title: string;
  type: string;
}

/** streamType : 1 = vidéo, 2 = audio, 3 = sous-titres. */
export interface Stream {
  id: number;
  streamType: number;
  codec?: string;
  language?: string;
  languageCode?: string;
  displayTitle?: string;
  extendedDisplayTitle?: string;
  title?: string;
  selected?: boolean;
  /** Présent uniquement pour les flux externes (fichiers annexes). */
  key?: string;
  forced?: boolean;
  profile?: string;
  level?: number;
  bitDepth?: number;
  bitrate?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  channels?: number;
  audioChannelLayout?: string;
  /** Caractéristique de transfert : smpte2084 = HDR10, arib-std-b67 = HLG. */
  colorTrc?: string;
  colorPrimaries?: string;
  DOVIPresent?: boolean;
  DOVIProfile?: number;
  /** 0 = pas de couche de base lisible sans décodeur Dolby Vision. */
  DOVIBLCompatID?: number;
}

export interface Chapter {
  index?: number;
  tag?: string;
  startTimeOffset: number;
  endTimeOffset: number;
}

export interface Part {
  id: number;
  key: string;
  container?: string;
  /** Chemin du fichier sur le serveur. */
  file?: string;
  /** Taille en octets. */
  size?: number;
  Stream?: Stream[];
}

export interface Media {
  id: number;
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  videoResolution?: string;
  width?: number;
  height?: number;
  videoFrameRate?: string;
  bitrate?: number;
  audioChannels?: number;
  Part: Part[];
}

export interface Marker {
  type: string;
  startTimeOffset: number;
  endTimeOffset: number;
}

export interface Tag {
  tag: string;
  /** Numéro sur le serveur ; dans le catalogue Plex, l'identifiant de la personne. */
  id?: number | string;
  /** Identifiant de la personne, commun au serveur et au catalogue Plex. */
  tagKey?: string;
  /** Rôle joué (acteurs). */
  role?: string;
  thumb?: string;
}

export interface Metadata {
  ratingKey: string;
  key?: string;
  /** Identifiant Plex universel (`plex://movie/…`), commun au serveur et au catalogue en ligne. */
  guid?: string;
  /** Images d'un titre du catalogue en ligne (affiche, fond…). */
  Image?: { type: string; url: string }[];
  type: string;
  title: string;
  summary?: string;
  year?: number;
  thumb?: string;
  art?: string;
  duration?: number;
  viewOffset?: number;
  viewCount?: number;
  leafCount?: number;
  viewedLeafCount?: number;
  index?: number;
  parentIndex?: number;
  parentRatingKey?: string;
  parentTitle?: string;
  parentThumb?: string;
  grandparentRatingKey?: string;
  grandparentTitle?: string;
  grandparentThumb?: string;
  /** Identifiant Plex universel de la série (épisodes). */
  grandparentGuid?: string;
  contentRating?: string;
  rating?: number;
  audienceRating?: number;
  /** Origine des deux notes ci-dessus (« imdb://image.rating », « rottentomatoes://image.rating.ripe »…). */
  ratingImage?: string;
  audienceRatingImage?: string;
  /** Toutes les notes connues : IMDb, Rotten Tomatoes (critique et public), TMDB. */
  Rating?: { image?: string; value?: number; type?: string }[];
  /** Note donnée par l'utilisateur, sur 10. */
  userRating?: number;
  studio?: string;
  tagline?: string;
  originallyAvailableAt?: string;
  Media?: Media[];
  Marker?: Marker[];
  /** Identifiants externes (« imdb://tt… », « tmdb://… »). */
  Guid?: { id: string }[];
  Chapter?: Chapter[];
  Genre?: Tag[];
  Role?: Tag[];
  Director?: Tag[];
  Writer?: Tag[];
  Producer?: Tag[];
  /** Listes de lecture : nombre d'éléments, liste « intelligente ». */
  smart?: boolean | number;
  playlistType?: string;
  /** Mosaïque d'affiches d'une liste de lecture. */
  composite?: string;
  /** Date de mise à jour (secondes), sert aussi pour les liens de téléchargement. */
  updatedAt?: number;
  addedAt?: number;
}

export interface Hub {
  hubIdentifier: string;
  title: string;
  type: string;
  Metadata?: Metadata[];
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
}

export interface ItemsQuery {
  type?: number;
  sort?: string;
  offset: number;
  limit: number;
  filter?: Record<string, string | number>;
}

export interface PlaybackOptions {
  /** Identifiant d'un préréglage de QUALITIES. */
  quality: string;
  forceTranscode?: boolean;
  audioStreamId?: number;
  /** 0 ou undefined = pas de sous-titres. */
  subtitleStreamId?: number;
  /** Fourni par la plateforme : indique si un type MIME (avec codecs) est lisible. */
  canPlay: (mime: string) => boolean;
  /** Le navigateur sait décoder le HEVC : le serveur peut alors le copier tel quel dans le flux. */
  hevc?: boolean;
  /** Version du fichier à lire quand l'élément en a plusieurs (index dans Media). */
  mediaIndex?: number;
}

export interface PlaybackPlan {
  mode: 'direct' | 'hls';
  url: string;
  session: string;
  /** Pourquoi ce mode a été retenu (affiché dans le lecteur). */
  reason: string;
  /** 'segmented' : sous-titres livrés dans le flux HLS en WebVTT, sans toucher à la vidéo. */
  subtitle: 'none' | 'sidecar' | 'burn' | 'segmented';
  subtitleUrl?: string;
  /** Ce que le serveur fait de la vidéo et de l'audio (absent en lecture directe). */
  video?: 'copy' | 'transcode';
  audio?: 'copy' | 'transcode';
}

export interface TimelineReport {
  ratingKey: string;
  state: 'playing' | 'paused' | 'stopped' | 'buffering';
  timeMs: number;
  durationMs: number;
  session: string;
}

/** Une lecture en cours sur le serveur (celle d'un ami ou la vôtre). */
export interface ActiveSession {
  id: string;
  user: string;
  userThumb?: string;
  state: 'playing' | 'paused' | 'buffering' | string;
  /** Nom de l'appareil ou de l'application de lecture. */
  player: string;
  platform?: string;
  transcoding: boolean;
  /** L'élément lu ; viewOffset y donne la position actuelle. */
  item: Metadata;
}

/**
 * Contrat qu'implémente toute source de médias (serveur Plex, mode démo,
 * et demain d'autres backends). L'interface utilisateur ne dépend que de lui.
 */
export interface MediaServer {
  readonly id: string;
  readonly name: string;
  libraries(): Promise<Library[]>;
  hubs(sectionId?: string): Promise<Hub[]>;
  items(sectionId: string, query: ItemsQuery): Promise<Page<Metadata>>;
  metadata(ratingKey: string): Promise<Metadata>;
  /** Élément du serveur correspondant à un identifiant Plex universel, s'il existe. */
  findByGuid(guid: string): Promise<Metadata | undefined>;
  children(ratingKey: string): Promise<Metadata[]>;
  search(query: string, limit?: number): Promise<Hub[]>;
  image(path: string | undefined, width: number, height: number): string;
  /**
   * Accès à un fichier du serveur (clé d'une partie ou d'un sous-titre externe) pour
   * un lecteur natif. Le jeton voyage dans un en-tête, jamais dans l'adresse : celle-ci
   * s'affiche à l'écran (statistiques du lecteur) et dans la liste des processus.
   */
  fileRequest(path: string): { url: string; headers: Record<string, string> };
  playback(item: Metadata, opts: PlaybackOptions): Promise<PlaybackPlan>;
  stopTranscode(session: string): Promise<void>;
  selectStreams(partId: number, sel: { audioStreamID?: number; subtitleStreamID?: number }): Promise<void>;
  timeline(report: TimelineReport): Promise<void>;
  scrobble(ratingKey: string, watched: boolean): Promise<void>;
  /** Films et séries du serveur où apparaît une personne (identifiant `tagKey`). */
  personMedia(key: string): Promise<Metadata[]>;
  /** Note personnelle sur 10 ; null pour la retirer. */
  rate(ratingKey: string, rating: number | null): Promise<void>;
  /** Bande-annonce d'un film ou d'une série (ratingKey du clip), s'il y en a une. */
  trailer(ratingKey: string): Promise<string | undefined>;
  /** Titres de « Continuer à regarder », tels que le serveur les propose. */
  continueWatching(): Promise<Metadata[]>;
  /** Rangées « associés » d'un film ou d'une série (similaires, plus avec tel acteur…), titrées dans la langue demandée. */
  related(ratingKey: string, lang?: string): Promise<Hub[]>;
  /** Retire un titre de « Continuer à regarder » sans toucher à son état vu / non vu. */
  removeFromContinueWatching(ratingKey: string): Promise<void>;
  /**
   * Adresse à confier à un autre appareil (téléviseur) : le jeton du compte y est remplacé par
   * un jeton temporaire délivré par le serveur, valable seulement pour lui.
   */
  forDevice(url: string): Promise<string>;
  /** Listes de lecture vidéo de l'utilisateur (hors listes intelligentes). */
  playlists(): Promise<Metadata[]>;
  playlistItems(playlistId: string): Promise<Metadata[]>;
  /** Ajoute un élément à une liste existante, ou en crée une (`playlistId` null) portant `title`. */
  addToPlaylist(playlistId: string | null, ratingKey: string, title?: string): Promise<void>;
  /** Lectures en cours. Réservé au propriétaire du serveur : sinon l'appel échoue en 401/403. */
  sessions(): Promise<ActiveSession[]>;
}
