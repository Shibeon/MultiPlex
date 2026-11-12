// Téléchargements (application de bureau) : un panneau en bas à droite suit chaque fichier,
// de la fenêtre « Enregistrer sous » jusqu'à la fin, avec progression, débit et temps restant.
import type { MediaServer, Metadata } from '@multiplex/core';
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { t } from './i18n';
import { native, type DownloadEvent } from './native';
import { Icon, labels } from './ui';

type Transfer = DownloadEvent & { title: string };

export const transfers = signal<Transfer[]>([]);

function put(id: number, patch: Partial<Transfer>): void {
  const list = transfers.value;
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) transfers.value = [...list, { id, state: 'waiting', name: '', title: '', received: 0, total: 0, ...patch }];
  else transfers.value = list.map((x, j) => (j === i ? { ...x, ...patch } : x));
}

function drop(id: number): void {
  transfers.value = transfers.value.filter((x) => x.id !== id);
}

function fileName(m: Metadata): string {
  const part = m.Media?.[0]?.Part?.[0];
  const base = part?.file?.split(/[\\/]/).pop();
  return base || `${labels(m).title}.${part?.container ?? m.Media?.[0]?.container ?? 'mkv'}`;
}

export const canDownload = (m: Metadata | undefined) => !!native?.download && !!m?.Media?.[0]?.Part?.[0]?.key && (m.type === 'movie' || m.type === 'episode');

/** Lance le téléchargement : la ligne apparaît tout de suite dans le panneau, avant même le choix de l'emplacement. */
export async function startDownload(srv: MediaServer, m: Metadata): Promise<boolean> {
  const req = srv.fileRequest(m.Media![0].Part[0].key);
  const id = await native!.download!(req.url, req.headers, fileName(m));
  if (!id) return false;
  const { title, sub } = labels(m);
  put(id, { state: 'waiting', name: fileName(m), title: m.type === 'episode' ? `${title} — ${sub}` : title });
  return true;
}

const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} Go` : n >= 1e6 ? `${Math.round(n / 1e6)} Mo` : `${Math.round(n / 1e3)} Ko`);
function left(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `${Math.ceil(sec)} s`;
  if (sec < 3600) return `${Math.ceil(sec / 60)} min`;
  return `${Math.floor(sec / 3600)} h ${String(Math.ceil((sec % 3600) / 60)).padStart(2, '0')}`;
}

function Row({ x }: { x: Transfer }) {
  const n = native!;
  const pct = x.total ? Math.min(100, (x.received / x.total) * 100) : 0;
  const done = x.state === 'completed';
  const failed = x.state === 'interrupted';
  const status =
    x.state === 'waiting'
      ? t('dl.waiting')
      : done
        ? `${t('dl.done')} · ${size(x.total || x.received)}`
        : failed
          ? t('dl.failed')
          : x.state === 'paused'
            ? `${t('dl.paused')} · ${size(x.received)}${x.total ? ` / ${size(x.total)}` : ''}`
            : [x.total ? `${size(x.received)} / ${size(x.total)}` : size(x.received), x.rate ? `${size(x.rate)}/s` : '', x.rate && x.total ? `${left((x.total - x.received) / x.rate)} ${t('dl.left')}` : ''].filter(Boolean).join(' · ');
  return (
    <li class={`dl-row dl-${x.state}`}>
      <div class="dl-text">
        <strong title={x.name}>{x.title || x.name}</strong>
        <small>{status}</small>
      </div>
      <div class="dl-actions">
        {(x.state === 'progressing' || x.state === 'stalled') && (
          <button class="btn icon-btn" aria-label={t('dl.pause')} title={t('dl.pause')} onClick={() => n.downloadAction?.(x.id, 'pause')}>
            <Icon name="pause" size={16} />
          </button>
        )}
        {x.state === 'paused' && (
          <button class="btn icon-btn" aria-label={t('dl.resume')} title={t('dl.resume')} onClick={() => n.downloadAction?.(x.id, 'resume')}>
            <Icon name="play" size={16} />
          </button>
        )}
        {done && x.path && (
          <button class="btn" onClick={() => n.showFile?.(x.path!)}>
            {t('menu.showFile')}
          </button>
        )}
        <button
          class="btn icon-btn"
          aria-label={done || failed ? t('dl.dismiss') : t('dl.cancel')}
          title={done || failed ? t('dl.dismiss') : t('dl.cancel')}
          onClick={() => (done || failed ? drop(x.id) : n.downloadAction?.(x.id, 'cancel'))}
        >
          <Icon name="close" size={16} />
        </button>
      </div>
      {!done && !failed && (
        <span class={`dl-bar${x.state === 'waiting' || !x.total ? ' busy' : ''}`}>
          <i style={{ width: `${pct}%` }} />
        </span>
      )}
    </li>
  );
}

/** Panneau des téléchargements ; absent tant qu'il n'y en a pas. */
export function DownloadsPanel() {
  const [folded, setFolded] = useState(false);
  useEffect(
    () =>
      native?.onDownload?.((ev) => {
        // Fenêtre « Enregistrer sous » refermée sans choisir, ou annulation : la ligne s'en va.
        if (ev.state === 'cancelled') return drop(ev.id);
        put(ev.id, ev);
        if (ev.state === 'progressing') setFolded(false);
      }),
    [],
  );
  const list = transfers.value;
  if (!list.length) return null;
  const active = list.filter((x) => x.state !== 'completed' && x.state !== 'interrupted').length;
  return (
    <section class={`downloads${folded ? ' folded' : ''}`} aria-label={t('dl.title')}>
      <header>
        <Icon name="download" size={18} />
        <strong>{active ? t('dl.active').replace('{n}', String(active)) : t('dl.title')}</strong>
        <button class="btn icon-btn" aria-label={folded ? t('dl.unfold') : t('dl.fold')} aria-expanded={!folded} onClick={() => setFolded(!folded)}>
          <Icon name={folded ? 'up' : 'down'} size={16} />
        </button>
      </header>
      {!folded && (
        <ul>
          {list.map((x) => (
            <Row key={x.id} x={x} />
          ))}
        </ul>
      )}
    </section>
  );
}
