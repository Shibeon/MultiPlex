import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Lecteur natif (apps/desktop/mpv.cjs) piloté par un faux canal JSON : chaque commande reçoit
// la réponse que donnerait mpv, les évènements (propriétés, journal) sont injectés à la main.
const require = createRequire(import.meta.url);
const { MpvPlayer } = require('../../../apps/desktop/mpv.cjs') as { MpvPlayer: new (app: unknown, win: unknown, emit: (ev: string, v: unknown) => void) => Player };
const { modeFilter } = require('../../../apps/desktop/audiomode.cjs') as { modeFilter(mode: string, layout?: string): string };

interface Player {
  session: number;
  sock: { write(line: string): void } | null;
  state: Record<string, unknown>;
  onMessage(line: string): void;
  command(name: string, value?: unknown): Promise<unknown>;
  [k: string]: unknown;
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function rig(o: { mode: string; spdif?: boolean; refuse?: (cmd: unknown[]) => string | undefined }) {
  const events: { name: string; value: unknown }[] = [];
  const af: string[] = [];
  const p = new MpvPlayer({}, {}, (ev, v) => ev === 'state' && events.push(v as { name: string; value: unknown }));
  // État que play() met en place avant de lancer mpv.
  Object.assign(p, { session: 1, spdif: !!o.spdif, stage: 0, ac3enc: false, ac3Tried: false, audioMode: o.mode, modeFailed: false, af: '', afHasMode: false, afLayout: '', afLayoutAt: 0, afRetried: false, disabledAt: 0, outFormat: '', layout: '', loaded: true });
  p.sock = {
    write(line) {
      const { command, request_id } = JSON.parse(line) as { command: unknown[]; request_id: number };
      if (command[0] === 'set_property' && command[1] === 'af') af.push(String(command[2]));
      const error = o.refuse?.(command) ?? 'success';
      void Promise.resolve().then(() => p.onMessage(JSON.stringify({ request_id, error, data: null })));
    },
  };
  const prop = async (name: string, data: unknown) => {
    p.onMessage(JSON.stringify({ event: 'property-change', name, data }));
    await flush();
  };
  const log = async (prefix: string, text: string) => {
    p.onMessage(JSON.stringify({ event: 'log-message', prefix, level: 'error', text }));
    await flush();
  };
  const failed = () => !!p.state['audio-mode-failed'];
  return { p, af, events, prop, log, failed };
}

describe('lecteur natif : mode audio appliqué par mpv', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('appliqué dès que mpv dit ce qu’il décode, à chaud au changement de mode', async () => {
    const r = rig({ mode: 'voice' });
    await r.prop('audio-params', { channels: '5.1(side)' });
    await r.prop('audio-out-params', { format: 'floatp', channels: '5.1(side)' });
    expect(r.af).toEqual([modeFilter('voice', '5.1(side)')]);
    await r.p.command('audioMode', 'night');
    await flush();
    await r.p.command('audioMode', 'off');
    await flush();
    expect(r.af).toEqual([modeFilter('voice', '5.1(side)'), modeFilter('night', '5.1(side)'), '']);
  });

  it('changement de piste 5.1 → stéréo en mode voix : chaîne refaite, mode gardé, pas d’échec', async () => {
    const r = rig({ mode: 'voice' });
    await r.prop('audio-params', { channels: '5.1(side)' });
    await r.prop('audio-out-params', { format: 'floatp' });
    await r.prop('aid', 2);
    // Pendant la réinitialisation, mpv signale des paramètres vides : rien ne bascule.
    await r.prop('audio-params', {});
    await r.prop('audio-out-params', {});
    // Le filtre de la piste précédente échoue sur la nouvelle avant que la nôtre ne la suive.
    await r.prop('audio-params', { channels: 'stereo' });
    await r.log('cplayer', 'Audio filter initialized failed!');
    await r.prop('audio-out-params', { format: 'floatp', channels: 'stereo' });
    expect(r.failed()).toBe(false);
    expect(r.af.at(-1)).toBe(modeFilter('voice', 'stereo'));
    expect(r.af).not.toContain('');
    // Refusée une seconde fois, la chaîne de la nouvelle piste est bien un échec.
    await r.log('cplayer', 'Audio filter initialized failed!');
    expect(r.failed()).toBe(true);
    expect(r.af.at(-1)).toBe('');
  });

  it('refus du filtre sur la même piste : mode abandonné pour ce fichier, son sans filtre', async () => {
    const r = rig({ mode: 'voice' });
    await r.prop('audio-params', { channels: '5.1' });
    await r.prop('audio-out-params', { format: 'floatp' });
    await r.log('cplayer', 'Audio filter initialized failed!');
    expect(r.failed()).toBe(true);
    expect(r.af).toEqual([modeFilter('voice', '5.1'), '']);
    expect(r.events).toContainEqual({ name: 'audio-mode-failed', value: true });
    // Un autre mode choisi ensuite : nouvel essai.
    await r.p.command('audioMode', 'night');
    await flush();
    expect(r.failed()).toBe(false);
    expect(r.af.at(-1)).toBe(modeFilter('night', '5.1'));
  });

  it('erreur renvoyée par set_property : comptée comme un refus (n’est plus masquée)', async () => {
    const r = rig({ mode: 'night', refuse: (c) => (c[0] === 'set_property' && c[1] === 'af' && c[2] !== '' ? 'error running command' : undefined) });
    await r.prop('audio-params', { channels: 'stereo' });
    await r.prop('audio-out-params', { format: 'floatp' });
    expect(r.failed()).toBe(true);
    expect(r.af.at(-1)).toBe('');
  });

  it('son brut vers l’ampli : jamais de filtre de mode', async () => {
    const r = rig({ mode: 'night', spdif: true });
    await r.prop('audio-params', { channels: '5.1' });
    await r.prop('audio-out-params', { format: 'spdif-ac3' });
    expect(r.af).toEqual([]);
    expect(r.failed()).toBe(false);
  });

  it('filtre « désactivé » parce que le son passe brut (réinitialisation lente) : pas d’échec', async () => {
    const r = rig({ mode: 'night', spdif: true });
    await r.prop('audio-params', { channels: 'stereo' });
    await r.prop('audio-out-params', { format: 'floatp' });
    expect(r.af).toEqual([modeFilter('night', 'stereo')]);
    // Piste Dolby choisie : mpv désactive le filtre, la sortie se réinitialise (vide)…
    await r.prop('aid', 2);
    await r.log('af', 'Disabling filter lavfi.00 because it has failed.');
    await r.prop('audio-out-params', {});
    // … plus longtemps que les 500 ms d'avant (sortie WASAPI exclusive).
    await vi.advanceTimersByTimeAsync(1600);
    expect(r.failed()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await r.prop('audio-params', { channels: '5.1' });
    await r.prop('audio-out-params', { format: 'spdif-ac3' });
    expect(r.failed()).toBe(false);
    expect(r.af.at(-1)).toBe('');
  });

  it('filtre « désactivé » alors que le son reste décodé : échec, mais pas avant 1,5 s', async () => {
    const r = rig({ mode: 'night' });
    await r.prop('audio-params', { channels: 'stereo' });
    await r.prop('audio-out-params', { format: 'floatp' });
    await r.log('af', 'Disabling filter lavfi.00 because it has failed.');
    await r.prop('audio-out-params', {});
    await r.prop('audio-out-params', { format: 'floatp' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.failed()).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(r.failed()).toBe(true);
    expect(r.af.at(-1)).toBe('');
  });

  it('filtre « désactivé », sortie encore vide à 1,5 s : jugé au prochain format connu', async () => {
    const r = rig({ mode: 'night' });
    await r.prop('audio-params', { channels: 'stereo' });
    await r.prop('audio-out-params', { format: 'floatp' });
    await r.log('af', 'Disabling filter lavfi.00 because it has failed.');
    await r.prop('audio-out-params', {});
    await vi.advanceTimersByTimeAsync(3000);
    expect(r.failed()).toBe(false);
    await r.prop('audio-out-params', { format: 's16' });
    expect(r.failed()).toBe(true);
  });
});
