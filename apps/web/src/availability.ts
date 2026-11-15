import {
  buildGuidIndex,
  externalIds,
  libraryStamp,
  needsIndex,
  plexGuid,
  resolveAvailability,
  type AvailabilityResult,
  type Library,
  type MediaServer,
  type Metadata,
} from '@multiplex/core';
import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { server } from './store';

/**
 * Disponibilité des titres du catalogue Plex (liste de suivi, filmographies) sur le serveur de
 * l'utilisateur. Les règles de correspondance (identifiant Plex, puis identifiants externes) sont
 * dans availability.ts de @multiplex/core ; ici, les vérifications et leur cache.
 *
 * - Cache par serveur : un autre serveur, ou le même revu par un autre profil du foyer (nouvelle
 *   connexion, donc nouvel objet serveur), repart de zéro.
 * - Pas de rafale : une seule file pour toute l'app, `CONCURRENCY` recherches à la fois ; l'index
 *   des identifiants externes n'est lu qu'au besoin, une fois par état de la bibliothèque.
 * - Rafraîchissement : quand l'empreinte des bibliothèques change (analyse, ajout de titres, voir
 *   `libraryStamp`), les résultats sont revus ; ils restent affichés pendant la nouvelle
 *   vérification. Les titres « à vérifier » sont retentés à chaque relecture des bibliothèques.
 */

const CONCURRENCY = 4;

interface Entry {
  gen: number;
  result: AvailabilityResult;
}
interface ServerCache {
  /** Génération : change quand la bibliothèque a changé, les résultats plus anciens sont à revoir. */
  gen: number;
  stamp?: string;
  results: Map<string, Entry>;
  /** Clés en file ou en cours de vérification. */
  pending: Set<string>;
  index?: { gen: number; promise: Promise<Map<string, Metadata> | Error> };
}

const caches = new WeakMap<MediaServer, ServerCache>();
/** Change quand des résultats arrivent : les composants qui les lisent se redessinent. */
const version = signal(0);
let bump = 0;
function changed(): void {
  if (bump) return;
  bump = requestAnimationFrame(() => {
    bump = 0;
    version.value++;
  });
}

function cacheOf(srv: MediaServer): ServerCache {
  let c = caches.get(srv);
  if (!c) caches.set(srv, (c = { gen: 0, results: new Map(), pending: new Set() }));
  return c;
}

/** Clé d'un titre : son identifiant Plex, sinon son premier identifiant externe. */
function keyOf(item: Metadata): string {
  return plexGuid(item) ?? externalIds(item)[0] ?? `rk:${item.ratingKey}`;
}

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

function indexOf(srv: MediaServer, c: ServerCache): Promise<Map<string, Metadata> | Error> | undefined {
  if (!srv.libraryGuids) return undefined;
  if (c.index?.gen !== c.gen) {
    const gen = c.gen;
    const promise = srv.libraryGuids().then(buildGuidIndex, asError);
    c.index = { gen, promise };
    // Index illisible : on le relira à la prochaine vérification.
    void promise.then((r) => {
      if (r instanceof Error && c.index?.promise === promise) c.index = undefined;
    });
  }
  return c.index.promise;
}

async function check(srv: MediaServer, c: ServerCache, item: Metadata): Promise<AvailabilityResult> {
  const byGuid = plexGuid(item) ? await srv.findByGuid(item.guid!).then((m) => m ?? null, asError) : undefined;
  const index = needsIndex(item, byGuid) ? await indexOf(srv, c) : undefined;
  return resolveAvailability(item, { byGuid, index });
}

const queue: { srv: MediaServer; c: ServerCache; item: Metadata; key: string }[] = [];
let running = 0;
function pump(): void {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    // Serveur quitté entre-temps : inutile de le vérifier.
    if (job.srv !== server.value) {
      job.c.pending.delete(job.key);
      continue;
    }
    running++;
    const gen = job.c.gen;
    void check(job.srv, job.c, job.item)
      .then((result) => job.c.results.set(job.key, { gen, result }))
      .finally(() => {
        running--;
        job.c.pending.delete(job.key);
        changed();
        pump();
      });
  }
}

/** Disponibilité connue d'un titre sur le serveur courant ; `undefined` tant qu'elle n'est pas vérifiée. */
export function availabilityOf(item: Metadata): AvailabilityResult | undefined {
  const srv = server.value;
  return srv ? caches.get(srv)?.results.get(keyOf(item))?.result : undefined;
}

/**
 * Vérifie les titres donnés (ceux qui ne le sont pas encore, ou plus à jour) et redessine le
 * composant à mesure que les résultats arrivent. Rend la fonction qui lit le résultat d'un titre.
 */
export function useAvailability(items: Metadata[] | undefined): (item: Metadata) => AvailabilityResult | undefined {
  const srv = server.value;
  const v = version.value;
  useEffect(() => {
    if (!srv || !items?.length) return;
    const c = cacheOf(srv);
    let added = false;
    for (const item of items) {
      const key = keyOf(item);
      const known = c.results.get(key);
      if (c.pending.has(key) || (known && known.gen === c.gen)) continue;
      c.pending.add(key);
      queue.push({ srv, c, item, key });
      added = true;
    }
    if (added) pump();
  }, [items, srv, v]);
  return availabilityOf;
}

/**
 * Bibliothèques relues (au chargement de la page, quand l'app invalide les données du serveur,
 * au retour sur la fenêtre) : si leur empreinte a changé, tout est à revoir ; les titres
 * « à vérifier » sont retentés de toute façon. `null` : le serveur n'a pas répondu.
 */
export function noteLibraries(srv: MediaServer, libraries: Library[] | null): void {
  const c = cacheOf(srv);
  const stamp = libraries ? libraryStamp(libraries) : undefined;
  if (stamp !== undefined && c.stamp !== undefined && stamp !== c.stamp) c.gen++;
  if (stamp !== undefined) c.stamp = stamp;
  for (const e of c.results.values()) if (e.result.state === 'unknown') e.gen = -1;
  changed();
}

/** Pour une carte du catalogue : l'élément du serveur s'il est disponible, null s'il n'y est pas, rien sinon. */
export function localOf(r: AvailabilityResult | undefined): Metadata | null | undefined {
  return r?.state === 'available' ? r.local : r?.state === 'missing' ? null : undefined;
}
