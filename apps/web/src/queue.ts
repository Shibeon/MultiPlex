// File d'attente de lecture : « Mettre à la suite » et « Ajouter à la file d'attente ».
// Les lecteurs y prennent le titre suivant avant l'épisode suivant d'une série.
import { MAX_SHUFFLE, shuffleSeasons, shuffled, type MediaServer, type Metadata } from '@multiplex/core';
import { signal } from '@preact/signals';
import { load, save } from './settings';
import { isWatched, labels } from './ui';

export interface Queued {
  ratingKey: string;
  title: string;
  /** Mis en file par une lecture aléatoire (et non à la main) : la prochaine lecture le remplace. */
  shuffle?: true;
}

export const upNext = signal<Queued[]>(load<Queued[]>('mp.queue') ?? []);

function store(list: Queued[]): void {
  upNext.value = list;
  save('mp.queue', list.length ? list : null);
}

/** Ajoute en tête (`front`) ou en fin de file ; un titre déjà présent change de place. */
const entry = (m: Metadata): Queued => ({ ratingKey: m.ratingKey, title: m.type === 'episode' ? `${labels(m).title} · ${labels(m).sub}` : labels(m).title });

export function enqueue(items: Metadata[], front: boolean): void {
  const add = items.map(entry);
  const rest = upNext.value.filter((q) => !add.some((a) => a.ratingKey === q.ratingKey));
  store(front ? [...add, ...rest] : [...rest, ...add]);
}

/** Le titre commence : il quitte la file. */
export function dequeue(ratingKey: string): void {
  if (upNext.value.some((q) => q.ratingKey === ratingKey)) store(upNext.value.filter((q) => q.ratingKey !== ratingKey));
}

export function clearQueue(): void {
  store([]);
}

/** Pour une série ou une saison : le premier épisode pas encore vu. */
export async function resolvePlayable(srv: MediaServer, item: Metadata): Promise<Metadata | undefined> {
  if (item.type === 'movie' || item.type === 'episode' || item.type === 'clip') return item;
  const kids = await srv.children(item.ratingKey);
  if (item.type === 'season') return kids.find((e) => !e.viewCount) ?? kids[0];
  if (item.type === 'show') {
    const season = kids.find((s) => (s.index ?? 0) > 0 && !isWatched(s)) ?? kids.find((s) => (s.index ?? 0) > 0) ?? kids[0];
    return season && resolvePlayable(srv, season);
  }
  return undefined;
}

/**
 * Lecture aléatoire d'une série (hors épisodes spéciaux) ou d'une saison : tire l'ordre de tous
 * ses épisodes, met le reste en tête de file à la place d'une lecture aléatoire précédente (la file
 * remplie à la main suit) et rend le premier, à lancer.
 */
export async function startShuffle(srv: MediaServer, item: Metadata): Promise<Metadata | undefined> {
  let episodes: Metadata[] = [];
  if (item.type === 'season') episodes = await srv.children(item.ratingKey);
  else if (item.type === 'show') {
    const seasons = shuffleSeasons(await srv.children(item.ratingKey));
    episodes = (await Promise.all(seasons.map((s) => srv.children(s.ratingKey)))).flat();
  }
  const order = shuffled(episodes.filter((e) => e.type === 'episode')).slice(0, MAX_SHUFFLE);
  const [first, ...rest] = order;
  if (!first) return undefined;
  const add = rest.map((m): Queued => ({ ...entry(m), shuffle: true }));
  store([...add, ...upNext.value.filter((q) => !q.shuffle && !order.some((m) => m.ratingKey === q.ratingKey))]);
  return first;
}

/** Une lecture choisie (« Lecture ») met fin à la lecture aléatoire en cours ; la file manuelle reste. */
export function endShuffle(): void {
  if (upNext.value.some((q) => q.shuffle)) store(upNext.value.filter((q) => !q.shuffle));
}
