import { rankPeople, type Hub, type LibraryOptions, type MediaServer, type Metadata } from '@multiplex/core';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatDuration, libraryTitle, t } from '../i18n';
import { go, route } from '../router';
import { cardWidth, load, save, settings } from '../settings';
import { discover, libraries, server, useData } from '../store';
import { DiscoverResults } from './Discover';
import { PeopleRow, PersonSpotlight } from './Person';
import { clearSearches, forgetSearch, rememberSearch, searchHistory } from '../searchHistory';
import { Card, ErrorBox, HubRow, Icon, Spinner, VirtualGrid, artSize, labels } from '../ui';

export interface KnownHub {
  id: string;
  title: string;
}

/** Applique l'ordre et le masquage choisis par l'utilisateur. */
function arrange(hubs: Hub[]): Hub[] {
  const { hubOrder, hiddenHubs } = settings.value;
  const pos = (h: Hub) => {
    const i = hubOrder.indexOf(h.hubIdentifier);
    return i < 0 ? hubOrder.length : i;
  };
  return hubs
    .filter((h) => !hiddenHubs.includes(h.hubIdentifier))
    .map((h, i) => ({ h, i }))
    .sort((a, b) => pos(a.h) - pos(b.h) || a.i - b.i)
    .map((x) => x.h);
}

/** Affiche vedette plein écran : fait défiler les premiers titres de la première rangée. */
function Hero({ hub }: { hub: Hub }) {
  const srv = server.value!;
  const items = (hub.Metadata ?? []).filter((m) => m.art || m.thumb).slice(0, 5);
  const [index, setIndex] = useState(0);
  const reduce = settings.value.reduceMotion;
  useEffect(() => {
    if (items.length < 2 || reduce) return;
    const timer = setInterval(() => !document.hidden && setIndex((i) => (i + 1) % items.length), 9000);
    return () => clearInterval(timer);
  }, [items.length, reduce]);
  const item = items[index % Math.max(1, items.length)];
  if (!item) return null;
  const { title, sub } = labels(item);
  const playable = item.type === 'movie' || item.type === 'episode';
  const facts = [sub, formatDuration(item.duration), item.contentRating].filter(Boolean).join(' · ');
  return (
    <section class="hero" aria-label={hub.title}>
      <div key={item.ratingKey} class="hero-bg" style={{ backgroundImage: `url("${srv.image(item.art ?? item.thumb, ...artSize())}")` }} />
      {/* Illustration du thème, mise en scène par le CSS de son effet. */}
      <div class="hero-art" aria-hidden="true">
        <i class="hero-rays" />
        <i class="hero-portrait" />
        <i class="hero-motto" />
      </div>
      <div class="hero-info">
        <span class="hero-kicker">{hub.title}</span>
        <h1>{title}</h1>
        {facts && <p class="hero-facts">{facts}</p>}
        {item.summary && <p class="hero-summary">{item.summary}</p>}
        <div class="actions">
          <a class="btn primary big" href={playable ? `#/play/${item.ratingKey}` : `#/item/${item.ratingKey}`}>
            <Icon name="play" /> {item.viewOffset ? t('item.resume') : t('item.play')}
          </a>
          <a class="btn big glass" href={`#/item/${item.ratingKey}`}>
            {t('hero.more')}
          </a>
        </div>
        {items.length > 1 && (
          <div class="hero-dots">
            {items.map((m, i) => (
              <button key={m.ratingKey} class={i === index ? 'on' : ''} aria-label={labels(m).title} aria-current={i === index} onClick={() => setIndex(i)} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function Home() {
  const srv = server.value!;
  const { data, error, loading, reload } = useData(`${srv.id}:hubs`, () => srv.hubs());

  useEffect(() => {
    // Mémorise les rangées rencontrées pour pouvoir les réordonner dans les réglages.
    if (!data) return;
    const known = load<KnownHub[]>('mp.hubs') ?? [];
    let changed = false;
    for (const h of data) {
      if (!known.some((k) => k.id === h.hubIdentifier)) {
        known.push({ id: h.hubIdentifier, title: h.title });
        changed = true;
      }
    }
    if (changed) save('mp.hubs', known);
  }, [data]);

  if (!data) return error ? <ErrorBox error={error} retry={reload} /> : <Spinner />;
  const hubs = arrange(data);
  const hero = settings.value.layout !== 'side' ? hubs[0] : undefined;
  return (
    <div class={hero ? 'page home' : 'page'}>
      {hero && <Hero hub={hero} />}
      {hubs.length === 0 && !loading && <p class="muted">{t('common.empty')}</p>}
      {hubs.map((h) => (
        <HubRow key={h.hubIdentifier} hub={h} />
      ))}
    </div>
  );
}

const TYPE_ID: Record<string, number> = { movie: 1, show: 2, artist: 8 };
/**
 * Tris proposés, dans cet ordre, s'ils figurent parmi ceux que le serveur accepte pour cette
 * bibliothèque (sans réponse du serveur : les cinq premiers, toujours disponibles).
 */
const SORTS: [string, string][] = [
  ['titleSort', 'lib.sort.title'],
  ['addedAt', 'lib.sort.added'],
  ['year', 'lib.sort.year'],
  ['rating', 'lib.sort.rating'],
  ['lastViewedAt', 'lib.sort.viewed'],
  ['originallyAvailableAt', 'lib.sort.release'],
  ['audienceRating', 'lib.sort.audience'],
  ['duration', 'lib.sort.duration'],
];
const PAGE = 120;

type Watch = 'all' | 'unwatched' | 'progress' | 'watched';
interface LibPrefs {
  sort: string;
  dir: 'asc' | 'desc';
  watch: Watch;
  genre: string;
  decade: string;
  /** Résolution du serveur (`4k`, `1080`…) ou `hdr`. */
  quality: string;
  /** Autres filtres annoncés par le serveur (« Plus de filtres ») : paramètre → valeur. */
  extra: Record<string, string>;
  /** « Plus de filtres » ouvert au dernier passage sur la page. */
  more?: boolean;
}
const DEFAULT_PREFS: LibPrefs = { sort: 'titleSort', dir: 'asc', watch: 'all', genre: '', decade: '', quality: '', extra: {} };

/** Filtres déjà présentés à part (visionnage, genre, décennie, qualité). */
const MAIN_FILTERS = new Set(['unwatched', 'unwatchedLeaves', 'inProgress', 'genre', 'decade', 'resolution', 'hdr']);
/** Personnes : des milliers de valeurs, illisible dans une liste (leur page reste accessible depuis une fiche). */
const PEOPLE_FILTERS = new Set(['actor', 'director', 'writer', 'producer']);
/** Emplacement (dossier du serveur) : sans intérêt pour choisir quoi regarder. */
const HIDDEN_FILTERS = new Set(['location', 'folder']);
/** Intitulés français des filtres courants ; les autres gardent celui du serveur. */
const FILTER_LABEL: Record<string, string> = {
  year: 'lib.f.year',
  contentRating: 'lib.f.contentRating',
  collection: 'lib.f.collection',
  studio: 'lib.f.studio',
  network: 'lib.f.network',
  country: 'lib.f.country',
  label: 'lib.f.label',
  audioLanguage: 'lib.f.audioLanguage',
  subtitleLanguage: 'lib.f.subtitleLanguage',
  editionTitle: 'lib.f.edition',
  duplicate: 'lib.f.duplicate',
  unmatched: 'lib.f.unmatched',
};

interface LibState {
  items: (Metadata | undefined)[];
  total: number;
  pages: Set<number>;
}
type Choice = { key: string; title: string };
interface LibOptions {
  options: LibraryOptions | null;
  genres: Choice[];
  decades: Choice[];
  resolutions: Choice[];
  /** Séries : résolutions des épisodes (filtre `episode.resolution`). */
  episodeRes: Choice[];
}
// Conservés hors du composant : un retour arrière retrouve la grille telle quelle.
const libStates = new Map<string, LibState>();
const libPrefs = new Map<string, LibPrefs>();
const libOptions = new Map<string, Promise<LibOptions>>();

/** Filtres et tris que le serveur accepte, avec les valeurs des listes (genres, décennies, résolutions). */
function loadOptions(srv: MediaServer, section: string, type: number | undefined): Promise<LibOptions> {
  const none: LibOptions = { options: null, genres: [], decades: [], resolutions: [], episodeRes: [] };
  if (!type || !srv.libraryOptions) return Promise.resolve(none);
  return srv
    .libraryOptions(section, type)
    .then(async (options) => {
      const values = (name: string) => {
        const f = options.filters.find((x) => x.filter === name);
        return f?.key && srv.filterValues ? srv.filterValues(f.key).catch(() => []) : Promise.resolve([]);
      };
      // Une série n'a pas de résolution, ses épisodes si : on filtre les séries sur celle de leurs épisodes.
      const episodeRes = async () => {
        if (type !== 2) return [];
        const ep = (await srv.libraryOptions!(section, 4).catch(() => null))?.filters.find((x) => x.filter === 'resolution');
        return ep?.key && srv.filterValues ? srv.filterValues(ep.key).catch(() => []) : [];
      };
      const [genres, decades, resolutions, epRes] = await Promise.all([values('genre'), values('decade'), values('resolution'), episodeRes()]);
      return { options, genres, decades, resolutions, episodeRes: epRes };
    })
    .catch(() => none);
}

const decadeLabel = (title: string) => {
  const y = /^(\d{4})s?$/.exec(title.trim())?.[1];
  return y ? t('lib.decadeOf').replace('{y}', y) : title;
};

export function LibraryPage({ id }: { id: string }) {
  const srv = server.value!;
  const lib = libraries.value.find((l) => l.key === id);
  const type = lib ? TYPE_ID[lib.type] : undefined;
  const prefKey = `${srv.id}:${id}`;
  const [prefs, setPrefsState] = useState<LibPrefs>(() => libPrefs.get(prefKey) ?? DEFAULT_PREFS);
  const [opts, setOpts] = useState<LibOptions | null>(null);
  // « Plus de filtres » : ouvert si l'un de ses filtres est actif, sinon comme on l'a laissé.
  const [more, setMoreState] = useState(() => !!prefs.more || Object.values(prefs.extra).some(Boolean));
  const setMore = (open: boolean) => {
    setMoreState(open);
    const p = libPrefs.get(prefKey) ?? prefs;
    libPrefs.set(prefKey, { ...p, more: open });
  };
  const [values, setValues] = useState<Record<string, Choice[]>>({});
  const [, render] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const setPrefs = (p: Partial<LibPrefs>) => {
    const next = { ...prefs, more, ...p };
    libPrefs.set(prefKey, next);
    setPrefsState(next);
  };

  useEffect(() => {
    let promise = libOptions.get(prefKey);
    if (!promise) libOptions.set(prefKey, (promise = loadOptions(srv, id, type)));
    let live = true;
    void promise.then((o) => live && setOpts(o));
    return () => {
      live = false;
    };
  }, [prefKey]);

  const filters = opts?.options?.filters;
  const has = (name: string) => !!filters?.some((f) => f.filter === name);
  // Non vus : `unwatchedLeaves` pour les séries (épisodes non vus), `unwatched` pour les films.
  const unwatchedKey = has('unwatchedLeaves') ? 'unwatchedLeaves' : has('unwatched') ? 'unwatched' : lib?.type === 'show' ? 'unwatchedLeaves' : 'unwatched';
  const serverSorts = opts?.options?.sorts;
  const sorts = serverSorts?.length ? SORTS.filter(([k]) => serverSorts.some((x) => x.key === k)) : SORTS.slice(0, 5);
  const sortDef = serverSorts?.find((x) => x.key === prefs.sort);

  const filter: Record<string, string | number> = {};
  if (prefs.watch === 'unwatched') filter[unwatchedKey] = 1;
  if (prefs.watch === 'watched') filter[unwatchedKey] = 0;
  if (prefs.watch === 'progress') filter.inProgress = 1;
  if (prefs.genre) filter.genre = prefs.genre;
  if (prefs.decade) filter.decade = prefs.decade;
  const showEpisodes = lib?.type === 'show' && !has('resolution');
  if (prefs.quality === 'hdr') filter.hdr = 1;
  else if (prefs.quality) filter[showEpisodes ? 'episode.resolution' : 'resolution'] = prefs.quality;
  for (const [k, v] of Object.entries(prefs.extra)) if (v) filter[k] = v;
  const sort = prefs.dir === 'desc' ? (sortDef?.descKey ?? `${prefs.sort}:desc`) : prefs.sort;
  const extraCount = Object.values(prefs.extra).filter(Boolean).length;
  const filtered = prefs.watch !== 'all' || !!prefs.genre || !!prefs.decade || !!prefs.quality || extraCount > 0;

  // « Plus de filtres » : tout ce que le serveur annonce d'autre, valeurs chargées à l'ouverture.
  const extraFilters = (filters ?? []).filter((f) => !MAIN_FILTERS.has(f.filter) && !PEOPLE_FILTERS.has(f.filter) && !HIDDEN_FILTERS.has(f.filter));
  useEffect(() => {
    if (!more || !srv.filterValues) return;
    let live = true;
    for (const f of extraFilters) {
      if (f.filterType === 'boolean' || !f.key || values[f.filter]) continue;
      void srv
        .filterValues(f.key)
        .catch(() => [])
        .then((list) => live && setValues((v) => ({ ...v, [f.filter]: list })));
    }
    return () => {
      live = false;
    };
  }, [more, opts]);

  const key = `${prefKey}:${sort}:${JSON.stringify(filter)}`;
  let state = libStates.get(key);
  if (!state) libStates.set(key, (state = { items: [], total: -1, pages: new Set() }));
  const current = useRef(key);
  current.current = key;

  const loadPage = (page: number) => {
    const st = state!;
    if (st.pages.has(page)) return;
    st.pages.add(page);
    srv
      .items(id, { type, sort, offset: page * PAGE, limit: PAGE, filter: filtered ? filter : undefined })
      .then((res) => {
        st.total = res.total;
        res.items.forEach((m, i) => (st.items[res.offset + i] = m));
        if (current.current === key) render((n) => n + 1);
      })
      .catch((e: Error) => {
        st.pages.delete(page);
        if (current.current === key) setError(e);
      });
  };

  useEffect(() => {
    setError(null);
    loadPage(0);
  }, [key]);

  const changeSort = (k: string) => {
    const d = serverSorts?.find((x) => x.key === k)?.defaultDirection;
    setPrefs({ sort: k, dir: d === 'asc' || d === 'desc' ? d : k === 'titleSort' ? 'asc' : 'desc' });
  };
  const watchOptions: [Watch, string][] = [
    ['all', 'lib.watch.all'],
    ['unwatched', 'lib.watch.unwatched'],
    ...(!filters || has('inProgress') ? ([['progress', 'lib.watch.progress']] as [Watch, string][]) : []),
    ['watched', 'lib.watch.watched'],
  ];
  const qualities = showEpisodes ? (opts?.episodeRes ?? []) : [...(opts?.resolutions ?? []), ...(has('hdr') ? [{ key: 'hdr', title: 'HDR' }] : [])];
  const setExtra = (k: string, v: string) => {
    const extra = { ...prefs.extra };
    if (v) extra[k] = v;
    else delete extra[k];
    setPrefs({ extra });
  };

  const s = settings.value;
  return (
    <div class="page">
      <header class="page-head">
        <h1>{lib ? libraryTitle(lib) : ''}</h1>
        {state.total >= 0 && (
          <span class="muted count">
            {state.total} {t('lib.count')}
          </span>
        )}
      </header>
      <div class="lib-tools">
        <div class="lib-filters">
          <select class={prefs.watch !== 'all' ? 'on' : ''} aria-label={t('lib.watch')} value={prefs.watch} onChange={(e) => setPrefs({ watch: e.currentTarget.value as Watch })}>
            {watchOptions.map(([v, label]) => (
              <option key={v} value={v}>
                {t(label)}
              </option>
            ))}
          </select>
          {opts && opts.genres.length > 0 && (
            <select class={prefs.genre ? 'on' : ''} aria-label={t('lib.genre')} value={prefs.genre} onChange={(e) => setPrefs({ genre: e.currentTarget.value })}>
              <option value="">{t('lib.genre.all')}</option>
              {opts.genres.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.title}
                </option>
              ))}
            </select>
          )}
          {opts && opts.decades.length > 0 && (
            <select class={prefs.decade ? 'on' : ''} aria-label={t('lib.decade')} value={prefs.decade} onChange={(e) => setPrefs({ decade: e.currentTarget.value })}>
              <option value="">{t('lib.decade.all')}</option>
              {opts.decades.map((d) => (
                <option key={d.key} value={d.key}>
                  {decadeLabel(d.title)}
                </option>
              ))}
            </select>
          )}
          {qualities.length > 0 && (
            <select class={prefs.quality ? 'on' : ''} aria-label={t('lib.quality')} value={prefs.quality} onChange={(e) => setPrefs({ quality: e.currentTarget.value })}>
              <option value="">{showEpisodes ? t('lib.quality.episodes') : t('lib.quality.all')}</option>
              {qualities.map((q) => (
                <option key={q.key} value={q.key}>
                  {q.title}
                </option>
              ))}
            </select>
          )}
          {extraFilters.length > 0 && (
            <button class={`btn lib-more-btn${more ? ' on' : ''}`} aria-expanded={more} onClick={() => setMore(!more)}>
              <Icon name="plus" size={16} /> {t('lib.more')}
              {extraCount > 0 && <b class="lib-badge">{extraCount}</b>}
            </button>
          )}
          {filtered && (
            <button class="btn lib-reset" onClick={() => setPrefs({ watch: 'all', genre: '', decade: '', quality: '', extra: {} })}>
              <Icon name="close" size={16} /> {t('lib.reset')}
            </button>
          )}
        </div>
        <div class="lib-sort">
          <select aria-label={t('lib.sort')} value={prefs.sort} onChange={(e) => changeSort(e.currentTarget.value)}>
            {sorts.map(([v, label]) => (
              <option key={v} value={v}>
                {t(label)}
              </option>
            ))}
          </select>
          <button
            class="btn icon-btn lib-dir"
            aria-label={prefs.dir === 'asc' ? t('lib.asc') : t('lib.desc')}
            title={prefs.dir === 'asc' ? t('lib.asc') : t('lib.desc')}
            onClick={() => setPrefs({ dir: prefs.dir === 'asc' ? 'desc' : 'asc' })}
          >
            <Icon name={prefs.dir === 'asc' ? 'up' : 'down'} size={18} />
          </button>
        </div>
      </div>
      {more && extraFilters.length > 0 && (
        <div class="lib-more">
          {extraFilters.map((f) => {
            const label = FILTER_LABEL[f.filter] ? t(FILTER_LABEL[f.filter]) : f.title;
            const v = prefs.extra[f.filter] ?? '';
            if (f.filterType === 'boolean')
              return (
                <button key={f.filter} class={`btn toggle-pill${v ? ' on' : ''}`} aria-pressed={!!v} onClick={() => setExtra(f.filter, v ? '' : '1')}>
                  {v && <Icon name="check" size={16} />}
                  {label}
                </button>
              );
            const list = values[f.filter];
            if (list && !list.length) return null;
            return (
              <select key={f.filter} class={v ? 'on' : ''} aria-label={label} value={v} disabled={!list} onChange={(e) => setExtra(f.filter, e.currentTarget.value)}>
                <option value="">{label}</option>
                {list?.map((c) => (
                  <option key={c.key} value={c.key}>
                    {label} : {c.title}
                  </option>
                ))}
              </select>
            );
          })}
        </div>
      )}
      {error && <ErrorBox error={error} retry={() => (setError(null), loadPage(0))} />}
      {state.total < 0 && !error && <Spinner />}
      {state.total === 0 && <p class="muted">{filtered ? t('lib.noMatch') : t('common.empty')}</p>}
      {state.total > 0 && (
        <VirtualGrid
          total={state.total}
          minWidth={cardWidth()}
          extra={s.showTitles ? 50 : 0}
          onRange={(a, b) => {
            for (let p = Math.floor(a / PAGE); p <= Math.floor((b - 1) / PAGE); p++) loadPage(p);
          }}
          render={(i) => {
            const m = state!.items[i];
            return m ? <Card item={m} /> : <div class="card skeleton" />;
          }}
        />
      )}
    </div>
  );
}

export function SearchPage() {
  const srv = server.value!;
  const initial = route.value.query.get('q') ?? '';
  const [text, setText] = useState(initial);
  const [query, setQuery] = useState(initial);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!initial) input.current?.focus();
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      const q = text.trim();
      setQuery(q);
      // La requête vit dans l'URL : le retour arrière retrouve les résultats.
      go(q ? `/search?q=${encodeURIComponent(q)}` : '/search', true);
    }, 250);
    return () => clearTimeout(id);
  }, [text]);

  const { data, error, loading } = useData(query ? `${srv.id}:search:${query}` : null, () => srv.search(query));
  // Personnes du catalogue Plex : en plus de celles du serveur ; une erreur ici ne cache rien d'autre.
  const d = discover.value;
  const known = useData(d && query.length >= 2 ? `disc:people:${query}` : null, () => d!.searchPeople(query));
  const people = useMemo(() => rankPeople(query, data?.people ?? [], known.data ?? []), [query, data, known.data]);
  const anyPeople = !!people.featured || people.others.length > 0;

  // Une recherche entre dans l'historique quand on la valide (Entrée), quand on ouvre un de ses
  // résultats, ou quand on quitte la page après qu'elle a trouvé quelque chose.
  const found = useRef('');
  found.current = query && (data?.hubs.length || anyPeople) ? query : '';
  useEffect(() => () => found.current && rememberSearch(found.current), []);

  const typed = text.trim().toLowerCase();
  const recent = searchHistory.value.filter((q) => q.toLowerCase() !== typed && q.toLowerCase().includes(typed)).slice(0, typed ? 5 : 12);
  const pickRecent = (q: string) => {
    setText(q);
    rememberSearch(q);
    input.current?.focus();
  };
  return (
    <div
      class="page"
      onClickCapture={(e) => {
        if (query && (e.target as HTMLElement).closest?.('a[href^="#/"]')) rememberSearch(query);
      }}
    >
      <input
        ref={input}
        class="search-input"
        type="search"
        placeholder={t('search.placeholder')}
        aria-label={t('nav.search')}
        value={text}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') rememberSearch(text);
          // Flèche bas : vers les recherches récentes, puis les résultats.
          if (e.key === 'ArrowDown') {
            const next = document.querySelector<HTMLElement>('.recent-search button, .page .person-spot, .page .card, .page .cast-card');
            if (next) {
              e.preventDefault();
              next.focus();
            }
          }
        }}
      />
      {recent.length > 0 && (
        <div class={`recent-searches${typed ? ' compact' : ''}`} aria-label={t('search.recent')}>
          {!typed && (
            <div class="recent-head">
              <h2>{t('search.recent')}</h2>
              <button class="link" onClick={() => clearSearches()}>
                {t('search.clear')}
              </button>
            </div>
          )}
          <ul>
            {recent.map((q) => (
              <li key={q} class="recent-search">
                <button onClick={() => pickRecent(q)}>
                  <Icon name="history" size={16} />
                  {q}
                </button>
                <button class="recent-forget" aria-label={t('search.forget').replace('{q}', q)} title={t('search.forget').replace('{q}', q)} onClick={() => forgetSearch(q)}>
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <ErrorBox error={error} />}
      {query && loading && !data && <Spinner />}
      {query && data?.hubs.length === 0 && !anyPeople && <p class="muted">{t('search.none')}</p>}
      {/* Une personne nommée en entier passe devant les films ; les autres suivent les résultats du serveur. */}
      {people.featured && <PersonSpotlight key={people.featured.key} person={people.featured} />}
      {data?.hubs.map((h) => <HubRow key={h.hubIdentifier} hub={h} />)}
      <PeopleRow people={people.others} />
      <DiscoverResults query={query} />
    </div>
  );
}
