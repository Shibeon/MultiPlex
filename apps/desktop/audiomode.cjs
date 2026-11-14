// Modes audio du lecteur natif : chaîne de filtres mpv (propriété `af`), avec les filtres
// lavfi de FFmpeg. Même esprit que le lecteur du navigateur (packages/core/src/audio.ts).
//
// - « Mode nuit » : acompressor (seuil −30 dBFS, rapport 4:1, gain de rattrapage ×3 ≈ +9,5 dB),
//   les scènes fortes baissent, les dialogues faibles remontent. Mesuré avec mpv 0.37 / FFmpeg
//   6.1 : un passage à −40 dBFS remonte de 9,5 dB, un passage à −6 dBFS baisse de 8 dB.
// - « Voix renforcées », piste multicanal avec un canal central : pan, centre +3 dB et autres
//   canaux −3 dB, disposition d'origine conservée (mpv réduit ensuite en stéréo si la sortie
//   l'exige, le centre relevé y reste) ; piste stéréo ou mono : compression douce et
//   présence (+4 dB vers 2,5 kHz).
// - Après tout gain, un second acompressor très rapide sert de limiteur (au-dessus de −1 dBFS).
//
// Uniquement des filtres et options présents depuis longtemps dans FFmpeg (acompressor, pan,
// equalizer), pour qu'un mpv du système, plus ancien que celui embarqué, les accepte aussi.

const MODES = ['off', 'night', 'voice'];
const modeOf = (v) => (MODES.includes(v) ? v : 'off');

const LIMITER = 'acompressor=threshold=0.891:ratio=20:attack=0.1:release=100:knee=1:link=maximum:detection=peak';
const NIGHT = 'acompressor=threshold=0.0316:ratio=4:attack=5:release=300:makeup=3:knee=2.83:link=maximum:detection=rms';
const VOICE_STEREO = 'acompressor=threshold=0.063:ratio=2:attack=10:release=250:makeup=1.5:knee=2.83:link=maximum:detection=rms,equalizer=f=2500:t=q:w=1:g=4';
const CENTRE_GAIN = '1.413'; // +3 dB
const OTHERS_GAIN = '0.708'; // −3 dB

/** Dispositions standard de FFmpeg (ffmpeg -layouts) qui ont un canal central, avec leurs canaux. */
const LAYOUTS = {
  '3.0': 'FL+FR+FC',
  '3.1': 'FL+FR+FC+LFE',
  '4.0': 'FL+FR+FC+BC',
  '4.1': 'FL+FR+FC+LFE+BC',
  '5.0': 'FL+FR+FC+BL+BR',
  '5.0(side)': 'FL+FR+FC+SL+SR',
  '5.1': 'FL+FR+FC+LFE+BL+BR',
  '5.1(side)': 'FL+FR+FC+LFE+SL+SR',
  '6.0': 'FL+FR+FC+BC+SL+SR',
  '6.1': 'FL+FR+FC+LFE+BC+SL+SR',
  '6.1(back)': 'FL+FR+FC+LFE+BL+BR+BC',
  hexagonal: 'FL+FR+FC+BL+BR+BC',
  '7.0': 'FL+FR+FC+BL+BR+SL+SR',
  '7.0(front)': 'FL+FR+FC+FLC+FRC+SL+SR',
  '7.1': 'FL+FR+FC+LFE+BL+BR+SL+SR',
  '7.1(wide)': 'FL+FR+FC+LFE+BL+BR+FLC+FRC',
  '7.1(wide-side)': 'FL+FR+FC+LFE+FLC+FRC+SL+SR',
  octagonal: 'FL+FR+FC+BL+BR+BC+SL+SR',
};
/** Noms de canaux que pan comprend (ceux de FFmpeg, en majuscules). */
const SPEAKERS = new Set(['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'FLC', 'FRC', 'BC', 'SL', 'SR', 'TC', 'TFL', 'TFC', 'TFR', 'TBL', 'TBC', 'TBR', 'LFE2', 'TSL', 'TSR', 'BFC', 'BFL', 'BFR', 'WL', 'WR', 'SDL', 'SDR']);

/**
 * Canaux d'une disposition telle que mpv la nomme (`audio-params/channels`) : un nom standard
 * (« 5.1(side) ») ou, pour une disposition inhabituelle, la liste « fl-fr-fc-lfe-… ».
 * Rien si elle n'est pas reconnue.
 */
function channelsOf(layout) {
  if (typeof layout !== 'string') return null;
  if (LAYOUTS[layout]) return { spec: layout, names: LAYOUTS[layout].split('+') };
  if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(layout)) return null;
  const names = layout.toUpperCase().split('-');
  if (!names.every((n) => SPEAKERS.has(n)) || new Set(names).size !== names.length) return null;
  return { spec: names.join('+'), names };
}

/**
 * Centre relevé, les autres canaux baissés, même disposition en sortie. Rien sans canal central.
 * L'entrée est d'abord mise à cette disposition (aformat) : après un changement de piste (5.1
 * vers stéréo), la chaîne en place reste valable le temps que syncAf la remplace, au lieu que
 * pan refuse une entrée sans canal central et coupe le son.
 */
function centreBoost(layout) {
  const ch = channelsOf(layout);
  if (!ch || ch.names.length < 3 || !ch.names.includes('FC')) return null;
  return `aformat=channel_layouts=${ch.spec},pan=${ch.spec}|${ch.names.map((n) => `${n}=${n === 'FC' ? CENTRE_GAIN : OTHERS_GAIN}*${n}`).join('|')}`;
}

/**
 * Filtre mpv d'un mode, pour une piste de cette disposition ; '' pour « off ».
 * `lavfi=[…]` : graphe FFmpeg, les virgules y séparent les filtres.
 */
function modeFilter(mode, layout) {
  switch (modeOf(mode)) {
    case 'night':
      return `lavfi=[${NIGHT},${LIMITER}]`;
    case 'voice':
      return `lavfi=[${centreBoost(layout) ?? VOICE_STEREO},${LIMITER}]`;
    default:
      return '';
  }
}

/**
 * Valeur complète de la propriété `af`. Le réencodage Dolby Digital (`ac3`), quand il est
 * actif, envoie un flux brut à l'ampli : comme pour la transmission du son d'origine, le mode
 * audio n'y est pas appliqué (il reste enregistré, et revient dès que le son repasse décodé).
 * Sinon : le filtre du mode, sauf si mpv l'a refusé pour ce fichier (`failed`).
 */
function afChain({ mode, layout, passthrough, failed, ac3 }) {
  if (ac3) return ac3;
  if (passthrough || failed) return '';
  return modeFilter(mode, layout);
}

module.exports = { MODES, modeOf, channelsOf, centreBoost, modeFilter, afChain };
