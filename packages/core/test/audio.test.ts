import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIO_MODES, LIMITER, NIGHT_STAGES, VOICE_STEREO_STAGES, audioModeOf, dbToGain, nativeAudioModeShown, webAudioSafe, webAudioStages } from '../src';

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
    expect(mpv.modeFilter('voice', '5.1(side)')).toBe(`lavfi=[pan=5.1(side)|FL=0.708*FL|FR=0.708*FR|FC=1.413*FC|LFE=0.708*LFE|SL=0.708*SL|SR=0.708*SR,${LIMIT}]`);
    expect(mpv.centreBoost('5.1')).toBe('pan=5.1|FL=0.708*FL|FR=0.708*FR|FC=1.413*FC|LFE=0.708*LFE|BL=0.708*BL|BR=0.708*BR');
    expect(mpv.centreBoost('7.1')).toBe('pan=7.1|FL=0.708*FL|FR=0.708*FR|FC=1.413*FC|LFE=0.708*LFE|BL=0.708*BL|BR=0.708*BR|SL=0.708*SL|SR=0.708*SR');
    // Disposition inhabituelle, nommée canal par canal par mpv.
    expect(mpv.centreBoost('fl-fr-fc-lfe-sl-sr')).toBe('pan=FL+FR+FC+LFE+SL+SR|FL=0.708*FL|FR=0.708*FR|FC=1.413*FC|LFE=0.708*LFE|SL=0.708*SL|SR=0.708*SR');
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

  it('chaîne af : son brut ou refus → rien ; réencodage Dolby Digital seul, toujours en dernier', () => {
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
    expect(webAudioStages('off', 6)).toEqual([]);
  });

  it('mode nuit : compresseur, gain, limiteur (paramètres aux unités de Web Audio)', () => {
    expect(webAudioStages('night', 2)).toBe(NIGHT_STAGES);
    expect(webAudioStages('night', 6)).toBe(NIGHT_STAGES);
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

  it('voix : centre de 5.1 / 7.1 relevé, sinon compression douce et présence', () => {
    expect(webAudioStages('voice', 6)).toEqual([{ type: 'centre', channels: 6, centreDb: 3, othersDb: -3 }, LIMITER]);
    expect(webAudioStages('voice', 8)).toEqual([{ type: 'centre', channels: 8, centreDb: 3, othersDb: -3 }, LIMITER]);
    for (const ch of [1, 2, 4, undefined]) expect(webAudioStages('voice', ch)).toBe(VOICE_STEREO_STAGES);
    expect(VOICE_STEREO_STAGES[2]).toEqual({ type: 'peaking', frequency: 2500, q: 1, db: 4 });
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
