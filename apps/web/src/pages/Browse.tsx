import type { Hub, Metadata } from '@multiplex/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { formatDuration, t } from '../i18n';
import { go, route } from '../router';
import { cardWidth, load, save, settings } from '../settings';
import { libraries, server, useData } from '../store';
import { Card, ErrorBox, HubRow, Icon, Spinner, VirtualGrid, labels } from '../ui';

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
      <div key={item.ratingKey} class="hero-bg" style={{ backgroundImage: `url("${srv.image(item.art ?? item.thumb, 1920, 1080)}")` }} />
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
