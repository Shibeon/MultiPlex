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
export type AudioStage = CompressorStage | GainStage | PeakingStage;

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
 * Réduction d'une piste 6.1 (7 canaux) ou 7.1 (8 canaux) en 5.1, dans l'ordre des canaux que
 * livre le navigateur (vérifié dans Chromium : L, R, C, LFE, puis 6.1 : arrière centre, côté G,
 * côté D ; 7.1 : arrière G, arrière D, côté G, côté D). Une ligne par canal 5.1 (L, R, C, LFE,
 * SL, SR), une colonne par canal source. Sans elle, la sortie stéréo de Web Audio ne garde que
 * les deux premiers canaux d'une piste de plus de six canaux : plus de dialogues.
 */
const H = Math.SQRT1_2;
export const FOLD_TO_51: Record<7 | 8, number[][]> = {
  7: [
    [1, 0, 0, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 0, 0],
    [0, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 1, 0, 0, 0],
    [0, 0, 0, 0, H, 1, 0],
    [0, 0, 0, 0, H, 0, 1],
  ],
  8: [
    [1, 0, 0, 0, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 0, 0, 0],
    [0, 0, 1, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, H, 0, 1, 0],
    [0, 0, 0, 0, 0, H, 0, 1],
  ],
};

/**
 * Traitement d'une piste 5.1 par groupes, pour garder les six canaux : un compresseur Web Audio
 * ne traite que deux canaux et réduirait tout en stéréo. Avant, centre seul (les dialogues),
 * LFE seul (les explosions ne font pas baisser les voix), arrières.
 */
export const SURROUND_GROUPS: number[][] = [[0, 1], [2], [3], [4, 5]];

/**
 * Ce que le lecteur du navigateur construit pour un mode.
 * - `stereo` : piste stéréo, mono ou de canaux inconnus (ramenée à six canaux au plus, puis
 *   traitée d'un bloc ; le compresseur la réduit en stéréo) ;
 * - `surround` : piste annoncée 5.1 ou plus (6.1 et 7.1 d'abord réduites en 5.1, `fold`), gain
 *   par canal (`gains`, en dB), puis `stages` appliqués à chaque groupe : les six canaux restent.
 */
export type WebAudioPlan = { layout: 'stereo'; stages: AudioStage[] } | { layout: 'surround'; fold?: 7 | 8; gains: number[]; stages: AudioStage[] };

export function webAudioPlan(mode: AudioMode, channels?: number): WebAudioPlan | null {
  if (mode === 'off') return null;
  if (channels && channels >= 6) {
    const fold = channels >= 8 ? 8 : channels === 7 ? 7 : undefined;
    if (mode === 'night') return { layout: 'surround', fold, gains: [0, 0, 0, 0, 0, 0], stages: NIGHT_STAGES };
    return { layout: 'surround', fold, gains: [0, 1, 2, 3, 4, 5].map((i) => (i === 2 ? VOICE_CENTRE_DB : VOICE_OTHERS_DB)), stages: [LIMITER] };
  }
  return { layout: 'stereo', stages: mode === 'night' ? NIGHT_STAGES : VOICE_STEREO_STAGES };
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

export type MediaKind = 'mse' | 'native-hls' | 'direct';

/**
 * Lecteur du navigateur, au chargement d'un média : que faire de l'élément <video> ?
 * Rejouée après chaque attente (vérification CORS) avec l'état du moment : le mode a pu
 * changer, l'élément a pu être branché entre-temps.
 * - `swap` : l'élément est déjà branché sur Web Audio et ne doit plus l'être (mode désactivé,
 *   échec connu, média qui ne le permet pas) : en prendre un neuf ;
 * - `probe` : vérifier d'abord que le serveur répond en CORS ;
 * - `load` : charger, en `crossorigin` ou non, et brancher le mode (`route`) ou non. `safe` :
 *   le média peut-il passer par Web Audio (null : pas vérifié, faute d'en avoir eu besoin).
 */
export type AudioRouteDecision = { action: 'swap' } | { action: 'probe' } | { action: 'load'; crossOrigin: boolean; route: boolean; safe: boolean | null };

export function audioRouteDecision(o: { mode: AudioMode; kind: MediaKind; sameOrigin: boolean; claimed: boolean; blocked: boolean; cors?: boolean }): AudioRouteDecision {
  const on = o.mode !== 'off';
  const plain = (safe: boolean | null): AudioRouteDecision => (o.claimed ? { action: 'swap' } : { action: 'load', crossOrigin: false, route: false, safe });
  if (o.blocked) return plain(false);
  if (!on && o.claimed) return { action: 'swap' };
  if (o.kind === 'native-hls') return plain(false);
  if (o.kind === 'mse' || o.sameOrigin) return { action: 'load', crossOrigin: false, route: on, safe: true };
  // Fichier d'un autre serveur : vérifié seulement quand un mode le demande.
  if (!on) return { action: 'load', crossOrigin: false, route: false, safe: null };
  if (o.cors === undefined) return { action: 'probe' };
  return o.cors ? { action: 'load', crossOrigin: true, route: true, safe: true } : plain(false);
}

/** Un instant de lecture vu par le garde-fou (tous les quarts de seconde). */
export interface WatchSample {
  /** Secondes depuis l'échantillon précédent. */
  dt: number;
  /** La position avance (lecture réelle, non muette, volume non nul). */
  playing: boolean;
  /** L'élément doit jouer (ni en pause, ni fini), que sa position avance ou non. */
  wantsPlay: boolean;
  /** L'AudioContext tourne. */
  running: boolean;
  /** Le média a une piste audio (d'après le serveur). */
  hasAudio: boolean;
  /** Échantillons non nuls à l'entrée du graphe (ce que Web Audio reçoit). */
  tapLoud: boolean;
  /** Échantillons non nuls dans la copie de l'élément (captureStream) ; null : pas de copie. */
  refLoud: boolean | null;
  /** Piste traitée en 5.1 : centre et avant gauche non nuls. */
  centre?: { centreLoud: boolean; frontLoud: boolean };
}
export type WatchVerdict = 'ok' | 'no-signal' | 'silent' | 'suspended' | 'no-centre';

/**
 * Garde-fou du lecteur du navigateur : un mode ne doit jamais rendre la lecture muette.
 * - `suspended` : l'AudioContext ne tourne plus (application en arrière-plan, appel, mise en
 *   veille) alors que l'élément doit jouer (1,5 s) : sa sortie est muette, et Chromium fige même
 *   la vidéo (la position n'avance plus) ; on repasse sans Web Audio ;
 * - `no-signal` : Web Audio ne reçoit que des zéros alors que l'élément, lui, a du son (copie
 *   captureStream non nulle pendant 1 s) ; sans copie possible (Safari, Firefox), après 3 s de
 *   zéros continus sur un média qui a une piste audio, tant que rien n'a été entendu ;
 * - `silent` : copie et Web Audio muets tous deux depuis le début, 10 s de lecture d'un média
 *   qui a une piste audio : probablement une ouverture silencieuse, peut-être une copie qui ne
 *   marche pas. Sans certitude, on repasse sans Web Audio pour ce titre seulement ;
 * - `no-centre` : piste traitée en 5.1 dont le centre reste muet pendant 30 s alors que l'avant
 *   ne l'est pas (le navigateur l'a réduite en stéréo) : passer au traitement stéréo.
 * Lecture en pause, muette ou au volume nul : rien n'est compté.
 */
export class AudioWatch {
  private suspendedFor = 0;
  private mismatchFor = 0;
  private zerosFor = 0;
  private heard = false;
  private noCentreFor = 0;
  constructor(private readonly limits = { suspended: 1.5, mismatch: 1, zeros: 3, bothSilent: 10, noCentre: 30 }) {}

  /** Nouveau média sur le même élément. */
  reset(): void {
    this.suspendedFor = this.mismatchFor = this.zerosFor = this.noCentreFor = 0;
    this.heard = false;
  }

  tick(s: WatchSample): WatchVerdict {
    if (!s.running) {
      if (!s.wantsPlay) return 'ok';
      this.suspendedFor += s.dt;
      return this.suspendedFor >= this.limits.suspended ? 'suspended' : 'ok';
    }
    this.suspendedFor = 0;
    if (!s.playing) return 'ok';
    if (!s.hasAudio) return 'ok';
    if (s.refLoud) this.heard = true;
    if (s.tapLoud) {
      this.heard = true;
      this.mismatchFor = this.zerosFor = 0;
    } else if (s.refLoud === true) {
      if ((this.mismatchFor += s.dt) >= this.limits.mismatch) return 'no-signal';
    } else this.mismatchFor = 0;
    if (!s.tapLoud && s.refLoud !== true && !this.heard) {
      this.zerosFor += s.dt;
      if (s.refLoud === null && this.zerosFor >= this.limits.zeros) return 'no-signal';
      if (s.refLoud === false && this.zerosFor >= this.limits.bothSilent) return 'silent';
    }
    if (s.centre) {
      if (s.centre.centreLoud) this.noCentreFor = 0;
      else if (s.centre.frontLoud && (this.noCentreFor += s.dt) >= this.limits.noCentre) {
        this.noCentreFor = 0;
        return 'no-centre';
      }
    }
    return 'ok';
  }
}
