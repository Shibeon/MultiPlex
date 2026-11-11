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
}

export interface Part {
  id: number;
  key: string;
  container?: string;
  Stream?: Stream[];
}

export interface Media {
  id: number;
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  videoResolution?: string;
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
}

export interface Metadata {
  ratingKey: string;
  key?: string;
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
  contentRating?: string;
  rating?: number;
  audienceRating?: number;
  studio?: string;
  tagline?: string;
  originallyAvailableAt?: string;
  Media?: Media[];
  Marker?: Marker[];
  Genre?: Tag[];
  Role?: Tag[];
  Director?: Tag[];
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
  /** Nom de plateforme pour le profil de transcodage (Chrome, Safari, Firefox…). */
  platform?: string;
}

export interface PlaybackPlan {
  mode: 'direct' | 'hls';
  url: string;
  session: string;
  /** Pourquoi ce mode a été retenu (affiché dans le lecteur). */
  reason: string;
  subtitle: 'none' | 'sidecar' | 'burn';
  subtitleUrl?: string;
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
  children(ratingKey: string): Promise<Metadata[]>;
  search(query: string, limit?: number): Promise<Hub[]>;
  image(path: string | undefined, width: number, height: number): string;
  playback(item: Metadata, opts: PlaybackOptions): Promise<PlaybackPlan>;
  stopTranscode(session: string): Promise<void>;
  selectStreams(partId: number, sel: { audioStreamID?: number; subtitleStreamID?: number }): Promise<void>;
  timeline(report: TimelineReport): Promise<void>;
  scrobble(ratingKey: string, watched: boolean): Promise<void>;
  /** Lectures en cours. Réservé au propriétaire du serveur : sinon l'appel échoue en 401/403. */
  sessions(): Promise<ActiveSession[]>;
}
