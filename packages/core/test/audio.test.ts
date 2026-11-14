import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_MODES, AudioWatch, FOLD_TO_51, LIMITER, NIGHT_STAGES, SURROUND_GROUPS, VOICE_STEREO_STAGES, audioModeOf, audioRouteDecision, dbToGain, nativeAudioModeShown, webAudioPlan, webAudioSafe, type WatchSample } from '../src';

// Filtres du lecteur natif : module CommonJS de l'application de bureau (lu tel quel par Electron).
const require = createRequire(import.meta.url);
const mpv = require('../../../apps/desktop/audiomode.cjs') as {
  MODES: string[];
  modeOf(v: unknown): string;
  channelsOf(layout: unknown): { spec: string; names: string[] } | null;
  centreBoost(layout: unknown): string | null;
  modeFilter(mode: unknown, layout?: unknown): string;
  afChain(o: { mode: unknown; layout?: unknown; passthrough?: boolean; failed?: boolean; ac3?: string }): string;
};

const LIMIT = 'acompressor=threshold=0.891:ratio=20:attack=0.1:release=100:knee=1:link=maximum:detection=peak';
const AC3 = 'lavcac3enc=tospdif=yes:bitrate=640:minch=3';

describe('modes audio : réglage', () => {
  it('ne retient que les modes connus, « off » par défaut', () => {
    expect(AUDIO_MODES).toEqual(['off', 'night', 'voice']);
    expect(audioModeOf('night')).toBe('night');
    expect(audioModeOf('voice')).toBe('voice');
    for (const bad of [undefined, null, '', 'NIGHT', 'loud', 1, {}, ['night']]) expect(audioModeOf(bad)).toBe('off');
    // Même liste des deux côtés.
    expect(mpv.MODES).toEqual([...AUDIO_MODES]);
    expect(mpv.modeOf('voice')).toBe('voice');
    expect(mpv.modeOf('autre')).toBe('off');
  });
});

describe('modes audio : entrée du menu « Plus » du lecteur natif', () => {
  it('cachée quand le son part brut vers un ampli, quel que soit le réglage enregistré', () => {
    for (const f of ['spdif-ac3', 'spdif-eac3', 'spdif-truehd', 'spdif-dts', 'spdif-dtshd']) {
      expect(nativeAudioModeShown({ outFormat: f, passthrough: true })).toBe(false);
      expect(nativeAudioModeShown({ outFormat: f, passthrough: false })).toBe(false);
    }
  });

  it('visible quand le son est décodé (PCM), même avec la transmission activée (repli décodé, piste stéréo)', () => {
    for (const f of ['floatp', 's16', 's32', 'double']) {
      expect(nativeAudioModeShown({ outFormat: f, passthrough: true })).toBe(true);
      expect(nativeAudioModeShown({ outFormat: f, passthrough: false })).toBe(true);
    }
  });

  it('avant que mpv ne dise ce qu’il envoie : suit le réglage de transmission', () => {
    expect(nativeAudioModeShown({ outFormat: undefined, passthrough: false })).toBe(true);
    expect(nativeAudioModeShown({ outFormat: '', passthrough: false })).toBe(true);
    expect(nativeAudioModeShown({ outFormat: undefined, passthrough: true })).toBe(false);
  });

  it('apparaît et disparaît quand la transmission change en cours de lecture', () => {
    // Suite d'états réelle : son brut, repli en PCM (ampli qui refuse), puis retour au brut.
    const seq = ['spdif-eac3', 'floatp', 'spdif-ac3'].map((f) => nativeAudioModeShown({ outFormat: f, passthrough: true }));
    expect(seq).toEqual([false, true, false]);
  });
});

describe('modes audio : filtres mpv', () => {
  it('« off » : aucun filtre', () => {
    expect(mpv.modeFilter('off', '5.1')).toBe('');
    expect(mpv.modeFilter('bogus', '5.1')).toBe('');
  });

  it('mode nuit : compresseur puis limiteur, quelle que soit la disposition', () => {
    const night = `lavfi=[acompressor=threshold=0.0316:ratio=4:attack=5:release=300:makeup=3:knee=2.83:link=maximum:detection=rms,${LIMIT}]`;
    for (const l of ['mono', 'stereo', '5.1(side)', '7.1', undefined]) expect(mpv.modeFilter('night', l)).toBe(night);
  });

  it('voix : centre relevé sur les dispositions qui en ont un, en gardant la disposition', () => {
    expect(mpv.modeFilter('voice', '5.1(side)')).toBe(`lavfi=[aformat=channel_layouts=5.1(side),pan=5.1(side)|FL=0.708*FL|FR=0.708*FR|FC=1.413*FC|LFE=0.708*LFE|SL=0.708*SL|SR=0.708*SR,${LIMIT}]`);
    expect(mpv.centreBoost('5.1')).toBe('aformat=channel_layouts=5.1,pan=5.1|FL=0.708*FL|FR=0.708*FR|FC=1.413*FC|LFE=0.708*LFE|BL=0.708*BL|BR=0.708*BR');
    expect(mpv.centreBoost('7.1')).toBe('aformat=channel_layouts=7.1,pan=7.1|FL=0.708*FL|FR=0.708*FR|FC=1.413*FC|LFE=0.708*LFE|BL=0.708*BL|BR=0.708*BR|SL=0.708*SL|SR=0.708*SR');
    // Disposition inhabituelle, nommée canal par canal par mpv.
    expect(mpv.centreBoost('fl-fr-fc-lfe-sl-sr')).toBe('aformat=channel_layouts=FL+FR+FC+LFE+SL+SR,pan=FL+FR+FC+LFE+SL+SR|FL=0.708*FL|FR=0.708*FR|FC=1.413*FC|LFE=0.708*LFE|SL=0.708*SL|SR=0.708*SR');
  });

  it('voix : stéréo, mono, sans centre ou inconnue → compression douce et présence', () => {
    const soft = `lavfi=[acompressor=threshold=0.063:ratio=2:attack=10:release=250:makeup=1.5:knee=2.83:link=maximum:detection=rms,equalizer=f=2500:t=q:w=1:g=4,${LIMIT}]`;
    for (const l of ['stereo', 'mono', 'quad', '6.0(front)', 'fl-fr-xx', 'fl-fr-fr', '5.1;rm -rf', undefined, 42]) {
      expect(mpv.centreBoost(l)).toBeNull();
      expect(mpv.modeFilter('voice', l)).toBe(soft);
    }
  });

  it('noms de canaux : seulement ceux de FFmpeg, sans doublon', () => {
    expect(mpv.channelsOf('5.1')?.names).toEqual(['FL', 'FR', 'FC', 'LFE', 'BL', 'BR']);
    expect(mpv.channelsOf('fl-fr-fc')?.spec).toBe('FL+FR+FC');
    expect(mpv.channelsOf('fl-fr-fc-lfe-zz')).toBeNull();
    expect(mpv.channelsOf('FL-FR-FC')).toBeNull();
  });

  it('chaîne af : son brut ou refus → aucun filtre ; réencodage Dolby Digital actif → lui seul, sans le mode', () => {
    expect(mpv.afChain({ mode: 'night', layout: 'stereo' })).toBe(mpv.modeFilter('night', 'stereo'));
    expect(mpv.afChain({ mode: 'night', layout: 'stereo', passthrough: true })).toBe('');
    expect(mpv.afChain({ mode: 'voice', layout: '5.1', failed: true })).toBe('');
    expect(mpv.afChain({ mode: 'voice', layout: '5.1', ac3: AC3 })).toBe(AC3);
    expect(mpv.afChain({ mode: 'off', layout: '5.1', ac3: AC3 })).toBe(AC3);
    expect(mpv.afChain({ mode: 'off', layout: '5.1' })).toBe('');
  });
});

describe('modes audio : graphe Web Audio', () => {
  it('« off » : rien à construire', () => {
    expect(webAudioPlan('off', 6)).toBeNull();
    expect(webAudioPlan('off')).toBeNull();
  });

  it('mode nuit : compresseur, gain, limiteur (paramètres aux unités de Web Audio)', () => {
    expect(webAudioPlan('night', 2)).toEqual({ layout: 'stereo', stages: NIGHT_STAGES });
    const [c, g, l] = NIGHT_STAGES;
    expect(c).toEqual({ type: 'compressor', threshold: -30, knee: 6, ratio: 4, attack: 0.005, release: 0.3 });
    expect(g).toEqual({ type: 'gain', db: -5 });
    expect(l).toBe(LIMITER);
    // Tout reste dans les plages de DynamicsCompressorNode.
    for (const s of [c, l]) {
      if (s.type !== 'compressor') throw new Error('compresseur attendu');
      expect(s.threshold).toBeGreaterThanOrEqual(-100);
      expect(s.threshold).toBeLessThanOrEqual(0);
      expect(s.knee).toBeGreaterThanOrEqual(0);
      expect(s.knee).toBeLessThanOrEqual(40);
      expect(s.ratio).toBeGreaterThanOrEqual(1);
      expect(s.ratio).toBeLessThanOrEqual(20);
      expect(s.attack).toBeLessThanOrEqual(1);
      expect(s.release).toBeLessThanOrEqual(1);
    }
  });

  it('5.1 et plus : traité par groupes, les six canaux gardés dans tous les modes', () => {
    expect(webAudioPlan('night', 6)).toEqual({ layout: 'surround', fold: undefined, gains: [0, 0, 0, 0, 0, 0], stages: NIGHT_STAGES });
    expect(webAudioPlan('voice', 6)).toEqual({ layout: 'surround', fold: undefined, gains: [-3, -3, 3, -3, -3, -3], stages: [LIMITER] });
    expect(webAudioPlan('voice', 7)).toMatchObject({ layout: 'surround', fold: 7 });
    expect(webAudioPlan('night', 8)).toMatchObject({ layout: 'surround', fold: 8 });
    // Un compresseur Web Audio ne prend que deux canaux : aucun groupe n'en a plus, chaque canal une fois.
    expect(SURROUND_GROUPS.every((g) => g.length <= 2)).toBe(true);
    expect(SURROUND_GROUPS.flat().sort()).toEqual([0, 1, 2, 3, 4, 5]);
    // Le centre (dialogues) est traité seul : une explosion à l'avant ne fait pas baisser les voix.
    expect(SURROUND_GROUPS).toContainEqual([2]);
  });

  it('voix : stéréo, mono ou canaux inconnus → compression douce et présence', () => {
    for (const ch of [1, 2, 4, undefined]) expect(webAudioPlan('voice', ch)).toEqual({ layout: 'stereo', stages: VOICE_STEREO_STAGES });
    expect(VOICE_STEREO_STAGES[2]).toEqual({ type: 'peaking', frequency: 2500, q: 1, db: 4 });
  });

  it('6.1 et 7.1 réduites en 5.1 : avant et centre intacts, arrières mêlés aux côtés', () => {
    const apply = (m: number[][], input: number[]) => m.map((row) => row.reduce((sum, k, i) => sum + k * input[i], 0));
    // 6.1 (L R C LFE BC SL SR) : l'arrière centre se partage entre les deux côtés (−3 dB).
    expect(apply(FOLD_TO_51[7], [1, 2, 3, 4, 0, 0, 0])).toEqual([1, 2, 3, 4, 0, 0]);
    const bc = apply(FOLD_TO_51[7], [0, 0, 0, 0, 1, 0, 0]);
    expect(bc[4]).toBeCloseTo(Math.SQRT1_2);
    expect(bc[5]).toBeCloseTo(Math.SQRT1_2);
    expect(apply(FOLD_TO_51[7], [0, 0, 0, 0, 0, 1, 0])).toEqual([0, 0, 0, 0, 1, 0]);
    // 7.1 (L R C LFE BL BR SL SR) : arrière gauche vers côté gauche, arrière droit vers côté droit.
    expect(apply(FOLD_TO_51[8], [1, 2, 3, 4, 0, 0, 0, 0])).toEqual([1, 2, 3, 4, 0, 0]);
    const bl = apply(FOLD_TO_51[8], [0, 0, 0, 0, 1, 0, 0, 0]);
    expect(bl[4]).toBeCloseTo(Math.SQRT1_2);
    expect(bl[5]).toBe(0);
    expect(apply(FOLD_TO_51[8], [0, 0, 0, 0, 0, 0, 0, 1])).toEqual([0, 0, 0, 0, 0, 1]);
    for (const n of [7, 8] as const) {
      expect(FOLD_TO_51[n]).toHaveLength(6);
      for (const row of FOLD_TO_51[n]) expect(row).toHaveLength(n);
    }
  });

  it('dB → gain', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(3)).toBeCloseTo(1.413, 3);
    expect(dbToGain(-3)).toBeCloseTo(0.708, 3);
  });

  it('jamais de Web Audio sur un média que la page ne peut pas lire', () => {
    const page = 'https://app.example';
    expect(webAudioSafe({ kind: 'mse', url: 'blob:https://app.example/123', pageOrigin: page })).toBe(true);
    // HLS lu par Safari lui-même : silence avec Web Audio, même avec CORS.
    expect(webAudioSafe({ kind: 'native-hls', url: `${page}/a.m3u8`, pageOrigin: page, cors: true })).toBe(false);
    expect(webAudioSafe({ kind: 'direct', url: `${page}/film.mp4`, pageOrigin: page })).toBe(true);
    expect(webAudioSafe({ kind: 'direct', url: '/film.mp4', pageOrigin: page })).toBe(true);
    expect(webAudioSafe({ kind: 'direct', url: 'https://192-168-1-2.abc.plex.direct:32400/library/parts/1/file.mkv', pageOrigin: page })).toBe(false);
    expect(webAudioSafe({ kind: 'direct', url: 'https://192-168-1-2.abc.plex.direct:32400/library/parts/1/file.mkv', pageOrigin: page, cors: true })).toBe(true);
    expect(webAudioSafe({ kind: 'direct', url: 'http://[bad', pageOrigin: page })).toBe(false);
    expect(webAudioSafe({ kind: 'direct', pageOrigin: page })).toBe(false);
  });
});

describe('modes audio : réglages enregistrés (apps/web/src/settings.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const loadSettings = async (stored?: unknown) => {
    const data = new Map<string, string>();
    if (stored !== undefined) data.set('mp.settings', JSON.stringify(stored));
    vi.stubGlobal('window', {});
    vi.stubGlobal('innerWidth', 1920);
    vi.stubGlobal('innerHeight', 1080);
    vi.stubGlobal('navigator', { language: 'fr-FR', maxTouchPoints: 0 });
    vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) });
    return import('../../../apps/web/src/settings');
  };

  it('désactivé par défaut', async () => {
    const m = await loadSettings();
    expect(m.DEFAULTS.audioMode).toBe('off');
    expect(m.settings.value.audioMode).toBe('off');
  });

  it('relu tel qu’enregistré', async () => {
    const m = await loadSettings({ layout: 'top', audioMode: 'voice' });
    expect(m.settings.value.audioMode).toBe('voice');
    m.update({ audioMode: 'night' });
    expect(m.settings.value.audioMode).toBe('night');
  });

  it('import de réglages : un mode inconnu ou d’un autre type est ignoré', async () => {
    const m = await loadSettings();
    expect(m.sanitize({ audioMode: 'night' })).toEqual({ audioMode: 'night' });
    expect(m.sanitize({ audioMode: 'voice', passthrough: true })).toEqual({ audioMode: 'voice', passthrough: true });
    expect(m.sanitize({ audioMode: 'boost' })).toEqual({});
    expect(m.sanitize({ audioMode: 1 })).toEqual({});
  });
});

describe('modes audio : lecteur du navigateur, choix au chargement', () => {
  const base = { mode: 'night' as const, kind: 'direct' as const, sameOrigin: false, claimed: false, blocked: false };

  it('flux hls.js (MediaSource) ou même origine : branché sans vérification', () => {
    expect(audioRouteDecision({ ...base, kind: 'mse' })).toEqual({ action: 'load', crossOrigin: false, route: true, safe: true });
    expect(audioRouteDecision({ ...base, sameOrigin: true })).toEqual({ action: 'load', crossOrigin: false, route: true, safe: true });
  });

  it('« off » : jamais de Web Audio, jamais de vérification, jamais de crossorigin', () => {
    for (const kind of ['mse', 'direct', 'native-hls'] as const) {
      const d = audioRouteDecision({ ...base, mode: 'off', kind });
      expect(d).toMatchObject({ action: 'load', crossOrigin: false, route: false });
    }
    expect(audioRouteDecision({ ...base, mode: 'off' })).toEqual({ action: 'load', crossOrigin: false, route: false, safe: null });
  });

  it('fichier d’un autre serveur : vérifié d’abord, crossorigin seulement si le serveur répond en CORS', () => {
    expect(audioRouteDecision(base)).toEqual({ action: 'probe' });
    expect(audioRouteDecision({ ...base, cors: true })).toEqual({ action: 'load', crossOrigin: true, route: true, safe: true });
    expect(audioRouteDecision({ ...base, cors: false })).toEqual({ action: 'load', crossOrigin: false, route: false, safe: false });
  });

  it('HLS natif (Safari) : jamais (WebKit le rend muet avec Web Audio)', () => {
    expect(audioRouteDecision({ ...base, kind: 'native-hls' })).toEqual({ action: 'load', crossOrigin: false, route: false, safe: false });
  });

  it('élément déjà branché : remplacé dès que le mode ne doit pas ou ne peut pas s’appliquer', () => {
    const claimed = { ...base, claimed: true };
    expect(audioRouteDecision({ ...claimed, mode: 'off' })).toEqual({ action: 'swap' });
    expect(audioRouteDecision({ ...claimed, blocked: true })).toEqual({ action: 'swap' });
    expect(audioRouteDecision({ ...claimed, kind: 'native-hls' })).toEqual({ action: 'swap' });
    expect(audioRouteDecision({ ...claimed, cors: false })).toEqual({ action: 'swap' });
    // Le mode s'applique encore : on garde l'élément.
    expect(audioRouteDecision({ ...claimed, kind: 'mse' })).toMatchObject({ action: 'load', route: true });
    expect(audioRouteDecision({ ...claimed, cors: true })).toMatchObject({ action: 'load', route: true, crossOrigin: true });
  });

  it('échec retenu (titre ou séance) : plus de Web Audio, ni de crossorigin', () => {
    expect(audioRouteDecision({ ...base, kind: 'mse', blocked: true })).toEqual({ action: 'load', crossOrigin: false, route: false, safe: false });
    expect(audioRouteDecision({ ...base, blocked: true, cors: true })).toEqual({ action: 'load', crossOrigin: false, route: false, safe: false });
  });

  it('mode changé pendant la vérification : la décision rejouée suit l’état du moment', () => {
    // Le lecteur rejoue la décision après chaque attente (Player.tsx, load()).
    let state = { ...base };
    let d = audioRouteDecision(state);
    expect(d).toEqual({ action: 'probe' });
    // Pendant la vérification, « Désactivé » est choisi : pas de crossorigin pour un fichier
    // dont le serveur aurait pourtant répondu en CORS.
    state = { ...state, mode: 'off' as never };
    d = audioRouteDecision({ ...state, cors: true });
    expect(d).toEqual({ action: 'load', crossOrigin: false, route: false, safe: null });
    // Inversement : « off » au départ, mode choisi pendant le chargement d'un fichier même origine.
    expect(audioRouteDecision({ ...base, mode: 'voice', sameOrigin: true })).toMatchObject({ route: true });
  });
});

describe('modes audio : garde-fou du lecteur du navigateur', () => {
  const tick = 0.25;
  const sample = (s: Partial<WatchSample> = {}): WatchSample => ({ dt: tick, playing: true, wantsPlay: true, running: true, hasAudio: true, tapLoud: true, refLoud: true, ...s });
  const run = (w: AudioWatch, s: WatchSample, seconds: number) => {
    const out: string[] = [];
    for (let i = 0; i < Math.round(seconds / tick); i++) out.push(w.tick(s));
    return out;
  };
  const firstTrip = (out: string[]) => out.findIndex((v) => v !== 'ok');

  it('son reçu : rien à signaler', () => {
    const w = new AudioWatch();
    expect(run(w, sample(), 60).every((v) => v === 'ok')).toBe(true);
  });

  it('élément sonore mais Web Audio muet (copie captureStream) : coupé en 1 s', () => {
    const w = new AudioWatch();
    const out = run(w, sample({ tapLoud: false, refLoud: true }), 5);
    expect(out[firstTrip(out)]).toBe('no-signal');
    expect((firstTrip(out) + 1) * tick).toBe(1);
  });

  it('une seconde de décalage passagère ne compte pas', () => {
    const w = new AudioWatch();
    for (let i = 0; i < 20; i++) {
      expect(run(w, sample({ tapLoud: false, refLoud: true }), 0.75).every((v) => v === 'ok')).toBe(true);
      expect(run(w, sample(), 0.25).every((v) => v === 'ok')).toBe(true);
    }
  });

  it('ouverture silencieuse (copie muette aussi) : pas de coupure à 8 s', () => {
    const w = new AudioWatch();
    expect(run(w, sample({ tapLoud: false, refLoud: false }), 9.75).every((v) => v === 'ok')).toBe(true);
    // Le son arrive : plus jamais de soupçon sur ce média.
    run(w, sample(), 1);
    expect(run(w, sample({ tapLoud: false, refLoud: false }), 60).every((v) => v === 'ok')).toBe(true);
  });

  it('tout muet depuis le début, 10 s : « silent » (retenu pour ce titre seulement)', () => {
    const w = new AudioWatch();
    const out = run(w, sample({ tapLoud: false, refLoud: false }), 12);
    expect(out[firstTrip(out)]).toBe('silent');
    expect((firstTrip(out) + 1) * tick).toBe(10);
  });

  it('sans copie possible (Safari) : 3 s de zéros, et seulement avant tout son', () => {
    const w = new AudioWatch();
    const out = run(w, sample({ tapLoud: false, refLoud: null }), 5);
    expect(out[firstTrip(out)]).toBe('no-signal');
    expect((firstTrip(out) + 1) * tick).toBe(3);
    const heard = new AudioWatch();
    run(heard, sample({ refLoud: null }), 1);
    expect(run(heard, sample({ tapLoud: false, refLoud: null }), 30).every((v) => v === 'ok')).toBe(true);
  });

  it('média sans piste audio : les zéros ne prouvent rien', () => {
    const w = new AudioWatch();
    expect(run(w, sample({ hasAudio: false, tapLoud: false, refLoud: null }), 30).every((v) => v === 'ok')).toBe(true);
  });

  it('pause, son coupé ou volume nul : rien n’est compté', () => {
    const w = new AudioWatch();
    run(w, sample({ tapLoud: false, refLoud: null }), 2.75);
    expect(run(w, sample({ playing: false, wantsPlay: false, tapLoud: false, refLoud: null, running: false }), 30).every((v) => v === 'ok')).toBe(true);
    expect(w.tick(sample({ tapLoud: false, refLoud: null }))).toBe('no-signal');
  });

  it('AudioContext suspendu pendant la lecture : la main est rendue en 1,5 s', () => {
    const w = new AudioWatch();
    run(w, sample(), 5);
    const out = run(w, sample({ running: false, tapLoud: false, refLoud: false }), 3);
    expect(out[firstTrip(out)]).toBe('suspended');
    expect((firstTrip(out) + 1) * tick).toBe(1.5);
    // Chromium fige l'élément branché quand l'AudioContext s'arrête : la position n'avance plus.
    const frozen = new AudioWatch();
    const f = run(frozen, sample({ playing: false, running: false, tapLoud: false, refLoud: false }), 3);
    expect(f[firstTrip(f)]).toBe('suspended');
    expect((firstTrip(f) + 1) * tick).toBe(1.5);
    // En pause : rien.
    expect(run(new AudioWatch(), sample({ playing: false, wantsPlay: false, running: false }), 10).every((v) => v === 'ok')).toBe(true);
    // Repris avant : rien.
    const w2 = new AudioWatch();
    run(w2, sample({ running: false }), 1.25);
    run(w2, sample(), 0.25);
    expect(run(w2, sample({ running: false }), 1.25).every((v) => v === 'ok')).toBe(true);
  });

  it('centre muet en 5.1 : repli stéréo après 30 s seulement, pas pendant un dialogue absent passager', () => {
    const w = new AudioWatch();
    const noCentre = sample({ centre: { centreLoud: false, frontLoud: true } });
    const out = run(w, noCentre, 40);
    expect(out[firstTrip(out)]).toBe('no-centre');
    expect((firstTrip(out) + 1) * tick).toBe(30);
    const w2 = new AudioWatch();
    for (let i = 0; i < 10; i++) {
      expect(run(w2, noCentre, 20).every((v) => v === 'ok')).toBe(true);
      run(w2, sample({ centre: { centreLoud: true, frontLoud: true } }), 0.25);
    }
  });

  it('nouveau média sur le même élément : tout est réécouté', () => {
    const w = new AudioWatch();
    run(w, sample(), 1);
    w.reset();
    const out = run(w, sample({ tapLoud: false, refLoud: null }), 4);
    expect(out[firstTrip(out)]).toBe('no-signal');
  });
});
