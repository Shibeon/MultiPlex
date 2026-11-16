import { Fragment, type ComponentChildren } from 'preact';
import { audioCodecLabel, videoCodecLabel } from '@multiplex/core';
import { settings } from './settings';
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

/** Pastilles (fiche d'un média) : les caractéristiques du fichier, sur une rangée. */
export function PlayerTech({ badges }: { badges: TechBadge[] | undefined }) {
  if (!badges?.length) return null;
  return (
    <ul class="ptech" aria-label={t('live.label')}>
      {badges.map((b) => (
        <TechPill key={b.kind + b.label} b={b} />
      ))}
    </ul>
  );
}

function TechPill({ b }: { b: TechBadge }) {
  return (
    <li class={`ptech-${b.kind}${b.unsure ? ' unsure' : ''}`} data-tech={b.label} title={b.unsure ? `${b.hint ?? b.label} — ${t('live.unsure')}` : b.hint}>
      {/^(Dolby|DTS)/.test(b.label) && b.kind === 'audio' && <SurroundMark />}
      {b.label}
      {b.unsure && <i aria-hidden="true">?</i>}
    </li>
  );
}

/** Petit emblème « son multicanal » (dessin propre à MultiPlex, pas un logo de marque). */
function SurroundMark() {
  return (
    <svg class="surround" viewBox="0 0 24 16" aria-hidden="true">
      <circle cx="12" cy="8" r="2.6" fill="currentColor" />
      <path d="M7.2 3.2a6.8 6.8 0 0 0 0 9.6M16.8 3.2a6.8 6.8 0 0 1 0 9.6M3.6 0.8a10.6 10.6 0 0 0 0 14.4M20.4 0.8a10.6 10.6 0 0 1 0 14.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  );
}

const VIDEO_KINDS = new Set(['resolution', 'hdr', 'sdr']);
const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' ');

/**
 * Une conversion réellement faite pendant la lecture : ce que contient le fichier (`from`), ce qui
 * est restitué (`to`) et pourquoi, en mots simples (`note`). `unsure` : déduite, pas vérifiable ici.
 */
export type Conversion = { kind: 'video' | 'audio'; from: string; to: string; note: string; unsure?: boolean };

/** Ce que le lecteur restitue (pastilles) et ce qu'il a dû convertir pour y arriver (détail ⓘ). */
export type LiveTech = { badges: TechBadge[]; conversions: Conversion[] };

/** Son : format et canaux en une seule pastille (« Dolby Digital 5.1 »). */
function audioBadges(badges: TechBadge[]): TechBadge[] {
  const audio = badges.find((b) => b.kind === 'audio');
  const ch = badges.find((b) => b.kind === 'channels');
  if (audio) return [{ ...audio, label: join(audio.label, ch?.label) }];
  return ch ? [ch] : [];
}

/** Petit « i » du bouton de détail : le cercle est celui du bouton, l'icône n'en dessine pas un second. */
function InfoGlyph() {
  return (
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="5" r="2.4" fill="currentColor" />
      <rect x="9.9" y="9.4" width="4.2" height="12" rx="2.1" fill="currentColor" />
    </svg>
  );
}

/**
 * Lecteur : ce qui sort vraiment, sur une ligne. Le bouton ⓘ n'apparaît que si quelque chose est
 * converti, et son détail ne montre que ces conversions (« Dolby Digital+ 5.1 → Dolby Digital 5.1 »).
 */
export function PlayerOutput({ live }: { live: LiveTech }) {
  const [open, setOpen] = useState(false);
  const { badges, conversions } = live;
  if (!badges.length && !conversions.length) return null;
  const pills = [...badges.filter((b) => VIDEO_KINDS.has(b.kind)), ...audioBadges(badges)];
  const shown = open && conversions.length > 0;
  return (
    <div class={`ptech-out${shown ? ' open' : ''}`}>
      <div class="ptech-row">
        {pills.length > 0 && (
          <ul class="ptech" aria-label={t('live.label')}>
            {pills.map((b) => (
              <TechPill key={b.kind + b.label} b={b} />
            ))}
          </ul>
        )}
        {conversions.length > 0 && (
          <button class="ptech-info" aria-label={t('live.details')} title={t('live.details')} aria-expanded={shown} onClick={() => setOpen(!open)}>
            <InfoGlyph />
          </button>
        )}
      </div>
      {shown && (
        <div class="ptech-panel" role="dialog" aria-label={t('live.details')}>
          <dl>
            {conversions.map((c) => (
              <Fragment key={c.kind + c.from + c.to}>
                <dt>{t(c.kind === 'video' ? 'live.video' : 'live.audio')}</dt>
                <dd>
                  <span class="ptech-conv">
                    {c.from} <span aria-hidden="true">→</span>
                    <span class="sr-only"> {t('live.becomes')} </span> {c.to}
                    {c.unsure && <i aria-hidden="true"> ?</i>}
                  </span>
                  <small>{c.note}</small>
                </dd>
              </Fragment>
            ))}
          </dl>
          {conversions.some((c) => c.unsure) && <p class="ptech-notes">{`${t('live.unsureNote').charAt(0).toUpperCase()}${t('live.unsureNote').slice(1)}.`}</p>}
        </div>
      )}
    </div>
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

/** Famille d'un format audio, pour savoir si deux noms désignent le même flux (Atmos voyage en DD+ ou TrueHD). */
function audioFamily(label: string | undefined): string[] {
  const l = (label ?? '').toLowerCase();
  if (!l) return [];
  if (l.includes('atmos')) return ['eac3', 'truehd'];
  if (l.includes('truehd')) return ['truehd'];
  if (l.startsWith('dolby digital+') || l.startsWith('dolby digital plus') || l === 'eac3') return ['eac3'];
  if (l.startsWith('dolby digital') || l === 'ac3') return ['ac3'];
  if (l.startsWith('dts') || l === 'dca') return ['dts'];
  return [l.replace(/[^a-z0-9]/g, '')];
}
const sameAudio = (a: string | undefined, b: string | undefined) => audioFamily(a).some((f) => audioFamily(b).includes(f));
/** Nombre de canaux d'une pastille (« 5.1 » → 6), pour comparer avec ce que sort le lecteur. */
const channelCount = (label: string | undefined) => (label === '7.1' ? 8 : label === '5.1' ? 6 : label === 'Mono' ? 1 : label ? (/st[ée]r[ée]o/i.test(label) ? 2 : Number.parseInt(label, 10) || 0) : 0);

interface MpvTrack {
  type?: string;
  selected?: boolean;
  codec?: string;
  'demux-channel-count'?: number;
}

/**
 * Lecteur natif (mpv) : ce qui sort vraiment, et ce qui a été converti pour y arriver.
 * - définition : image décodée (`video-params`), donc après un éventuel transcodage ;
 * - plage dynamique : ce que mpv envoie à l'écran (`video-target-params` : PQ = HDR10, HLG, sinon
 *   SDR). Sans cette information (mpv ancien), la plage de la source est donnée comme non vérifiée.
 *   Une source déjà SDR n'a pas de pastille : elle n'apprendrait rien ;
 * - son : format remis à la sortie (`audio-out-params`) : flux brut transmis tel quel, réencodé en
 *   Dolby Digital, ou PCM décodé avec son nombre de canaux ;
 * - conversions : d'après les pistes que mpv lit vraiment (`track-list`) et ce qu'il en sort.
 */
export function liveTechNative(s: Record<string, unknown>, meta: { tech?: TechBadge[]; playMode?: 'direct' | 'transcode' }): LiveTech {
  const out: TechBadge[] = [];
  const conversions: Conversion[] = [];
  const transcoded = meta.playMode === 'transcode';
  const tracks = (Array.isArray(s['track-list']) ? s['track-list'] : []) as MpvTrack[];
  const vTrack = tracks.find((x) => x.type === 'video' && x.selected);
  const aTrack = tracks.find((x) => x.type === 'audio' && x.selected);

  const vp = s['video-params'] as { dw?: number; dh?: number; w?: number; h?: number; gamma?: string } | undefined;
  const w = vp?.dw ?? vp?.w;
  const h = vp?.dh ?? vp?.h;
  const outRes = w && h ? resolutionLabel(w, h) : undefined;
  if (outRes) out.push({ kind: 'resolution', label: outRes });

  const srcHdr = src(meta.tech, 'hdr');
  const target = s['video-target-params'] as { gamma?: string } | undefined;
  let outRange: string | undefined;
  let rangeUnsure = false;
  if (vp?.gamma) {
    const srcIsHdr = vp.gamma === 'pq' || vp.gamma === 'hlg';
    if (target?.gamma) {
      if (target.gamma === 'pq') {
        outRange = 'HDR10';
        out.push({ kind: 'hdr', label: 'HDR10', hint: srcHdr && srcHdr !== 'HDR10' ? t('live.hdrAs').replace('{s}', srcHdr) : undefined });
      } else if (target.gamma === 'hlg') {
        outRange = 'HLG';
        out.push({ kind: 'hdr', label: 'HLG' });
      } else {
        outRange = 'SDR';
        // L'image n'a de pastille SDR que si elle a été convertie depuis du HDR.
        if (srcIsHdr) out.push({ kind: 'sdr', label: 'SDR', hint: t('live.toSdr').replace('{s}', srcHdr ?? 'HDR') });
      }
    } else if (srcIsHdr) {
      // mpv n'envoie jamais de Dolby Vision à l'écran (il l'applique lui-même) : au mieux du HDR10.
      const label = vp.gamma === 'hlg' ? 'HLG' : 'HDR10';
      outRange = label;
      rangeUnsure = true;
      out.push({ kind: 'hdr', label, unsure: true, hint: `${srcHdr && srcHdr !== label ? `${t('live.hdrAs').replace('{s}', srcHdr)} ; ` : ''}${t('live.screenUnknown')}` });
    } else outRange = 'SDR';

    if (!transcoded && srcIsHdr) {
      const from = srcHdr ?? (vp.gamma === 'hlg' ? 'HLG' : 'HDR10');
      if (outRange === 'SDR') conversions.push({ kind: 'video', from, to: 'SDR', note: t('conv.toSdr') });
      else if (from === 'Dolby Vision' && outRange === 'HDR10') conversions.push({ kind: 'video', from, to: 'HDR10', note: t('conv.dvToHdr10'), unsure: rangeUnsure });
    }
  }
  if (transcoded) {
    // La plage n'est nommée que si elle compte : une image SDR qui reste SDR n'apprend rien.
    const srcRange = srcHdr ?? 'SDR';
    const keepRange = srcRange !== 'SDR' || (!!outRange && outRange !== 'SDR');
    const from = join(src(meta.tech, 'resolution'), src(meta.tech, 'video'), keepRange ? srcRange : undefined);
    const to = join(outRes, videoCodecLabel(vTrack?.codec), keepRange ? outRange : undefined);
    if (from || to) conversions.push({ kind: 'video', from: from || '—', to: to || '—', note: t('conv.serverVideo'), unsure: rangeUnsure });
  }

  // La piste de la source : celle que mpv lit (l'utilisateur a pu en changer), nommée comme sur la
  // fiche quand c'est le même format (la fiche seule sait reconnaître Atmos ou DTS-HD MA).
  const techAudio = src(meta.tech, 'audio');
  const mpvAudio = audioCodecLabel(aTrack?.codec);
  const srcAudio = transcoded ? techAudio : mpvAudio && !sameAudio(mpvAudio, techAudio) ? mpvAudio : techAudio ?? mpvAudio;
  const srcCh = transcoded ? src(meta.tech, 'channels') : channelsLabel(aTrack?.['demux-channel-count']) || src(meta.tech, 'channels');
  const srcAudioDesc = join(srcAudio, srcCh);
  const serverAudio = transcoded && !!mpvAudio && !!techAudio && !sameAudio(mpvAudio, techAudio);
  if (serverAudio) conversions.push({ kind: 'audio', from: srcAudioDesc, to: join(mpvAudio, channelsLabel(aTrack?.['demux-channel-count'])), note: t('conv.serverAudio') });

  const ao = s['audio-out-params'] as { format?: string; 'channel-count'?: number } | undefined;
  if (ao?.format?.startsWith('spdif')) {
    if (s['ac3-encode'] && ao.format === 'spdif-ac3') {
      // L'encodeur garde les canaux de la piste, jusqu'au 5.1 que permet le Dolby Digital.
      const n = channelCount(srcCh);
      const ch = n ? channelsLabel(Math.min(n, 6)) : '5.1';
      out.push({ kind: 'audio', label: 'Dolby Digital' }, { kind: 'channels', label: ch });
      if (!serverAudio && srcAudio !== 'Dolby Digital') conversions.push({ kind: 'audio', from: srcAudioDesc || '—', to: join('Dolby Digital', ch), note: t('conv.ac3') });
    } else {
      // Atmos voyage dans le flux Dolby Digital+ ou TrueHD transmis tel quel.
      const atmos = srcAudio === 'Dolby Atmos' && (ao.format === 'spdif-eac3' || ao.format === 'spdif-truehd');
      const dtsCore = ao.format === 'spdif-dts' && !!srcAudio && srcAudio !== 'DTS' && sameAudio(srcAudio, 'DTS');
      out.push({ kind: 'audio', label: atmos ? 'Dolby Atmos' : SPDIF[ao.format] ?? ao.format.slice(6).toUpperCase(), hint: atmos ? t('live.atmosSent') : dtsCore ? t('live.dtsCore') : undefined });
      // Le nombre de canaux d'un flux brut est celui de la source (sauf le cœur DTS d'une piste DTS-HD).
      if (srcCh && !dtsCore) out.push({ kind: 'channels', label: srcCh });
      if (dtsCore && !serverAudio) conversions.push({ kind: 'audio', from: srcAudioDesc, to: 'DTS', note: t('conv.dtsCore') });
    }
  } else if (ao?.format) {
    out.push({ kind: 'audio', label: 'PCM' });
    const ch = channelsLabel(ao['channel-count']);
    if (ch) out.push({ kind: 'channels', label: ch });
    // Décoder n'est pas convertir ; mélanger sur moins de canaux, si.
    const n = channelCount(srcCh);
    if (!serverAudio && ao['channel-count'] && n > ao['channel-count']) conversions.push({ kind: 'audio', from: srcAudioDesc, to: join('PCM', ch), note: t('conv.downmix') });
  }
  return { badges: out, conversions };
}

/**
 * Lecteur web (navigateur, Android, TV) : le navigateur en dit moins. Sont sûrs la définition
 * de l'image reçue et ce que fait le serveur ; la plage dynamique et le son restitués ne le sont
 * pas (le navigateur ou le téléviseur décident), ils sont donnés comme non vérifiés. Seules les
 * conversions du serveur sont connues ici.
 */
export function liveTechWeb(v: HTMLVideoElement | null, plan: { mode: 'direct' | 'hls'; video?: 'copy' | 'transcode'; audio?: 'copy' | 'transcode' } | null, tech: TechBadge[]): LiveTech {
  if (!plan) return { badges: [], conversions: [] };
  const out: TechBadge[] = [];
  const conversions: Conversion[] = [];
  const outRes = v?.videoWidth && v.videoHeight ? resolutionLabel(v.videoWidth, v.videoHeight) : undefined;
  if (outRes) out.push({ kind: 'resolution', label: outRes });
  const srcHdr = src(tech, 'hdr');
  const videoTranscoded = plan.mode !== 'direct' && plan.video === 'transcode';
  if (srcHdr) {
    // Converti par le serveur : en général en SDR, mais le navigateur ne le confirme pas.
    if (videoTranscoded) out.push({ kind: 'sdr', label: 'SDR', unsure: true, hint: t('live.toSdr').replace('{s}', srcHdr) });
    else out.push({ kind: 'hdr', label: srcHdr, unsure: true, hint: t('live.screenUnknown') });
  }
  if (videoTranscoded) {
    const from = join(src(tech, 'resolution'), src(tech, 'video'), srcHdr);
    conversions.push({ kind: 'video', from: from || '—', to: join(outRes, srcHdr ? 'SDR' : undefined) || '…', note: t('conv.serverVideo'), unsure: !!srcHdr });
  }
  const a = src(tech, 'audio');
  if (plan.mode !== 'direct' && plan.audio === 'transcode') {
    out.push({ kind: 'audio', label: 'AAC', hint: t('live.serverAudio') });
    if (a !== 'AAC') conversions.push({ kind: 'audio', from: join(a, src(tech, 'channels')) || '—', to: 'AAC', note: t('conv.serverAudio') });
  } else if (a) out.push({ kind: 'audio', label: a, unsure: true, hint: t('live.browserAudio') });
  return { badges: out, conversions };
}

const clockOf = (d: Date) => d.toLocaleTimeString(settings.value.lang, { hour: '2-digit', minute: '2-digit' });

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
