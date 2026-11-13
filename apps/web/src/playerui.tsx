import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { t } from './i18n';
import { Icon } from './ui';

/** Bouton de saut : flèche circulaire, et la durée en dessous (« −30s », « +30s »). */
export function SkipButton({ seconds, onClick, act }: { seconds: number; onClick: () => void; act?: string }) {
  const label = seconds < 0 ? t('player.backN').replace('{n}', String(-seconds)) : t('player.fwdN').replace('{n}', String(seconds));
  return (
    <button class="btn icon-btn skipper" data-act={act} aria-label={label} title={label} onClick={onClick}>
      <svg class="icon" width={24} height={24} viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" transform={seconds > 0 ? 'translate(24 0) scale(-1 1)' : undefined} d="M12 4.5V1L7 5.5 12 10V6.5a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" />
      </svg>
      <small>
        {seconds < 0 ? '−' : '+'}
        {Math.abs(seconds)}s
      </small>
    </button>
  );
}

/** Une pastille : `unsure` = déduite, pas vérifiée dans la chaîne de lecture ; `hint` = précision au survol. */
export type TechBadge = { kind: string; label: string; unsure?: boolean; hint?: string };

/** Pastilles sous le titre : ce qui est réellement restitué (voir liveTechNative / liveTechWeb). */
export function PlayerTech({ badges }: { badges: TechBadge[] | undefined }) {
  if (!badges?.length) return null;
  return (
    <ul class="ptech" aria-label={t('live.label')}>
      {badges.map((b) => (
        <li key={b.kind + b.label} class={`ptech-${b.kind}${b.unsure ? ' unsure' : ''}`} data-tech={b.label} title={b.unsure ? `${b.hint ?? b.label} — ${t('live.unsure')}` : b.hint}>
          {b.label}
          {b.unsure && <i aria-hidden="true">?</i>}
        </li>
      ))}
    </ul>
  );
}

/** Définition d'après les dimensions réellement décodées (les films recadrés gardent leur largeur). */
export function resolutionLabel(w: number, h: number): string {
  if (w >= 3200 || h >= 1900) return '4K';
  if (w >= 2300 || h >= 1300) return '1440p';
  if (w >= 1700 || h >= 900) return '1080p';
  if (w >= 1100 || h >= 650) return '720p';
  return `${Math.round(h)}p`;
}

export function channelsLabel(n: number | undefined): string {
  if (!n) return '';
  return n >= 8 ? '7.1' : n >= 6 ? '5.1' : n === 2 ? t('live.stereo') : n === 1 ? 'Mono' : `${n} ch`;
}

const src = (tech: TechBadge[] | undefined, kind: string) => tech?.find((b) => b.kind === kind)?.label;
const SPDIF: Record<string, string> = { 'spdif-ac3': 'Dolby Digital', 'spdif-eac3': 'Dolby Digital Plus', 'spdif-truehd': 'Dolby TrueHD', 'spdif-dts': 'DTS', 'spdif-dtshd': 'DTS-HD' };

/**
 * Lecteur natif (mpv) : ce qui sort vraiment.
 * - définition : image décodée (`video-params`), donc après un éventuel transcodage ;
 * - plage dynamique : ce que mpv envoie à l'écran (`video-target-params` : PQ = HDR10, HLG, sinon
 *   SDR). Sans cette information (mpv ancien), la plage de la source est donnée comme non vérifiée ;
 * - son : format remis à la sortie (`audio-out-params`) : flux brut vers l'ampli, réencodé en
 *   Dolby Digital, ou PCM décodé avec son nombre de canaux ;
 * - traitement : lecture directe ou transcodage par le serveur, passthrough ou réencodage.
 */
export function liveTechNative(s: Record<string, unknown>, meta: { tech?: TechBadge[]; playMode?: 'direct' | 'transcode' }): TechBadge[] {
  const out: TechBadge[] = [];
  const vp = s['video-params'] as { dw?: number; dh?: number; w?: number; h?: number; gamma?: string } | undefined;
  const w = vp?.dw ?? vp?.w;
  const h = vp?.dh ?? vp?.h;
  if (w && h) out.push({ kind: 'resolution', label: resolutionLabel(w, h) });

  const srcHdr = src(meta.tech, 'hdr');
  const target = s['video-target-params'] as { gamma?: string } | undefined;
  if (vp?.gamma) {
    const srcIsHdr = vp.gamma === 'pq' || vp.gamma === 'hlg';
    if (target?.gamma) {
      if (target.gamma === 'pq') out.push({ kind: 'hdr', label: 'HDR10', hint: srcHdr && srcHdr !== 'HDR10' ? t('live.hdrAs').replace('{s}', srcHdr) : undefined });
      else if (target.gamma === 'hlg') out.push({ kind: 'hdr', label: 'HLG' });
      else out.push({ kind: 'sdr', label: 'SDR', hint: srcIsHdr ? t('live.toSdr').replace('{s}', srcHdr ?? 'HDR') : undefined });
    } else if (srcIsHdr) {
      // mpv n'envoie jamais de Dolby Vision à l'écran (il l'applique lui-même) : au mieux du HDR10.
      const label = vp.gamma === 'hlg' ? 'HLG' : 'HDR10';
      out.push({ kind: 'hdr', label, unsure: true, hint: `${srcHdr && srcHdr !== label ? `${t('live.hdrAs').replace('{s}', srcHdr)} ; ` : ''}${t('live.screenUnknown')}` });
    }
    else out.push({ kind: 'sdr', label: 'SDR' });
  }

  const ao = s['audio-out-params'] as { format?: string; 'channel-count'?: number } | undefined;
  const proc: TechBadge[] = [];
  if (ao?.format?.startsWith('spdif')) {
    if (s['ac3-encode'] && ao.format === 'spdif-ac3') {
      out.push({ kind: 'audio', label: 'Dolby Digital' }, { kind: 'channels', label: '5.1' });
      proc.push({ kind: 'proc', label: t('native.audioEncoded') });
    } else {
      const srcAudio = src(meta.tech, 'audio');
      // Atmos voyage dans le flux Dolby Digital+ ou TrueHD transmis tel quel.
      const atmos = srcAudio === 'Dolby Atmos' && (ao.format === 'spdif-eac3' || ao.format === 'spdif-truehd');
      const dtsCore = ao.format === 'spdif-dts' && !!srcAudio && srcAudio !== 'DTS';
      out.push({ kind: 'audio', label: atmos ? 'Dolby Atmos' : SPDIF[ao.format] ?? ao.format.slice(6).toUpperCase(), hint: atmos ? t('live.atmosSent') : dtsCore ? t('live.dtsCore') : undefined });
      // Le nombre de canaux d'un flux brut est celui de la source (sauf le cœur DTS d'une piste DTS-HD).
      const ch = src(meta.tech, 'channels');
      if (ch && !dtsCore) out.push({ kind: 'channels', label: ch });
      proc.push({ kind: 'proc', label: 'Passthrough' });
    }
  } else if (ao?.format) {
    out.push({ kind: 'audio', label: 'PCM' });
    const ch = channelsLabel(ao['channel-count']);
    if (ch) out.push({ kind: 'channels', label: ch });
  }
  if (meta.playMode) out.push({ kind: 'mode', label: meta.playMode === 'direct' ? 'Direct Play' : t('live.transcoding') });
  return [...out, ...proc];
}

/**
 * Lecteur web (navigateur, Android, TV) : le navigateur en dit moins. Sont sûrs la définition
 * de l'image reçue et ce que fait le serveur ; la plage dynamique et le son restitués ne le sont
 * pas (le navigateur ou le téléviseur décident), ils sont donnés comme non vérifiés.
 */
export function liveTechWeb(v: HTMLVideoElement | null, plan: { mode: 'direct' | 'hls'; video?: 'copy' | 'transcode'; audio?: 'copy' | 'transcode' } | null, tech: TechBadge[]): TechBadge[] {
  if (!plan) return [];
  const out: TechBadge[] = [];
  if (v?.videoWidth && v.videoHeight) out.push({ kind: 'resolution', label: resolutionLabel(v.videoWidth, v.videoHeight) });
  const srcHdr = src(tech, 'hdr');
  if (srcHdr) {
    // Converti par le serveur : en général en SDR, mais le navigateur ne le confirme pas.
    if (plan.video === 'transcode') out.push({ kind: 'sdr', label: 'SDR', unsure: true, hint: t('live.toSdr').replace('{s}', srcHdr) });
    else out.push({ kind: 'hdr', label: srcHdr, unsure: true, hint: t('live.screenUnknown') });
  } else if (src(tech, 'resolution')) out.push({ kind: 'sdr', label: 'SDR' });
  if (plan.audio === 'transcode') out.push({ kind: 'audio', label: 'AAC', hint: t('live.serverAudio') });
  else {
    const a = src(tech, 'audio');
    if (a) out.push({ kind: 'audio', label: a, unsure: true, hint: t('live.browserAudio') });
  }
  const mode = plan.mode === 'direct' ? 'Direct Play' : plan.video === 'copy' ? 'Direct Stream' : t('live.transcoding');
  out.push({ kind: 'mode', label: mode });
  return out;
}

// --- Fiche du média : ce que cet appareil restituera ----------------------------------------
// Rien n'est lu encore : on reprend ce que l'appareil a réellement restitué la dernière fois
// qu'il a lu un fichier du même genre (même plage dynamique, même piste audio, mêmes réglages
// de sortie), retenu pendant la lecture. À défaut, une estimation d'après l'écran et les
// réglages, marquée « ? ».

const SEEN_KEY = 'mp.techSeen';
type Seen = Record<string, TechBadge[]>;
function readSeen(): Seen {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Seen;
  } catch {
    return {};
  }
}
/** Clés d'un fichier : plage dynamique ; piste audio (codec et canaux) ; les deux, pour le mode. */
function seenKeys(source: TechBadge[], ctx: string) {
  const hdr = src(source, 'hdr') ?? 'SDR';
  const audio = `${src(source, 'audio') ?? '?'}|${src(source, 'channels') ?? '?'}`;
  return { video: `v|${ctx}|${hdr}`, audio: `a|${ctx}|${audio}`, mode: `m|${ctx}|${src(source, 'video') ?? '?'}|${hdr}|${audio}` };
}

/** Pendant la lecture : retient ce qui a été vérifié (pas les pastilles « ? »). */
export function rememberTech(source: TechBadge[] | undefined, live: TechBadge[], ctx: string): void {
  if (!source?.length || !live.length) return;
  const k = seenKeys(source, ctx);
  const sure = live.filter((b) => !b.unsure);
  const video = sure.filter((b) => b.kind === 'hdr' || b.kind === 'sdr');
  const audio = sure.filter((b) => b.kind === 'audio' || b.kind === 'channels' || b.kind === 'proc');
  const mode = sure.filter((b) => b.kind === 'mode');
  const seen = readSeen();
  const next = { ...seen };
  if (video.length) next[k.video] = video;
  if (audio.some((b) => b.kind === 'audio')) next[k.audio] = audio;
  if (mode.length) next[k.mode] = mode;
  if (JSON.stringify(next) === JSON.stringify(seen)) return;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(next));
  } catch {
    /* stockage plein ou interdit : la fiche restera sur l'estimation */
  }
}

/** Contexte de sortie : un changement de lecteur ou de réglage audio invalide ce qui a été vu. */
export function techContext(native: boolean, passthrough: boolean, audioDevice: string): string {
  return native ? `native|${passthrough ? 'pass' : 'pcm'}|${audioDevice}` : 'web';
}

const hdrScreen = () => typeof matchMedia === 'function' && matchMedia('(dynamic-range: high)').matches;

/** Pastilles de la fiche : définition, plage dynamique, son, mode, tels que cet appareil les restituera. */
export function predictTech(source: TechBadge[], ctx: string): TechBadge[] {
  if (!source.length) return [];
  const native = ctx.startsWith('native');
  const seen = readSeen();
  const k = seenKeys(source, ctx);
  const was = (list: TechBadge[] | undefined) => list?.map((b) => ({ ...b, hint: b.hint ? `${b.hint} — ${t('live.seen')}` : t('live.seen') }));
  const out: TechBadge[] = [];
  const res = source.find((b) => b.kind === 'resolution');
  if (res) out.push(res);

  const srcHdr = src(source, 'hdr');
  const video = was(seen[k.video]);
  if (video) out.push(...video);
  else if (!srcHdr) {
    if (res) out.push({ kind: 'sdr', label: 'SDR' });
  } else if (hdrScreen()) {
    // mpv n'envoie jamais de Dolby Vision : il l'applique et sort du HDR10.
    const label = srcHdr === 'HLG' ? 'HLG' : native ? 'HDR10' : srcHdr;
    out.push({ kind: 'hdr', label, unsure: true, hint: label !== srcHdr ? t('live.hdrAs').replace('{s}', srcHdr) : t('live.screenHdr') });
  } else out.push({ kind: 'sdr', label: 'SDR', unsure: true, hint: `${t('live.toSdr').replace('{s}', srcHdr)} (${t('live.screenSdr')})` });

  const audio = was(seen[k.audio]);
  const proc: TechBadge[] = [];
  if (audio) {
    out.push(...audio.filter((b) => b.kind !== 'proc'));
    proc.push(...audio.filter((b) => b.kind === 'proc'));
  } else {
    const a = src(source, 'audio');
    const ch = src(source, 'channels');
    if (native && ctx.includes('|pcm|')) {
      if (a) out.push({ kind: 'audio', label: 'PCM', hint: t('live.pcmGuess') });
      if (ch) out.push({ kind: 'channels', label: ch === 'Stéréo' ? t('live.stereo') : ch, unsure: true, hint: t('live.pcmGuess') });
    } else {
      if (a) out.push({ kind: 'audio', label: a, unsure: true, hint: native ? t('live.passGuess') : t('live.browserAudio') });
      if (ch) out.push({ kind: 'channels', label: ch === 'Stéréo' ? t('live.stereo') : ch, unsure: true });
    }
  }

  const mode = was(seen[k.mode]);
  if (mode) out.push(...mode);
  // Le lecteur de bureau lit toujours le fichier d'origine.
  else if (native) out.push({ kind: 'mode', label: 'Direct Play' });
  return [...out, ...proc];
}

const clockOf = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Heure qu'il est, et heure de fin estimée de la lecture. */
export function PlayerClock({ remaining, speed = 1 }: { remaining: number; speed?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 15000);
    return () => clearInterval(timer);
  }, []);
  const now = new Date();
  return (
    <div class="player-clock" aria-hidden="true">
      <b>{clockOf(now)}</b>
      {remaining > 0 && <small>{t('couch.ends').replace('{t}', clockOf(new Date(now.getTime() + (remaining * 1000) / (speed || 1))))}</small>}
    </div>
  );
}

/** Pastille du bas du lecteur : icône et libellé (seule l'icône sur les petits écrans). */
export function Pill({ icon, label, expanded, onClick, title, act }: { icon: string; label: string; expanded?: boolean; onClick: () => void; title?: string; act?: string }) {
  return (
    <button class="btn pill" data-act={act} aria-label={label} title={title ?? label} aria-expanded={expanded} onClick={onClick}>
      <Icon name={icon} /> <span>{label}</span>
    </button>
  );
}

/**
 * Bouton de réglage du lecteur qui s'ouvre sur ses options : la liste sort du bouton,
 * vers le haut, dans la même matière, pour qu'on voie d'où elle vient.
 */
export function PillMenu({ open, menu, ...pill }: { icon: string; label: string; open: boolean; menu: ComponentChildren; onClick: () => void; act?: string }) {
  return (
    <span class={`pill-wrap${open ? ' open' : ''}`}>
      {open && <div class="pill-panel">{menu}</div>}
      <Pill {...pill} expanded={open} />
    </span>
  );
}

/** Sous-titre du lecteur (« S2 · E3 · titre ») : les points y sont plus marqués, comme dans la maquette. */
export function PlayerSub({ text }: { text: string }) {
  const parts = text.split(' · ');
  return (
    <span class="player-sub">
      {parts.map((p, i) => (
        <>
          {i > 0 && <i class="psep" aria-hidden="true">•</i>}
          {p}
        </>
      ))}
    </span>
  );
}
