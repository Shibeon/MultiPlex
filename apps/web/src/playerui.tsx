import type { ComponentChildren } from 'preact';
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

/** Son : format et canaux en une seule pastille (« Dolby Digital 5.1 »). */
function audioBadges(badges: TechBadge[]): TechBadge[] {
  const audio = badges.find((b) => b.kind === 'audio');
  const ch = badges.find((b) => b.kind === 'channels');
  const out: TechBadge[] = [];
  if (audio) out.push({ ...audio, label: join(audio.label, ch?.label) });
  else if (ch) out.push(ch);
  return [...out, ...badges.filter((b) => b.kind === 'proc')];
}

/**
 * Lecteur : ce qui sort vraiment, sur une ligne, et un bouton ⓘ qui ouvre le détail
 * « source → sortie » avec l'explication de chaque conversion.
 */
export function PlayerOutput({ badges, source }: { badges: TechBadge[] | undefined; source: TechBadge[] }) {
  const [open, setOpen] = useState(false);
  if (!badges?.length) return null;
  const video = badges.filter((b) => VIDEO_KINDS.has(b.kind));
  const audio = audioBadges(badges);
  const label = (list: TechBadge[], kind: string) => list.find((b) => b.kind === kind)?.label;
  const srcVideo = join(label(source, 'resolution'), label(source, 'hdr') ?? (label(source, 'resolution') ? 'SDR' : undefined));
  const outVideo = join(label(badges, 'resolution'), label(badges, 'hdr') ?? label(badges, 'sdr'));
  const srcAudio = join(label(source, 'audio'), label(source, 'channels'));
  const outAudio = audio[0]?.kind !== 'proc' ? audio[0]?.label : undefined;
  const notes = [...new Set(badges.map((b) => b.hint).filter((h): h is string => !!h))];
  if (badges.some((b) => b.unsure)) notes.push(t('live.unsureNote'));
  return (
    <div class={`ptech-out${open ? ' open' : ''}`}>
      <div class="ptech-row">
        <ul class="ptech" aria-label={t('live.label')}>
          {/* Traitement du son (réencodé, transmis tel quel) : seulement dans le détail ⓘ. */}
          {[...video, ...audio.filter((b) => b.kind !== 'proc')].map((b) => (
            <TechPill key={b.kind + b.label} b={b} />
          ))}
        </ul>
        <button class="ptech-info" aria-label={t('live.details')} title={t('live.details')} aria-expanded={open} onClick={() => setOpen(!open)}>
          <Icon name="info" size={20} />
        </button>
      </div>
      {open && (
        <div class="ptech-panel" role="dialog" aria-label={t('live.details')}>
          <dl>
            {(srcVideo || outVideo) && (
              <>
                <dt>{t('live.video')}</dt>
                <dd>
                  <b>{t('live.source')} :</b> {srcVideo || '—'}
                  <br />
                  <b>{t('live.output')} :</b> {outVideo || '—'}
                </dd>
              </>
            )}
            {(srcAudio || outAudio) && (
              <>
                <dt>{t('live.audio')}</dt>
                <dd>
                  <b>{t('live.source')} :</b> {srcAudio || '—'}
                  <br />
                  <b>{t('live.output')} :</b> {outAudio || '—'}
                </dd>
              </>
            )}
          </dl>
          {notes.length > 0 && (
            <ul class="ptech-notes">
              {notes.map((n) => (
                <li key={n}>{n.charAt(0).toUpperCase() + n.slice(1)}.</li>
              ))}
            </ul>
          )}
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
      proc.push({ kind: 'proc', label: t('native.audioEncoded'), hint: t('live.encodedNote').replace('{s}', src(meta.tech, 'audio') ?? t('live.original')) });
    } else {
      const srcAudio = src(meta.tech, 'audio');
      // Atmos voyage dans le flux Dolby Digital+ ou TrueHD transmis tel quel.
      const atmos = srcAudio === 'Dolby Atmos' && (ao.format === 'spdif-eac3' || ao.format === 'spdif-truehd');
      const dtsCore = ao.format === 'spdif-dts' && !!srcAudio && srcAudio !== 'DTS';
      out.push({ kind: 'audio', label: atmos ? 'Dolby Atmos' : SPDIF[ao.format] ?? ao.format.slice(6).toUpperCase(), hint: atmos ? t('live.atmosSent') : dtsCore ? t('live.dtsCore') : undefined });
      // Le nombre de canaux d'un flux brut est celui de la source (sauf le cœur DTS d'une piste DTS-HD).
      const ch = src(meta.tech, 'channels');
      if (ch && !dtsCore) out.push({ kind: 'channels', label: ch });
      proc.push({ kind: 'proc', label: 'Passthrough', hint: atmos || dtsCore ? undefined : t('live.passNote') });
    }
  } else if (ao?.format) {
    out.push({ kind: 'audio', label: 'PCM' });
    const ch = channelsLabel(ao['channel-count']);
    if (ch) out.push({ kind: 'channels', label: ch });
  }
  // Lecture directe ou transcodage : pas de pastille, l'utilisateur n'en a que faire. Le
  // transcodage reste expliqué dans le détail ⓘ (source → sortie et note).
  if (meta.playMode === 'transcode') proc.push({ kind: 'proc', label: t('live.transcoding'), hint: t('live.transcodeNote') });
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
  // Pas de pastille de mode : le transcodage de l'image n'est expliqué que dans le détail ⓘ.
  if (plan.mode !== 'direct' && plan.video !== 'copy') out.push({ kind: 'proc', label: t('live.transcoding'), hint: t('live.transcodeNote') });
  return out;
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
