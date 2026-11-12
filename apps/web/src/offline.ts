// Hors ligne : ce que l'interface sait de la bibliothèque téléchargée, et comment elle y ajoute
// des titres. Le stockage lui-même appartient à la plateforme (`native.offline`) : aujourd'hui
// l'application de bureau ; demain, une autre plateforme peut fournir le même contrat.
import { randomId, type MediaServer, type Metadata, type Stream } from '@multiplex/core';
import { signal } from '@preact/signals';
import { native, type OfflineEntry, type OfflineInfo } from './native';
import { labels } from './ui';

export const offlineApi = native?.offline;
export const offlineInfo = signal<OfflineInfo | null>(null);

export async function refreshOffline(): Promise<OfflineInfo | null> {
  if (!offlineApi) return null;
  try {
    offlineInfo.value = await offlineApi.info();
  } catch {
    /* bibliothèque illisible : on garde l'état connu */
  }
  return offlineInfo.value;
}

if (offlineApi) {
  void refreshOffline();
  offlineApi.onChanged(() => void refreshOffline());
}

export const offlineEntry = (serverId: string, ratingKey: string): OfflineEntry | undefined => offlineInfo.value?.entries.find((e) => e.serverId === serverId && e.ratingKey === ratingKey);

/** Titres qu'on peut garder hors ligne : un film, un épisode, une saison, une série. */
export const canKeepOffline = (m: Metadata | undefined) => !!offlineApi && !!m && ['movie', 'episode', 'season', 'show'].includes(m.type);

/** Pour une série : les épisodes pas encore vus, dans l'ordre, au plus `max`. */
async function nextEpisodes(srv: MediaServer, show: Metadata, max: number): Promise<Metadata[]> {
  const seasons = (await srv.children(show.ratingKey)).filter((s) => (s.index ?? 0) > 0).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: Metadata[] = [];
  for (const s of seasons) {
    if (out.length >= max) break;
    const eps = await srv.children(s.ratingKey);
    out.push(...eps.filter((e) => !e.viewCount));
  }
  return out.slice(0, max);
}

const streamLabel = (s: Stream) => s.extendedDisplayTitle ?? s.displayTitle ?? s.title ?? s.language ?? `#${s.id}`;

/** Un fichier : fiche complète, puis la plateforme télécharge fichier, images et sous-titres. */
async function keepOne(srv: MediaServer, ratingKey: string): Promise<'added' | 'already' | 'failed'> {
  const m = await srv.metadata(ratingKey);
  const part = m.Media?.[0]?.Part?.[0];
  if (!part?.key) return 'failed';
  const req = srv.fileRequest(part.key);
  const { title, sub } = labels(m);
  const posterPath = m.type === 'episode' ? (m.grandparentThumb ?? m.parentThumb ?? m.thumb) : m.thumb;
  const artPath = m.art ?? (m as Metadata & { grandparentArt?: string }).grandparentArt;
  const images: { kind: 'poster' | 'art'; url: string }[] = [];
  if (posterPath) images.push({ kind: 'poster', url: srv.image(posterPath, 600, 900) });
  if (artPath) images.push({ kind: 'art', url: srv.image(artPath, 1920, 1080) });
  const external = (part.Stream ?? []).filter((s) => s.streamType === 3 && s.key);
  const r = await offlineApi!.add({
    serverId: srv.id,
    ratingKey: m.ratingKey,
    url: req.url,
    headers: req.headers,
    fileName: part.file?.split(/[\\/]/).pop() || `${title}.${part.container ?? m.Media?.[0]?.container ?? 'mkv'}`,
    title,
    sub,
    meta: m,
    images,
    subs: external.map((s) => ({ url: srv.fileRequest(s.key!).url, label: streamLabel(s), ext: s.codec === 'subrip' ? 'srt' : (s.codec ?? 'srt') })),
  });
  return !r.ok ? 'failed' : r.already ? 'already' : 'added';
}

/**
 * Garde un titre hors ligne. Une saison : tous ses épisodes ; une série : ses prochains
 * épisodes pas encore vus. Renvoie le nombre de fichiers ajoutés et déjà présents.
 */
export async function keepOffline(srv: MediaServer, item: Metadata, maxEpisodes = 5): Promise<{ added: number; already: number; failed: number }> {
  const keys =
    item.type === 'season'
      ? (await srv.children(item.ratingKey)).map((e) => e.ratingKey)
      : item.type === 'show'
        ? (await nextEpisodes(srv, item, maxEpisodes)).map((e) => e.ratingKey)
        : [item.ratingKey];
  const count = { added: 0, already: 0, failed: 0 };
  // L'un après l'autre : chaque ajout lit la fiche puis lance le fichier ; les téléchargements, eux, avancent ensemble.
  for (const k of keys) {
    const r = await keepOne(srv, k).catch(() => 'failed' as const);
    count[r]++;
  }
  await refreshOffline();
  return count;
}

/** De retour en ligne : positions et « vu » enregistrés hors ligne repartent vers ce serveur. */
export async function syncOffline(srv: MediaServer): Promise<number> {
  const info = await refreshOffline();
  const dirty = info?.entries.filter((e) => e.dirty && e.serverId === srv.id) ?? [];
  const done: string[] = [];
  for (const e of dirty) {
    try {
      if (e.watched) await srv.scrobble(e.ratingKey, true);
      else if (e.viewOffset > 0) await srv.timeline({ ratingKey: e.ratingKey, state: 'stopped', timeMs: e.viewOffset, durationMs: e.meta.duration ?? 0, session: randomId() });
      done.push(e.id);
    } catch {
      /* serveur qui refuse : on réessaiera à la prochaine connexion */
    }
  }
  if (done.length) offlineApi!.synced(done);
  return done.length;
}
