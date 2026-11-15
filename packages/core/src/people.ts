/**
 * Personnes trouvées par une recherche (acteurs, réalisateurs…), sur le serveur et dans le
 * catalogue Plex, et la règle qui décide laquelle mettre en avant.
 *
 * Formes de réponse lues (vérifiées sur des sources publiques, pas sur un serveur réel) :
 * - serveur, `/hubs/search` : les rangées de type `actor` ou `director` portent des éléments
 *   `Directory` (python-plexapi, `LibraryMediaTag` : `tag`, `tagKey`, `thumb`, `count`…) ;
 *   `tagKey` est la partie hexadécimale du guid Plex de la personne (documentation officielle
 *   de PMS, `/library/people/{personId}`).
 * - catalogue, `/library/search?searchTypes=people` : chaque résultat porte la personne sous
 *   `Directory` (et non `Metadata`) : `title`, `thumb`, `key` = `/library/people/<id>`,
 *   `metadataId`, `type` = `person`, `CreditType` (métier, nombre de titres), et un `score`.
 * Tout ce qui ne ressemble pas à ça est ignoré, sans erreur.
 */

/** Une personne trouvée par la recherche. */
export interface PersonHit {
  /** Identifiant accepté par la fiche d'une personne (`tagKey` du serveur, id du catalogue). */
  key: string;
  name: string;
  thumb?: string;
  /** Métiers (`actor`, `director`…), avec leur intitulé et leur nombre de titres s'ils sont connus. */
  jobs: { type: string; title?: string; count?: number }[];
  /** Nombre de titres de la bibliothèque où elle figure (serveur). */
  libraryCount?: number;
  /** Pertinence donnée par le catalogue Plex (0 à 1). */
  score?: number;
}

/** Identifiant d'une personne que la fiche sait ouvrir (même règle que `#/person/<key>`). */
export const PERSON_KEY = /^[0-9a-z]{8,40}$/i;

/** Rangées de résultats du serveur qui contiennent des personnes. */
const PERSON_HUBS = new Set(['actor', 'director', 'writer', 'producer']);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(obj).filter((o): o is Obj => !!o);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && isFinite(n) ? n : undefined;
};

/** Ajoute un métier sans doublon ; les nombres d'un même métier (plusieurs bibliothèques) s'additionnent. */
function addJob(jobs: PersonHit['jobs'], job: PersonHit['jobs'][0]): void {
  const same = jobs.find((j) => j.type === job.type);
  if (!same) jobs.push({ ...job });
  else if (job.count !== undefined) same.count = (same.count ?? 0) + job.count;
}

/**
 * Personnes des rangées de `/hubs/search` d'un serveur. Une même personne peut revenir dans
 * plusieurs rangées (actrice et réalisatrice) ou plusieurs bibliothèques : on la fusionne.
 * Sans `tagKey`, la fiche ne saurait pas l'ouvrir : on l'ignore.
 */
export function peopleFromHubs(hubs: unknown): PersonHit[] {
  const out = new Map<string, PersonHit>();
  for (const hub of list(hubs)) {
    const type = str(hub.type);
    if (!type || !PERSON_HUBS.has(type)) continue;
    for (const d of [...list(hub.Directory), ...list(hub.Metadata)]) {
      const name = str(d.tag);
      const key = str(d.tagKey);
      if (!name || !key || !PERSON_KEY.test(key)) continue;
      const count = num(d.count);
      const p = out.get(key) ?? { key, name, thumb: str(d.thumb), jobs: [] };
      p.thumb ??= str(d.thumb);
      addJob(p.jobs, { type, count });
      if (count !== undefined) p.libraryCount = Math.max(p.libraryCount ?? 0, p.jobs.reduce((n, j) => Math.max(n, j.count ?? 0), 0));
      out.set(key, p);
    }
  }
  return [...out.values()];
}

/** Personnes d'une réponse `/library/search?searchTypes=people` du catalogue Plex (son `MediaContainer`). */
export function peopleFromDiscover(container: unknown): PersonHit[] {
  const out = new Map<string, PersonHit>();
  for (const group of list(obj(container)?.SearchResults)) {
    for (const r of list(group.SearchResult)) {
      const d = list(r.Directory)[0] ?? list(r.Metadata)[0];
      if (!d || (d.type !== undefined && d.type !== 'person')) continue;
      const name = str(d.title);
      const fromKey = /^\/library\/people\/([^/?#]+)$/.exec(str(d.key) ?? '')?.[1];
      const key = [str(d.metadataId), fromKey].find((k) => !!k && PERSON_KEY.test(k));
      if (!name || !key || out.has(key)) continue;
      const jobs: PersonHit['jobs'] = [];
      for (const c of list(d.CreditType)) {
        const type = str(c.type);
        if (type) addJob(jobs, { type, title: str(c.title), count: num(c.count) });
      }
      const thumb = str(d.thumb);
      out.set(key, { key, name, thumb: thumb && /^https:\/\//.test(thumb) ? thumb : undefined, jobs, score: num(r.score) });
    }
  }
  return [...out.values()];
}

/** Mots d'un nom ou d'une requête : minuscules, sans accents ni ponctuation. */
export function nameWords(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Force de la correspondance entre une requête et un nom :
 * - 3 : le nom complet, à la casse et aux accents près (« ines morel » pour « Inès Morel ») ;
 * - 2 : plusieurs mots, tous des mots entiers du nom, dans n'importe quel ordre (« bale christian ») ;
 * - 1 : un seul mot, qui est un mot entier du nom (« christian », « bale ») ;
 * - 0 : chaque mot commence un mot du nom (saisie en cours : « christian ba ») ;
 * - -1 : rien de tout ça (correction orthographique de Plex, autre champ…).
 */
export function matchStrength(query: string, name: string): number {
  const q = nameWords(query);
  const n = nameWords(name);
  if (!q.length || !n.length) return -1;
  if (q.join(' ') === n.join(' ')) return 3;
  // Chaque mot de la requête doit trouver un mot du nom différent.
  const fits = (whole: boolean) => {
    const left = [...n];
    return q.every((w) => {
      const i = left.findIndex((x) => (whole ? x === w : x.startsWith(w)));
      return i >= 0 && !!left.splice(i, 1);
    });
  };
  if (fits(true)) return q.length > 1 ? 2 : 1;
  return fits(false) ? 0 : -1;
}

/** À partir de cette force, la personne passe devant les films et séries. */
export const FEATURE_STRENGTH = 2;

export interface RankedPeople {
  /** La personne mise en avant en tête des résultats, si la requête la désigne clairement. */
  featured?: PersonHit;
  /** Les autres, dans l'ordre, à montrer en rangée après les résultats du serveur. */
  others: PersonHit[];
}

/**
 * Fusionne les personnes du serveur et du catalogue (même identifiant), garde celles dont le nom
 * correspond à la requête, et les range : force de la correspondance, puis présence dans la
 * bibliothèque, pertinence du catalogue, nombre de titres. La première n'est mise en avant que
 * si la requête la nomme vraiment (nom complet, ou plusieurs mots entiers de son nom) : un
 * prénom seul (« christian ») ne fait pas passer un inconnu devant les films.
 */
export function rankPeople(query: string, ...sources: PersonHit[][]): RankedPeople {
  const merged = new Map<string, PersonHit>();
  for (const p of sources.flat()) {
    const had = merged.get(p.key);
    if (!had) {
      merged.set(p.key, { ...p, jobs: p.jobs.map((j) => ({ ...j })) });
      continue;
    }
    had.thumb ??= p.thumb;
    had.libraryCount ??= p.libraryCount;
    had.score ??= p.score;
    // Le catalogue connaît toute la carrière : ses nombres l'emportent sur ceux de la bibliothèque.
    for (const j of p.jobs) {
      const same = had.jobs.find((x) => x.type === j.type);
      if (!same) had.jobs.push({ ...j });
      else if (j.title) Object.assign(same, j);
    }
  }
  const total = (p: PersonHit) => p.jobs.reduce((n, j) => Math.max(n, j.count ?? 0), 0);
  const ranked = [...merged.values()]
    .map((p) => ({ p, s: matchStrength(query, p.name) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || Number(!!b.p.libraryCount) - Number(!!a.p.libraryCount) || (b.p.score ?? 0) - (a.p.score ?? 0) || total(b.p) - total(a.p) || a.p.name.localeCompare(b.p.name));
  if (ranked[0] && ranked[0].s >= FEATURE_STRENGTH) return { featured: ranked[0].p, others: ranked.slice(1).map((x) => x.p) };
  return { others: ranked.map((x) => x.p) };
}
