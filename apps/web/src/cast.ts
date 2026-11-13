// Lecture sur un téléviseur (Google Cast). L'appareil lit lui-même le flux du serveur Plex :
// l'application ne fait que choisir le flux, le lancer, le piloter et tenir le serveur au courant
// de la position (pour « Reprendre » et « vu »). Le transport appartient à la plateforme
// (`native.cast`) : aujourd'hui l'application de bureau.
import { randomId, type MediaServer, type Metadata } from '@multiplex/core';
import { tvDevice } from './platform';
import { signal } from '@preact/signals';
import { t } from './i18n';
import { native, type CastStatus } from './native';
import { server } from './store';
import { labels } from './ui';
import { androidCastApi, webCastApi, webCastPossible } from './webcast';

/**
 * Qui envoie : l'application de bureau (son propre protocole), l'application Android (module
 * natif, kit de Google) ou un navigateur Chromium (kit de Google pour le web).
 */
// Un téléviseur ne « caste » pas vers un autre écran.
export const castApi = tvDevice ? undefined : (native?.cast ?? androidCastApi() ?? (webCastPossible() ? webCastApi() : undefined));
/** Faux si la plateforme ne peut finalement pas envoyer (Android sans services Google, Fire TV). */
export const castEnabled = signal(!!castApi);
if (castApi?.available) void castApi.available().then((ok) => (castEnabled.value = ok), () => (castEnabled.value = false));

export interface CastNow extends Omit<CastStatus, 'device'> {
  item: Metadata;
  device: string;
}

/** Lecture en cours sur un téléviseur (null : rien). */
export const casting = signal<CastNow | null>(null);
/** Choix d'appareil ouvert pour ce titre, à cette position (secondes). */
export const castPick = signal<{ item: Metadata; start: number } | null>(null);

/** Ce que le récepteur de Google lit sans conversion : MP4 en H.264 et AAC. */
const castCanPlay = (mime: string) => {
  if (!/^video\/mp4/.test(mime)) return false;
  const codecs = /codecs="([^"]*)"/.exec(mime)?.[1];
  return !!codecs && codecs.split(',').every((c) => /^(avc1|mp4a)/.test(c.trim()));
};

let ctx: { srv: MediaServer; item: Metadata; session: string; transcode: string; lastReport: number } | null = null;

function report(state: 'playing' | 'paused' | 'stopped', time: number, duration: number) {
  if (!ctx || !time) return;
  ctx.srv.timeline({ ratingKey: ctx.item.ratingKey, state, timeMs: time * 1000, durationMs: duration * 1000 || ctx.item.duration || 0, session: ctx.session }).catch(() => {});
}

function finish() {
  const now = casting.value;
  if (ctx && now) report('stopped', now.time, now.duration);
  if (ctx?.transcode) ctx.srv.stopTranscode(ctx.transcode).catch(() => {});
  ctx = null;
  casting.value = null;
}

if (castApi) {
  castApi.onStatus((s) => {
    if (s.state === 'closed') return finish();
    const now = casting.value;
    if (!now || !ctx) return;
    casting.value = { ...now, ...s, device: s.device || now.device, duration: s.duration || now.duration };
    const playing = s.state === 'playing';
    // Position envoyée au serveur toutes les 10 secondes, et à chaque pause.
    if ((playing && Date.now() - ctx.lastReport > 10_000) || (s.state === 'paused' && now.state !== 'paused')) {
      ctx.lastReport = Date.now();
      report(playing ? 'playing' : 'paused', s.time, s.duration || now.duration);
    }
    if (s.state === 'idle' && s.ended) void stopCast();
  });
}

/**
 * « Lire sur un téléviseur » : choix d'appareil de l'application, ou celui du navigateur qui
 * s'ouvre directement.
 */
export function openCast(item: Metadata, start: number): void {
  const srv = server.value;
  if (!castApi?.browserPicker) {
    castPick.value = { item, start };
    return;
  }
  if (!srv) return;
  startCast(srv, item, { id: 'browser', name: '' }, start).catch((e: Error) => {
    if (e.message === 'cancel') return;
    void import('./menu').then(({ say }) => say(t('cast.failed')));
  });
}

/** Lance un titre (film ou épisode) sur l'appareil choisi, à la position donnée (secondes). */
export async function startCast(srv: MediaServer, item: Metadata, device: { id: string; name: string }, start: number): Promise<void> {
  if (!castApi) throw new Error('cast');
  const m = item.Media?.length ? item : await srv.metadata(item.ratingKey);
  if (ctx) finish();
  // 1080p au plus : les Chromecast courants ne décodent pas mieux, et le serveur copie la vidéo quand il peut.
  const plan = await srv.playback(m, { quality: '20000', canPlay: castCanPlay });
  const { title, sub } = labels(m);
  const poster = m.type === 'episode' ? (m.grandparentThumb ?? m.parentThumb ?? m.thumb) : m.thumb;
  const duration = (m.duration ?? 0) / 1000;
  ctx = { srv, item: m, session: randomId(), transcode: plan.mode === 'hls' ? plan.session : '', lastReport: 0 };
  casting.value = { item: m, device: device.name, state: 'connecting', time: start, duration, volume: 1, muted: false };
  try {
    const r = await castApi.start(device.id, {
      url: await srv.forDevice(plan.url),
      contentType: plan.mode === 'direct' ? 'video/mp4' : 'application/x-mpegURL',
      title,
      sub,
      kind: m.type,
      image: poster ? await srv.forDevice(srv.image(poster, 600, 900)).catch(() => undefined) : undefined,
      start,
      duration,
    });
    if (!r.ok) throw new Error(r.error || 'cast');
  } catch (e) {
    finish();
    throw e;
  }
}

export function castControl(action: 'play' | 'pause' | 'seek' | 'volume' | 'mute', value?: number | boolean): void {
  castApi?.control(action, value);
  const now = casting.value;
  // Retour immédiat dans la télécommande ; l'appareil confirme ensuite.
  if (now && action === 'seek' && typeof value === 'number') casting.value = { ...now, time: value };
  if (now && action === 'volume' && typeof value === 'number') casting.value = { ...now, volume: value };
}

/** Arrête la lecture sur le téléviseur. */
export async function stopCast(): Promise<void> {
  const had = !!ctx;
  await castApi?.stop().catch(() => false);
  if (had) finish();
}
