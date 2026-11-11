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

const VIDEO_CODEC: Record<string, string> = {
  h264: 'avc1.640028',
  hevc: 'hvc1.1.6.L120.90',
  h265: 'hvc1.1.6.L120.90',
  vp9: 'vp09.00.40.08',
  av1: 'av01.0.08M.08',
};

const AUDIO_CODEC: Record<string, string> = {
  aac: 'mp4a.40.2',
  mp3: 'mp4a.69',
  opus: 'opus',
  flac: 'flac',
  ac3: 'ac-3',
  eac3: 'ec-3',
};

const TEXT_SUBS = ['srt', 'subrip', 'vtt', 'webvtt'];

/** Type MIME complet à tester pour la lecture directe, ou null si inconnu. */
export function directPlayMime(media: Media): string | null {
  const container = (media.Part[0]?.container ?? media.container ?? '').toLowerCase();
  const mime = CONTAINER_MIME[container];
  const v = VIDEO_CODEC[(media.videoCodec ?? '').toLowerCase()];
  const a = media.audioCodec ? AUDIO_CODEC[media.audioCodec.toLowerCase()] : '';
  if (!mime || !v || a === undefined) return null;
  return `${mime}; codecs="${a ? `${v}, ${a}` : v}"`;
}

export function streamsOf(part: Part | undefined, type: number): Stream[] {
  return (part?.Stream ?? []).filter((s) => s.streamType === type);
}

export interface Decision {
  mode: 'direct' | 'hls';
  reason: string;
  subtitle: 'none' | 'sidecar' | 'burn';
  subtitleStream?: Stream;
  media: Media;
  part: Part;
}

/** Décide entre lecture directe et transcodage HLS. Fonction pure. */
export function planPlayback(item: Metadata, opts: PlaybackOptions): Decision {
  const media = item.Media?.[0];
  const part = media?.Part?.[0];
  if (!media || !part) throw new Error('Aucun fichier lisible pour cet élément');

  const subs = streamsOf(part, 3);
  const sub = opts.subtitleStreamId ? subs.find((s) => s.id === opts.subtitleStreamId) : undefined;
  const sidecar = !!sub?.key && TEXT_SUBS.includes((sub.codec ?? '').toLowerCase());
  const subtitle: Decision['subtitle'] = !sub ? 'none' : sidecar ? 'sidecar' : 'burn';

  const base = { media, part, subtitleStream: sub };
  const hls = (reason: string, s = subtitle): Decision => ({ ...base, mode: 'hls', reason, subtitle: s });

  if (opts.forceTranscode) return hls('transcodage forcé');
  if (opts.quality !== 'original') return hls('qualité limitée');
  if (subtitle === 'burn') return hls('sous-titres incrustés');
  const audio = streamsOf(part, 2);
  if (opts.audioStreamId && audio.length > 1 && audio[0].id !== opts.audioStreamId) return hls('piste audio secondaire');
  const mime = directPlayMime(media);
  if (!mime) return hls('format inconnu du navigateur');
  if (!opts.canPlay(mime)) return hls('codec non pris en charge');
  return { ...base, mode: 'direct', reason: 'lecture directe', subtitle };
}

/** Paramètres de l'URL de transcodage universel de Plex. */
export function transcodeParams(
  item: Metadata,
  opts: PlaybackOptions,
  session: string,
  client: ClientInfo,
): Record<string, string | number> {
  const q = QUALITIES.find((x) => x.id === opts.quality);
  const p: Record<string, string | number> = {
    hasMDE: 1,
    path: `/library/metadata/${item.ratingKey}`,
    mediaIndex: 0,
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
    subtitles: opts.subtitleStreamId ? 'burn' : 'none',
    session,
    'X-Plex-Session-Identifier': session,
    'X-Plex-Product': client.product,
    'X-Plex-Version': client.version,
    'X-Plex-Platform': opts.platform ?? 'Chrome',
    'X-Plex-Device': client.device,
    'X-Plex-Client-Profile-Extra':
      'append-transcode-target-codec(type=videoProfile&context=streaming&videoCodec=h264&audioCodec=aac&protocol=hls)',
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
