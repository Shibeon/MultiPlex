// File d'attente de lecture : « Mettre à la suite » et « Ajouter à la file d'attente ».
// Les lecteurs y prennent le titre suivant avant l'épisode suivant d'une série.
import type { MediaServer, Metadata } from '@multiplex/core';
import { signal } from '@preact/signals';
import { load, save } from './settings';
import { isWatched, labels } from './ui';

export interface Queued {
  ratingKey: string;
  title: string;
}

export const upNext = signal<Queued[]>(load<Queued[]>('mp.queue') ?? []);

function store(list: Queued[]): void {
  upNext.value = list;
  save('mp.queue', list.length ? list : null);
}

/** Ajoute en tête (`front`) ou en fin de file ; un titre déjà présent change de place. */
export function enqueue(items: Metadata[], front: boolean): void {
  const add = items.map((m) => ({ ratingKey: m.ratingKey, title: m.type === 'episode' ? `${labels(m).title} — ${labels(m).sub}` : labels(m).title }));
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
