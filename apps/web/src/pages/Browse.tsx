import type { Hub, Metadata } from '@multiplex/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../i18n';
import { go, route } from '../router';
import { load, save, settings } from '../settings';
import { libraries, server, useData } from '../store';
import { Card, ErrorBox, HubRow, Spinner, VirtualGrid } from '../ui';

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
  return (
    <div class="page">
      {hubs.length === 0 && !loading && <p class="muted">{t('common.empty')}</p>}
      {hubs.map((h) => (
        <HubRow key={h.hubIdentifier} hub={h} />
      ))}
    </div>
  );
}

const TYPE_ID: Record<string, number> = { movie: 1, show: 2, artist: 8 };
const SORTS = [
  ['titleSort', 'lib.sort.title'],
  ['addedAt:desc', 'lib.sort.added'],
  ['year:desc', 'lib.sort.year'],
  ['rating:desc', 'lib.sort.rating'],
  ['lastViewedAt:desc', 'lib.sort.viewed'],
];
const PAGE = 120;

interface LibState {
  items: (Metadata | undefined)[];
  total: number;
  pages: Set<number>;
}
// Conservés hors du composant : un retour arrière retrouve la grille telle quelle.
const libStates = new Map<string, LibState>();
const libPrefs = new Map<string, { sort: string; unwatched: boolean }>();

export function LibraryPage({ id }: { id: string }) {
  const srv = server.value!;
  const lib = libraries.value.find((l) => l.key === id);
  const prefKey = `${srv.id}:${id}`;
  const [prefs, setPrefsState] = useState(() => libPrefs.get(prefKey) ?? { sort: 'titleSort', unwatched: false });
  const [, render] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const setPrefs = (p: typeof prefs) => {
    libPrefs.set(prefKey, p);
    setPrefsState(p);
  };

  const key = `${prefKey}:${prefs.sort}:${prefs.unwatched}`;
  let state = libStates.get(key);
  if (!state) libStates.set(key, (state = { items: [], total: -1, pages: new Set() }));
  const current = useRef(key);
  current.current = key;

  const loadPage = (page: number) => {
    const st = state!;
    if (st.pages.has(page)) return;
    st.pages.add(page);
    const filter: Record<string, number> | undefined = prefs.unwatched ? (lib?.type === 'show' ? { unwatchedLeaves: 1 } : { unwatched: 1 }) : undefined;
    srv
      .items(id, { type: lib ? TYPE_ID[lib.type] : undefined, sort: prefs.sort, offset: page * PAGE, limit: PAGE, filter })
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

  const s = settings.value;
  return (
    <div class="page">
      <header class="page-head">
        <h1>{lib?.title ?? ''}</h1>
        {state.total >= 0 && (
          <span class="muted">
            {state.total} {t('lib.count')}
          </span>
        )}
        <span class="spacer" />
        <label class="check">
          <input type="checkbox" checked={prefs.unwatched} onChange={(e) => setPrefs({ ...prefs, unwatched: e.currentTarget.checked })} />
          {t('lib.unwatched')}
        </label>
        <select aria-label={t('lib.sort')} value={prefs.sort} onChange={(e) => setPrefs({ ...prefs, sort: e.currentTarget.value })}>
          {SORTS.map(([v, label]) => (
            <option key={v} value={v}>
              {t(label)}
            </option>
          ))}
        </select>
      </header>
      {error && <ErrorBox error={error} retry={() => (setError(null), loadPage(0))} />}
      {state.total < 0 && !error && <Spinner />}
      {state.total === 0 && <p class="muted">{t('common.empty')}</p>}
      {state.total > 0 && (
        <VirtualGrid
          total={state.total}
          minWidth={s.cardSize}
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
  return (
    <div class="page">
      <input ref={input} class="search-input" type="search" placeholder={t('search.placeholder')} aria-label={t('nav.search')} value={text} onInput={(e) => setText(e.currentTarget.value)} />
      {error && <ErrorBox error={error} />}
      {query && loading && !data && <Spinner />}
      {query && data?.length === 0 && <p class="muted">{t('search.none')}</p>}
      {data?.map((h) => <HubRow key={h.hubIdentifier} hub={h} />)}
    </div>
  );
}
