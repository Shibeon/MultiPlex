/**
 * Modes audio du lecteur : « Mode nuit » (compression de la dynamique : scènes fortes moins
 * fortes, dialogues faibles plus audibles) et « Voix renforcées » (canal central relevé sur
 * une piste multicanal ; sur une piste stéréo ou mono, compression douce et présence).
 *
 * Ce module ne touche ni au DOM ni à Web Audio : il dit quoi construire. Le lecteur du
 * navigateur assemble les nœuds (apps/web/src/audiograph.ts) ; le lecteur natif (mpv)
 * a ses propres filtres, du même esprit (apps/desktop/audiomode.cjs).
 */

export type AudioMode = 'off' | 'night' | 'voice';

export const AUDIO_MODES: readonly AudioMode[] = ['off', 'night', 'voice'];

/** Un réglage enregistré ou importé n'est pas fiable : tout ce qui n'est pas un mode connu vaut « off ». */
export function audioModeOf(value: unknown): AudioMode {
  return AUDIO_MODES.includes(value as AudioMode) ? (value as AudioMode) : 'off';
}

/**
 * Lecteur natif : faut-il proposer les modes audio dans « Plus » ?
 *
 * Non quand le son part brut vers un ampli (formats `spdif-*` de mpv, réencodage Dolby
 * Digital compris) : aucun filtre ne peut s'y appliquer. Tant que mpv n'a pas encore dit ce
 * qu'il envoie, on suit le réglage « transmettre l'audio brut » : activé, le son partira
 * probablement brut, l'entrée reste cachée jusqu'à preuve du contraire.
 */
export function nativeAudioModeShown(o: { outFormat?: unknown; passthrough: boolean }): boolean {
  if (typeof o.outFormat === 'string' && o.outFormat) return !o.outFormat.startsWith('spdif');
  return !o.passthrough;
}

/** Compresseur, aux unités de DynamicsCompressorNode (dB, secondes). */
export interface CompressorStage {
  type: 'compressor';
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
}
/** Gain fixe, en dB. */
export interface GainStage {
  type: 'gain';
  db: number;
}
/** Égaliseur en cloche (BiquadFilterNode « peaking »). */
export interface PeakingStage {
  type: 'peaking';
  frequency: number;
  q: number;
  db: number;
}
/** Canal central (index 2 dans l'ordre Web Audio : L, R, C, LFE, …) relevé, les autres baissés. */
export interface CentreStage {
  type: 'centre';
  /** Nombre de canaux traités (6 pour 5.1, 8 pour 7.1). */
  channels: number;
  centreDb: number;
  othersDb: number;
}
export type AudioStage = CompressorStage | GainStage | PeakingStage | CentreStage;

/** Garde-fou contre la saturation après un gain : réagit très vite, au-dessus de −1 dBFS. */
export const LIMITER: CompressorStage = { type: 'compressor', threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.1 };

/**
 * Mode nuit. DynamicsCompressorNode ajoute de lui-même un gain de rattrapage (norme Web Audio,
 * environ +14 dB avec ces réglages, mesuré dans Chromium) : le gain négatif qui suit le ramène,
 * pour obtenir le même effet que le filtre de mpv. Mesuré dans Chromium : un passage à −40 dBFS
 * remonte d'environ 9 dB, un passage à −6 dBFS baisse d'environ 8 dB.
 */
export const NIGHT_STAGES: AudioStage[] = [
  { type: 'compressor', threshold: -30, knee: 6, ratio: 4, attack: 0.005, release: 0.3 },
  { type: 'gain', db: -5 },
  LIMITER,
];

/** Voix renforcées, piste multicanal : centre +3 dB, les autres −3 dB (6 dB d'écart). */
export const VOICE_CENTRE_DB = 3;
export const VOICE_OTHERS_DB = -3;

/**
 * Voix renforcées, stéréo ou mono : compression douce (rattrapage automatique compris, ramené
 * par le gain), puis présence vers 2,5 kHz.
 */
export const VOICE_STEREO_STAGES: AudioStage[] = [
  { type: 'compressor', threshold: -24, knee: 6, ratio: 2, attack: 0.01, release: 0.25 },
  { type: 'gain', db: -3 },
  { type: 'peaking', frequency: 2500, q: 1, db: 4 },
  LIMITER,
];

/**
 * Ce qu'il faut construire pour un mode, d'après le nombre de canaux de la piste
 * (inconnu : traité comme de la stéréo, ce qui convient à tout).
 */
export function webAudioStages(mode: AudioMode, channels?: number): AudioStage[] {
  if (mode === 'night') return NIGHT_STAGES;
  if (mode === 'voice') {
    if (channels && channels >= 6) return [{ type: 'centre', channels: channels >= 8 ? 8 : 6, centreDb: VOICE_CENTRE_DB, othersDb: VOICE_OTHERS_DB }, LIMITER];
    return VOICE_STEREO_STAGES;
  }
  return [];
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);

/**
 * Lecteur du navigateur : peut-on faire passer ce média par Web Audio sans risquer le
 * silence ? Un MediaElementAudioSourceNode branché sur un média d'une autre origine, chargé
 * sans CORS, ne rend que des zéros (et l'élément ne joue plus rien lui-même).
 * - `mse` : flux lu par hls.js (MediaSource, adresse blob: de la page) : sûr ;
 * - `native-hls` : HLS lu par le navigateur lui-même (Safari, iOS) : WebKit rend du silence
 *   avec Web Audio, quelle que soit l'origine : jamais ;
 * - `direct` : fichier lu tel quel : sûr s'il vient de la même origine que la page, ou si le
 *   serveur a répondu avec des en-têtes CORS (`cors` : vérifié avant de charger, l'élément
 *   étant alors chargé en `crossorigin="anonymous"`).
 */
export function webAudioSafe(o: { kind: 'mse' | 'native-hls' | 'direct'; url?: string; pageOrigin?: string; cors?: boolean }): boolean {
  if (o.kind === 'mse') return true;
  if (o.kind === 'native-hls') return false;
  if (o.cors) return true;
  if (!o.url || !o.pageOrigin) return false;
  try {
    const u = new URL(o.url, o.pageOrigin);
    return u.protocol === 'blob:' || u.origin === o.pageOrigin;
  } catch {
    return false;
  }
}
