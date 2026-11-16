import type { ClientInfo, Media, Metadata, Part, PlaybackOptions, Stream } from './types';

export interface Quality {
  id: string;
  label: string;
  /** kbps ; absent = qualité d'origine. */
  bitrate?: number;
  resolution?: string;
}

export const QUALITIES: Quality[] = [
  { id: 'original', label: 'Original' },
  { id: '20000', label: '1080p · 20 Mbps', bitrate: 20000, resolution: '1920x1080' },
  { id: '12000', label: '1080p · 12 Mbps', bitrate: 12000, resolution: '1920x1080' },
  { id: '8000', label: '1080p · 8 Mbps', bitrate: 8000, resolution: '1920x1080' },
  { id: '4000', label: '720p · 4 Mbps', bitrate: 4000, resolution: '1280x720' },
  { id: '2000', label: '720p · 2 Mbps', bitrate: 2000, resolution: '1280x720' },
  { id: '1500', label: '480p · 1,5 Mbps', bitrate: 1500, resolution: '720x480' },
  { id: '720', label: '360p · 0,7 Mbps', bitrate: 720, resolution: '640x360' },
];

const CONTAINER_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  // Les navigateurs n'annoncent pas le Matroska mais Chromium le lit souvent :
  // on teste les codecs via MP4 et le lecteur bascule en transcodage sur erreur.
  mkv: 'video/mp4',
};

const AUDIO_CODEC: Record<string, string> = {
  aac: 'mp4a.40.2',
  mp3: 'mp4a.69',
  opus: 'opus',
  flac: 'flac',
  ac3: 'ac-3',
  eac3: 'ec-3',
};

const H264_PROFILE: Record<string, string> = {
  baseline: '42',
  'constrained baseline': '42',
  main: '4D',
  extended: '58',
  high: '64',
  'high 10': '6E',
  'high 4:2:2': '7A',
  'high 4:4:4 predictive': 'F4',
};

const TEXT_SUBS = ['srt', 'subrip', 'vtt', 'webvtt'];

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const dec2 = (n: number) => String(n).padStart(2, '0');

/**
 * Chaîne de codec RFC 6381 exacte (profil, niveau, profondeur) d'une piste
 * vidéo : c'est elle qui permet au navigateur de dire s'il sait vraiment la
 * décoder — un H.264 10 bits ou un HEVC Main 10 ne se traitent pas comme les
 * variantes 8 bits. Renvoie null pour les codecs qu'aucun navigateur ne lit.
 */
export function videoCodecString(codec: string | undefined, s: Stream = { id: 0, streamType: 1 }): string | null {
  const depth = s.bitDepth ?? (/10/.test(s.profile ?? '') ? 10 : 8);
  switch ((codec ?? '').toLowerCase()) {
    case 'h264': {
      const profile = H264_PROFILE[(s.profile ?? 'high').toLowerCase()] ?? (depth > 8 ? '6E' : '64');
      return `avc1.${profile}00${hex2(s.level ?? 40)}`;
    }
    case 'hevc':
    case 'h265':
      // Main 10 = profil 2 (compatibilité 4) ; Main = profil 1 (compatibilité 6).
      return `${depth > 8 ? 'hvc1.2.4' : 'hvc1.1.6'}.L${s.level ?? 120}.B0`;
    case 'vp9':
      return depth > 8 ? `vp09.02.${dec2(s.level ?? 51)}.${dec2(depth)}` : `vp09.00.${dec2(s.level ?? 40)}.08`;
    case 'av1':
      return `av01.0.${dec2(s.level ?? 12)}M.${dec2(depth)}`;
    default:
      return null;
  }
}

/** Type de plage dynamique d'une piste vidéo, pour l'affichage et les décisions. */
export function hdrKind(s: Stream | undefined): '' | 'HDR10' | 'HLG' | 'Dolby Vision' {
  if (!s) return '';
  if (s.DOVIPresent) return 'Dolby Vision';
  if (s.colorTrc === 'smpte2084') return 'HDR10';
  if (s.colorTrc === 'arib-std-b67') return 'HLG';
  return '';
}

/**
 * Dolby Vision sans couche de base compatible (profil 5) : un lecteur qui ne
 * décode pas le Dolby Vision affiche des couleurs fausses (image verte et
 * violette). Il faut alors laisser le serveur convertir l'image.
 */
export function needsDolbyVisionDecoder(s: Stream | undefined): boolean {
  return !!s?.DOVIPresent && (s.DOVIProfile === 5 || s.DOVIBLCompatID === 0);
}

export function streamsOf(part: Part | undefined, type: number): Stream[] {
  return (part?.Stream ?? []).filter((s) => s.streamType === type);
}

/** Type MIME complet à tester pour la lecture directe, ou null si inconnu. */
export function directPlayMime(media: Media, audioCodec = media.audioCodec): string | null {
  const part = media.Part[0];
  const mime = CONTAINER_MIME[(part?.container ?? media.container ?? '').toLowerCase()];
  const v = videoCodecString(media.videoCodec, streamsOf(part, 1)[0]);
  const a = audioCodec ? AUDIO_CODEC[audioCodec.toLowerCase()] : '';
  if (!mime || !v || a === undefined) return null;
  return `${mime}; codecs="${a ? `${v}, ${a}` : v}"`;
}

export interface Decision {
  mode: 'direct' | 'hls';
  reason: string;
  subtitle: 'none' | 'sidecar' | 'burn';
  subtitleStream?: Stream;
  /** Faux si la vidéo doit absolument être réencodée par le serveur (Dolby Vision profil 5). */
  keepVideo: boolean;
  media: Media;
  part: Part;
}

/** Décide entre lecture directe et passage par le serveur (HLS). Fonction pure. */
export function planPlayback(item: Metadata, opts: PlaybackOptions): Decision {
  const media = item.Media?.[opts.mediaIndex ?? 0] ?? item.Media?.[0];
  const part = media?.Part?.[0];
  if (!media || !part) throw new Error('Aucun fichier lisible pour cet élément');

  const subs = streamsOf(part, 3);
  const sub = opts.subtitleStreamId ? subs.find((s) => s.id === opts.subtitleStreamId) : undefined;
  const sidecar = !!sub?.key && TEXT_SUBS.includes((sub.codec ?? '').toLowerCase());
  const subtitle: Decision['subtitle'] = !sub ? 'none' : sidecar ? 'sidecar' : 'burn';
  const dolbyOnly = needsDolbyVisionDecoder(streamsOf(part, 1)[0]);

  const base = { media, part, subtitleStream: sub, keepVideo: !dolbyOnly };
  const hls = (reason: string): Decision => ({ ...base, mode: 'hls', reason, subtitle });

  if (opts.forceTranscode) return hls('conversion forcée');
  if (opts.quality !== 'original') return hls('qualité limitée');
  if (dolbyOnly) return hls('Dolby Vision sans couche HDR10');
  if (subtitle === 'burn') return hls('sous-titres intégrés au fichier');
  const audio = streamsOf(part, 2);
  if (opts.audioStreamId && audio.length > 1 && audio[0].id !== opts.audioStreamId) return hls('piste audio secondaire');
  // En lecture directe, le navigateur joue la première piste audio du fichier : c'est son codec qui compte.
  const audioCodec = audio[0]?.codec ?? media.audioCodec;
  const mime = directPlayMime(media, audioCodec);
  if (!mime) return hls(audioCodec && AUDIO_CODEC[audioCodec.toLowerCase()] === undefined ? `audio ${audioCodec.toUpperCase()} non lisible par le navigateur` : 'format non lisible par le navigateur');
  if (!opts.canPlay(mime)) return hls('codec non pris en charge par ce navigateur');
  return { ...base, mode: 'direct', reason: 'lecture directe', subtitle };
}

/**
 * Paramètres de l'URL de conversion universelle de Plex.
 *
 * Le client se présente sous son propre nom de plateforme : le serveur applique
 * alors son profil générique, que les directives ci-dessous complètent. Mesuré
 * sur un vrai serveur : se déclarer « Chrome » fait réencoder tout HEVC, alors
 * que ce profil obtient la copie de la vidéo d'origine (4K, HDR compris), la
 * seule conversion de l'audio, et les sous-titres texte livrés à part en WebVTT.
 *
 * `hevc` : proposer le HEVC comme cible, ce qui autorise sa copie sans réencodage.
 */
export function transcodeParams(
  item: Metadata,
  opts: PlaybackOptions,
  session: string,
  client: ClientInfo,
  hevc = false,
  legacy = false,
): Record<string, string | number> {
  const q = QUALITIES.find((x) => x.id === opts.quality);
  const profile = [
    `append-transcode-target-codec(type=videoProfile&context=streaming&videoCodec=${hevc && !legacy ? 'h264,hevc' : 'h264'}&audioCodec=aac&protocol=hls)`,
    ...(legacy ? [] : ['add-transcode-target(type=subtitleProfile&context=streaming&protocol=hls&container=webvtt&subtitleCodec=webvtt)']),
  ].join('+');
  const p: Record<string, string | number> = {
    hasMDE: 1,
    path: `/library/metadata/${item.ratingKey}`,
    mediaIndex: opts.mediaIndex ?? 0,
    partIndex: 0,
    protocol: 'hls',
    fastSeek: 1,
    directPlay: 0,
    directStream: q?.bitrate ? 0 : 1,
    directStreamAudio: 1,
    subtitleSize: 100,
    audioBoost: 100,
    location: 'lan',
    autoAdjustQuality: 0,
    mediaBufferSize: 102400,
    // « auto » : le serveur livre les sous-titres texte à part et n'incruste que les sous-titres image.
    subtitles: opts.subtitleStreamId ? (legacy ? 'burn' : 'auto') : 'none',
    session,
    'X-Plex-Session-Identifier': session,
    'X-Plex-Product': client.product,
    'X-Plex-Version': client.version,
    // Le serveur choisit son profil de base d'après ce couple plateforme / appareil et
    // répond 400 s'il n'en reconnaît aucun. « Windows » désigne son profil générique le
    // plus permissif ; nos directives le restreignent ensuite à ce que le navigateur
    // sait vraiment lire. `legacy` : ancien profil « Chrome », sûr mais qui réencode tout HEVC.
    'X-Plex-Platform': legacy ? 'Chrome' : client.product,
    'X-Plex-Device': legacy ? client.device : 'Windows',
    'X-Plex-Client-Profile-Extra': profile,
  };
  if (q?.bitrate) {
    p.maxVideoBitrate = q.bitrate;
    p.videoQuality = 100;
    if (q.resolution) p.videoResolution = q.resolution;
  }
  return p;
}

/** Convertit un fichier SRT en WebVTT (seul format lu par <track>). */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .trim();
  return body.startsWith('WEBVTT') ? body + '\n' : `WEBVTT\n\n${body}\n`;
}

/** Une caractéristique technique à afficher en pastille (image, plage dynamique, son). */
export interface TechBadge {
  kind: 'resolution' | 'video' | 'hdr' | 'audio' | 'channels';
  label: string;
}

const VIDEO_LABEL: Record<string, string> = { hevc: 'HEVC', h265: 'HEVC', h264: 'H.264', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2', vc1: 'VC-1', mpeg4: 'MPEG-4' };
const AUDIO_LABEL: Record<string, string> = { truehd: 'Dolby TrueHD', eac3: 'Dolby Digital+', ac3: 'Dolby Digital', dca: 'DTS', dts: 'DTS', aac: 'AAC', flac: 'FLAC', mp3: 'MP3', opus: 'Opus', pcm: 'PCM', alac: 'ALAC', vorbis: 'Vorbis' };

/** Nom courant d'un codec vidéo (« hevc » → « HEVC »), tel que les pastilles l'affichent. */
export function videoCodecLabel(codec: string | undefined): string | undefined {
  const c = (codec ?? '').toLowerCase();
  return c ? VIDEO_LABEL[c] ?? c.toUpperCase() : undefined;
}

/** Nom courant d'un codec audio (« eac3 » → « Dolby Digital+ »), tel que les pastilles l'affichent. */
export function audioCodecLabel(codec: string | undefined): string | undefined {
  const c = (codec ?? '').toLowerCase().replace(/-ma$/, '');
  return c ? AUDIO_LABEL[c] ?? c.toUpperCase() : undefined;
}

/**
 * Caractéristiques techniques d'un fichier, dans l'ordre d'affichage : définition,
 * codec vidéo, plage dynamique, format et canaux de la piste audio retenue.
 */
export function techBadges(media: Media | undefined): TechBadge[] {
  if (!media) return [];
  const part = media.Part?.[0];
  const out: TechBadge[] = [];
  const res = (media.videoResolution ?? '').toLowerCase();
  if (res) out.push({ kind: 'resolution', label: res === '4k' ? '4K' : /^\d+$/.test(res) ? `${res}p` : res.toUpperCase() });
  const vcodec = (media.videoCodec ?? '').toLowerCase();
  if (vcodec) out.push({ kind: 'video', label: VIDEO_LABEL[vcodec] ?? vcodec.toUpperCase() });
  const hdr = hdrKind(streamsOf(part, 1)[0]);
  if (hdr) out.push({ kind: 'hdr', label: hdr });

  const tracks = streamsOf(part, 2);
  const audio = tracks.find((s) => s.selected) ?? tracks[0];
  const acodec = (audio?.codec ?? media.audioCodec ?? '').toLowerCase().replace(/-ma$/, '');
  const title = `${audio?.extendedDisplayTitle ?? ''} ${audio?.displayTitle ?? ''} ${audio?.title ?? ''}`.toLowerCase();
  const profile = `${audio?.profile ?? ''} ${media.audioCodec ?? ''}`.toLowerCase();
  if (acodec) {
    let label = AUDIO_LABEL[acodec] ?? acodec.toUpperCase();
    if (acodec === 'dca' || acodec === 'dts') {
      if (/dts:x|dts-x/.test(title)) label = 'DTS:X';
      else if (/\bma\b|dts-hd ma/.test(profile + ' ' + title)) label = 'DTS-HD MA';
      else if (/hra|dts-hd/.test(profile + ' ' + title)) label = 'DTS-HD';
    }
    // L'Atmos voyage dans une piste TrueHD ou Dolby Digital+ ; seul l'intitulé de la piste le signale.
    if (/atmos/.test(title)) label = 'Dolby Atmos';
    out.push({ kind: 'audio', label });
  }
  const channels = audio?.channels ?? media.audioChannels;
  if (channels) out.push({ kind: 'channels', label: channels >= 8 ? '7.1' : channels >= 6 ? '5.1' : channels === 2 ? 'Stéréo' : channels === 1 ? 'Mono' : `${channels} canaux` });
  return out;
}
