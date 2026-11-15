// Menu d'un titre (clic droit, touche Menu, ou bouton « ⋯ » d'une affiche), comme dans
// l'application Plex : liste de suivi, partage, file d'attente, bande-annonce, listes de
// lecture, vu / non vu, « Continuer à regarder », téléchargement et informations.
import { discoverId, type Metadata } from '@multiplex/core';
import { tvDevice } from './platform';
import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { formatDuration, t } from './i18n';
import { native } from './native';
import { enqueue, resolvePlayable, upNext, clearQueue } from './queue';
import { go } from './router';
import { discover, invalidate, managedProfile, server, useData } from './store';
import { Icon, isWatched, labels } from './ui';
import { canDownload as downloadable, startDownload } from './downloads';
import { canKeepOffline, keepOffline, offlineEntry } from './offline';
import { openCast } from './cast';
import { canCast } from './castui';

interface MenuTarget {
  kind: 'item' | 'discover';
  id: string;
  x: number;
  y: number;
  /** Ce que la carte connaît déjà du titre, affiché en attendant la fiche complète. */
  hint?: Metadata;
  /** Ouvert depuis la rangée « Continuer à regarder ». */
  fromContinue?: boolean;
}

const target = signal<MenuTarget | null>(null);
const infoOf = signal<string | null>(null);
/** Ouvre la fenêtre « Voir les informations » d'un titre du serveur. */
export const showInfo = (id: string) => (infoOf.value = id);
export const toast = signal<{ text: string; action?: { label: string; run: () => void } } | null>(null);

let toastTimer = 0;
export function say(text: string, action?: { label: string; run: () => void }): void {
  toast.value = { text, action };
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = null), action ? 7000 : 3500);
}

/** Ouvre le menu d'un titre du serveur sous un élément (bouton « ⋯ »). */
export function openItemMenu(item: Metadata, anchor: HTMLElement): void {
  const box = anchor.getBoundingClientRect();
  target.value = { kind: 'item', id: item.ratingKey, x: box.left, y: box.bottom + 4, hint: item, fromContinue: !!anchor.closest('[data-hub*="continue" i], [data-hub*="ondeck" i]') };
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

/** Lien public vers la fiche d'un titre dans le catalogue Plex (ouvrable sans MultiPlex). */
function shareLink(did: string): string {
  return `https://app.plex.tv/desktop/#!/provider/tv.plex.provider.discover/details?key=${encodeURIComponent(`/library/metadata/${did}`)}`;
}

function Entry({ icon, label, onClick, disabled, children }: { icon?: string; label: string; onClick?: () => void; disabled?: boolean; children?: ComponentChildren }) {
  return (
    <button type="button" role="menuitem" class="menu-entry" disabled={disabled} onClick={onClick}>
      <span class="menu-icon">{icon && <Icon name={icon} size={18} />}</span>
      <span class="menu-label">{label}</span>
      {children}
    </button>
  );
}

function Menu({ at }: { at: MenuTarget }) {
  const srv = server.value!;
  const d = discover.value;
  // Un profil géré n'a pas de liste de suivi : l'entrée « Ajouter à ma liste » disparaît.
  const list = managedProfile.value ? null : d;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: at.x, y: at.y });

  const local = useData(at.kind === 'item' ? `${srv.id}:item:${at.id}` : null, () => srv.metadata(at.id));
  const online = useData(at.kind === 'discover' && d ? `disc:item:${at.id}` : null, () => d!.details(at.id));
  const m: Metadata | undefined = at.kind === 'item' ? (local.data ?? at.hint) : online.data;
  const full = at.kind === 'item' ? !!local.data : !!online.data;
  // Pour un épisode, la liste de suivi et le partage visent la série.
  const did = at.kind === 'discover' ? at.id : (discoverId(m?.guid) ?? discoverId(m?.grandparentGuid));
  const listed = useData(at.kind === 'item' && list && did ? `disc:state:${did}` : null, () => list!.isWatchlisted(did!));
  const onList = at.kind === 'discover' ? online.data?.watchlisted : listed.data;
  const canTrailer = at.kind === 'item' && !!m && ['movie', 'show'].includes(m.type);
  const trailer = useData(canTrailer ? `${srv.id}:trailer:${at.id}` : null, () => srv.trailer(at.id).catch(() => undefined));
  // « Retirer de Continuer à regarder » seulement si le titre y est vraiment (la liste est rechargée après chaque action).
  const resumable = useData(at.kind === 'item' ? `${srv.id}:continue` : null, () => srv.continueWatching().catch(() => []));
  const inContinue = !!resumable.data?.some((x) => x.ratingKey === at.id);

  const close = () => (target.value = null);
  const done = (text: string, action?: { label: string; run: () => void }) => {
    close();
    say(text, action);
  };
  const run = (job: () => Promise<unknown>, text: string) => {
    close();
    job().then(
      () => {
        invalidate(`${srv.id}:`);
        say(text);
      },
      () => say(t('menu.failed')),
    );
  };

  // Le menu reste dans la fenêtre.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x = Math.max(8, Math.min(at.x, innerWidth - w - 8));
    const y = at.y + h > innerHeight - 8 ? Math.max(8, Math.min(at.y - h, innerHeight - h - 8)) : at.y;
    setPos({ x, y });
  }, [at, m?.type, full, trailer.data, onList]);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.menu-entry:not([disabled])')?.focus();
  }, [full]);

  useEffect(() => {
    const away = (e: Event) => !ref.current?.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return close();
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const all = [...(ref.current?.querySelectorAll<HTMLElement>('.menu-entry:not([disabled])') ?? [])];
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
    };
    addEventListener('mousedown', away, true);
    addEventListener('wheel', close, { passive: true });
    addEventListener('resize', close);
    addEventListener('hashchange', close);
    addEventListener('keydown', key);
    return () => {
      removeEventListener('mousedown', away, true);
      removeEventListener('wheel', close);
      removeEventListener('resize', close);
      removeEventListener('hashchange', close);
      removeEventListener('keydown', key);
    };
  }, []);

  const playable = !!m && ['movie', 'episode', 'show', 'season'].includes(m.type);
  const watched = !!m && isWatched(m);
  const partly = !!m && (m.leafCount !== undefined ? (m.viewedLeafCount ?? 0) > 0 : !!m.viewCount);
  const canDownload = downloadable(m);

  const queue = async (front: boolean) => {
    close();
    try {
      const first = m && (await resolvePlayable(srv, m));
      if (!first) return say(t('menu.failed'));
      enqueue([first], front);
      say(t(front ? 'menu.queuedNext' : 'menu.queuedEnd').replace('{n}', String(upNext.value.length)), { label: t('menu.clearQueue'), run: clearQueue });
    } catch {
      say(t('menu.failed'));
    }
  };

  return (
    <div ref={ref} class="menu" role="menu" aria-label={m ? labels(m).title : ''} style={{ left: `${pos.x}px`, top: `${pos.y}px` }} onContextMenu={(e) => e.preventDefault()}>
      {m && <div class="menu-title">{labels(m).title}</div>}
      {!m && <span class="menu-note">{t('common.loading')}</span>}
      {at.kind === 'item' && playable && (
        <Entry
          icon="play"
          label={m?.viewOffset ? t('item.resume') : t('item.play')}
          onClick={() => {
            close();
            void resolvePlayable(srv, m!).then((p) => p && go(`/play/${p.ratingKey}`));
          }}
        />
      )}
      {list && did && (
        <Entry
          icon={onList ? 'check' : 'bookmark'}
          label={onList ? t('menu.unlist') : t('menu.list')}
          disabled={onList === undefined}
          onClick={() =>
            run(async () => {
              await list.setWatchlisted(did, !onList);
              invalidate('disc:');
            }, t(onList ? 'menu.unlisted' : 'menu.listed'))
          }
        />
      )}
      {/* Téléviseur : pas de presse-papiers où coller le lien. */}
      {did && !tvDevice && <Entry icon="share" label={t('menu.share')} onClick={() => void copy(shareLink(did)).then(() => done(t('menu.copied')))} />}
      {at.kind === 'item' && playable && (
        <>
          <Entry icon="next" label={t('menu.playNext')} onClick={() => void queue(true)} />
          <Entry icon="queue" label={t('menu.addQueue')} onClick={() => void queue(false)} />
        </>
      )}
      {at.kind === 'item' && playable && canCast(m) && (
        <Entry
          icon="cast"
          label={t('menu.cast')}
          onClick={() => {
            close();
            openCast(m!, (m!.viewOffset ?? 0) / 1000);
          }}
        />
      )}
      {canTrailer && trailer.data !== null && (
        <Entry
          icon="movie"
          label={t('menu.trailer')}
          disabled={!trailer.data}
          onClick={() => {
            close();
            go(`/play/${trailer.data}?t=0`);
          }}
        />
      )}
      {at.kind === 'item' && playable && (
        <>
          <div class="menu-sep" />
          {!watched && <Entry icon="check" label={t('menu.watched')} onClick={() => run(() => srv.scrobble(at.id, true), t('menu.markedWatched'))} />}
          {partly && <Entry icon="eye" label={t('menu.unwatched')} onClick={() => run(() => srv.scrobble(at.id, false), t('menu.markedUnwatched'))} />}
          {inContinue && <Entry icon="close" label={t('menu.removeContinue')} onClick={() => run(() => srv.removeFromContinueWatching(at.id), t('menu.removedContinue'))} />}
          {canKeepOffline(m) && at.kind === 'item' && (() => {
            const kept = m!.type === 'movie' || m!.type === 'episode' ? offlineEntry(srv.id, m!.ratingKey) : undefined;
            return kept?.state === 'ready' ? (
              <Entry icon="check" label={t('off.available')} onClick={() => (close(), go('/offline'))} />
            ) : (
              <Entry
                icon="download"
                label={kept?.state === 'downloading' ? t('off.inProgress') : m!.type === 'season' ? t('off.keepSeason') : m!.type === 'show' ? t('off.keepShow') : t('off.keep')}
                disabled={kept?.state === 'downloading'}
                onClick={() => {
                  close();
                  say(t('off.adding'));
                  void keepOffline(srv, m!).then(
                    (c) => say(c.failed && !c.added ? t('menu.failed') : t('off.added').replace('{n}', String(c.added + c.already)), { label: t('nav.offline'), run: () => go('/offline') }),
                    () => say(t('menu.failed')),
                  );
                }}
              />
            );
          })()}
          {canDownload && (
            <Entry
              icon="download"
              label={t('menu.download')}
              onClick={() => {
                close();
                say(t('dl.choose'));
                void startDownload(srv, m!).then(
                  (ok) => !ok && say(t('menu.failed')),
                  () => say(t('menu.failed')),
                );
              }}
            />
          )}
          {m?.type === 'episode' && m.grandparentRatingKey && <Entry icon="show" label={t('menu.goShow')} onClick={() => (close(), go(`/item/${m.grandparentRatingKey}`))} />}
          {m?.type === 'episode' && m.parentRatingKey && <Entry icon="show" label={t('menu.goSeason')} onClick={() => (close(), go(`/item/${m.parentRatingKey}`))} />}
        </>
      )}
      <Entry
        icon="info"
        label={t('menu.info')}
        onClick={() => {
          close();
          if (at.kind === 'item') infoOf.value = at.id;
          else go(`/discover/${at.id}`);
        }}
      />
    </div>
  );
}

function Row({ k, v }: { k: string; v: ComponentChildren }) {
  return v === undefined || v === '' || v === null ? null : (
    <div>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

const size = (bytes?: number) => (bytes ? (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} Go` : `${Math.round(bytes / 1e6)} Mo`) : undefined);
const kbps = (n?: number) => (n ? (n >= 1000 ? `${(n / 1000).toFixed(1)} Mb/s` : `${n} kb/s`) : undefined);
const date = (sec?: number) => (sec ? new Date(sec * 1000).toLocaleDateString() : undefined);

/** « Voir les informations » : fichiers, pistes, débits, tel que le serveur les décrit. */
function InfoDialog({ id }: { id: string }) {
  const srv = server.value!;
  const { data: m, error } = useData(`${srv.id}:item:${id}`, () => srv.metadata(id));
  const close = () => (infoOf.value = null);
  const KIND: Record<number, string> = { 1: t('info.video'), 2: t('info.audio'), 3: t('info.subtitle') };
  return (
    <div class="whatsnew-veil" role="dialog" aria-modal="true" aria-label={t('menu.info')} onClick={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div class="whatsnew info-dialog">
        <h2>{m ? labels(m).title : t('menu.info')}</h2>
        {m && labels(m).sub && <p class="muted">{labels(m).sub}</p>}
        {error && <p class="muted">{t('menu.failed')}</p>}
        {m && (
          <dl class="info-list">
            <Row k={t('info.type')} v={m.type} />
            <Row k={t('info.duration')} v={formatDuration(m.duration)} />
            <Row k={t('info.added')} v={date(m.addedAt)} />
            <Row k={t('info.episodes')} v={m.leafCount !== undefined ? `${m.viewedLeafCount ?? 0} / ${m.leafCount}` : undefined} />
            <Row k={t('info.studio')} v={m.studio} />
          </dl>
        )}
        {m?.Media?.map((media, i) => (
          <section key={media.id}>
            <h3>
              {t('info.version')} {m.Media!.length > 1 ? i + 1 : ''}
            </h3>
            <dl class="info-list">
              <Row k={t('info.container')} v={media.container?.toUpperCase()} />
              <Row k={t('info.resolution')} v={media.width && media.height ? `${media.width} × ${media.height}${media.videoFrameRate ? ` · ${media.videoFrameRate}` : ''}` : media.videoResolution} />
              <Row k={t('info.bitrate')} v={kbps(media.bitrate)} />
              {media.Part.map((p) => (
                <>
                  <Row k={t('info.file')} v={p.file && <code>{p.file}</code>} />
                  <Row k={t('info.size')} v={size(p.size)} />
                </>
              ))}
            </dl>
            <ul class="info-streams">
              {media.Part[0]?.Stream?.map((s) => (
                <li key={s.id}>
                  <b>{KIND[s.streamType] ?? '—'}</b> {s.extendedDisplayTitle ?? s.displayTitle ?? s.codec}
                  {s.bitrate ? <span class="muted"> · {kbps(s.bitrate)}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
        <button class="btn primary" autofocus onClick={close}>
          {t('new.ok')}
        </button>
      </div>
    </div>
  );
}

/**
 * Point d'ancrage unique : le clic droit sur n'importe quelle carte de titre ouvre le menu,
 * sans que chaque page ait à s'en occuper. Affiche aussi les messages et la fenêtre d'informations.
 */
export function ItemMenuHost() {
  useEffect(() => {
    const open = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href^="#/item/"], a[href^="#/discover/"]');
      const match = link && /^#\/(item|discover)\/([^/?]+)/.exec(link.getAttribute('href') ?? '');
      if (!link || !match || link.closest('.menu')) return;
      e.preventDefault();
      // Touche Menu du clavier : pas de position de souris, on se place sous la carte.
      const box = link.getBoundingClientRect();
      const keyboard = e.clientX === 0 && e.clientY === 0;
      target.value = {
        kind: match[1] as 'item' | 'discover',
        id: decodeURIComponent(match[2]),
        x: keyboard ? box.left + 12 : e.clientX,
        y: keyboard ? box.top + 12 : e.clientY,
        fromContinue: !!link.closest('[data-hub*="continue" i], [data-hub*="ondeck" i]'),
      };
    };
    addEventListener('contextmenu', open);
    const off = native?.onDownload?.((ev) => {
      if (ev.state === 'completed') say(t('menu.downloaded').replace('{name}', ev.name), ev.path ? { label: t('menu.showFile'), run: () => native!.showFile?.(ev.path!) } : undefined);
      else if (ev.state === 'interrupted') say(t('menu.downloadFailed'));
    });
    return () => {
      removeEventListener('contextmenu', open);
      off?.();
    };
  }, []);
  const at = target.value;
  const note = toast.value;
  return (
    <>
      {at && <Menu key={`${at.kind}${at.id}${at.x}${at.y}`} at={at} />}
      {infoOf.value && <InfoDialog id={infoOf.value} />}
      {note && (
        <div class="toast" role="status">
          <span>{note.text}</span>
          {note.action && (
            <button
              class="btn"
              onClick={() => {
                note.action!.run();
                toast.value = null;
              }}
            >
              {note.action.label}
            </button>
          )}
        </div>
      )}
    </>
  );
}
