import { discoverId, discoverImage, type Metadata } from '@multiplex/core';
import { useEffect, useState } from 'preact/hooks';
import { formatDuration, t } from '../i18n';
import { settings } from '../settings';
import { discover, invalidate, managedProfile, server, useData } from '../store';
import { Carousel } from '../carousel';
import { ErrorBox, Icon, Spinner } from '../ui';
import { CastRow, PeopleLinks } from './Person';

const PAGE = 60;

/** Disponibilité déjà vérifiée, par bibliothèque et identifiant Plex : null = pas encore disponible. */
const availability = new Map<string, Metadata | null>();

/**
 * Pour une liste de titres du catalogue, cherche lesquels sont déjà disponibles.
 * Les vérifications partent par petits lots et sont mémorisées pour la session.
 */
export function useAvailability(items: Metadata[] | undefined): (item: Metadata) => Metadata | null | undefined {
  const srv = server.value!;
  const [, refresh] = useState(0);
  useEffect(() => {
    let alive = true;
    const todo = (items ?? []).filter((m) => m.guid && !availability.has(`${srv.id}:${m.guid}`));
    const worker = async () => {
      for (let m = todo.shift(); m && alive; m = todo.shift()) {
        const key = `${srv.id}:${m.guid}`;
        try {
          availability.set(key, (await srv.findByGuid(m.guid!)) ?? null);
        } catch {
          /* vérification manquée : le titre reste « inconnu » et sera revérifié */
        }
        if (alive) refresh((n) => n + 1);
      }
    };
    for (let i = 0; i < 6; i++) void worker();
    return () => {
      alive = false;
    };
  }, [items, srv.id]);
  return (item) => (item.guid ? availability.get(`${srv.id}:${item.guid}`) : undefined);
}

/**
 * Carte d'un titre du catalogue Plex. `local` : l'élément correspondant s'il est
 * déjà disponible (la carte y mène alors directement), null s'il ne l'est pas
 * encore, absent tant qu'on ne sait pas.
 */
export function DiscoverCard({ item, local, note }: { item: Metadata; local?: Metadata | null; note?: string }) {
  // Dans une filmographie (`note` = le rôle), on signale ce qui est disponible plutôt que ce qui manque.
  const filmography = note !== undefined;
  const poster = discoverImage(item, 'poster');
  return (
    <a class={`card${local === null && !filmography ? ' pending' : ''}`} href={local ? `#/item/${local.ratingKey}` : `#/discover/${item.ratingKey}`} title={item.title}>
      <div class="poster">
        <span class="poster-fallback">{item.title}</span>
        {poster && <img loading="lazy" decoding="async" referrerpolicy="no-referrer" src={poster} alt="" />}
        {local === null && !filmography && <span class="soon">{t('disc.notOnServer')}</span>}
        {local && filmography && <span class="soon here">{t('disc.onServer')}</span>}
      </div>
      <div class="card-text">
        <div class="card-title">{item.title}</div>
        <div class="card-sub">{[item.year, item.type === 'show' ? t('disc.show') : '', note].filter(Boolean).join(' · ')}</div>
      </div>
    </a>
  );
}

/** Bouton « liste de suivi » pour un titre du catalogue, utilisable aussi depuis une fiche du serveur. */
export function WatchlistButton({ id, initial }: { id: string; initial?: boolean }) {
  // Pas de liste de suivi pour un profil géré du foyer.
  const d = managedProfile.value ? null : discover.value;
  const known = useData(d && initial === undefined ? `disc:state:${id}` : null, () => d!.isWatchlisted(id));
  const [local, setLocal] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!d) return null;
  const on = local ?? initial ?? known.data ?? false;

  const toggle = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await d.setWatchlisted(id, !on);
      setLocal(!on);
      invalidate('disc:');
    } catch {
      setFailed(true);
    }
    setBusy(false);
  };

  return (
    <button class={`btn${on ? ' on' : ''}`} disabled={busy} aria-pressed={on} onClick={() => void toggle()}>
      <Icon name={on ? 'check' : 'bookmark'} size={18} /> {failed ? t('common.error') : on ? t('disc.listed') : t('disc.add')}
    </button>
  );
}

export function WatchlistPage() {
  const d = discover.value;
  const [count, setCount] = useState(PAGE);
  const { data, error, reload } = useData(d ? `disc:watchlist:${count}` : null, () => d!.watchlist(0, count));
  const localOf = useAvailability(data?.items);
  if (!d) return <p class="page muted">{t('disc.needAccount')}</p>;
  const waiting = data?.items.filter((m) => localOf(m) === null).length ?? 0;
  return (
    <div class="page">
      <header class="page-head">
        <h1>{t('nav.watchlist')}</h1>
        {data && <span class="muted count">{data.total}</span>}
        {waiting > 0 && (
          <span class="muted">
            · {waiting} {t('disc.waiting')}
          </span>
        )}
      </header>
      <p class="muted">{t('disc.lead')}</p>
      {error && <ErrorBox error={error} retry={reload} />}
      {!data && !error && <Spinner />}
      {data?.total === 0 && <p class="muted">{t('disc.empty')}</p>}
      <div class="card-grid">
        {data?.items.map((m) => (
          <DiscoverCard key={m.ratingKey} item={m} local={localOf(m)} />
        ))}
      </div>
      {data && data.items.length < data.total && (
        <p>
          <button class="btn" onClick={() => setCount(count + PAGE)}>
            {t('disc.more')}
          </button>
        </p>
      )}
    </div>
  );
}

/** Résultats du catalogue Plex pour une recherche, affichés sous ceux du serveur. */
export function DiscoverResults({ query }: { query: string }) {
  const d = discover.value;
  const { data, error } = useData(d && query.length >= 2 ? `disc:search:${query}` : null, () => d!.search(query));
  if (!d || !query) return null;
  return (
    <section class="hub">
      <h2>{t('disc.searchTitle')}</h2>
      <p class="muted">{t('disc.searchLead')}</p>
      {error && <ErrorBox error={error} />}
      {!data && !error && <Spinner />}
      {data?.length === 0 && <p class="muted">{t('search.none')}</p>}
      <Carousel>
        {data?.map((m) => (
          <DiscoverCard key={m.ratingKey} item={m} />
        ))}
      </Carousel>
    </section>
  );
}

export function DiscoverDetails({ id }: { id: string }) {
  const d = discover.value;
  const srv = server.value!;
  const { data: item, error, reload } = useData(d ? `disc:item:${id}` : null, () => d!.details(id));
  // Le titre est-il déjà sur le serveur ? La correspondance se fait par identifiant Plex.
  const local = useData(item?.guid ? `${srv.id}:guid:${item.guid}` : null, () => srv.findByGuid(item!.guid!));
  if (!d) return <p class="page muted">{t('disc.needAccount')}</p>;
  if (!item) return error ? <ErrorBox error={error} retry={reload} /> : <Spinner />;

  const poster = discoverImage(item, 'poster');
  const art = discoverImage(item, 'background');
  const facts = [item.type === 'show' ? t('disc.show') : '', item.year, formatDuration(item.duration), item.contentRating, item.rating && `★ ${item.rating.toFixed(1)}`].filter(Boolean);
  return (
    <div class="details">
      {settings.value.backdrops && art && <div class="backdrop" style={{ backgroundImage: `url("${art}")` }} />}
      <div class="details-main">
        {poster && <img class="details-poster" referrerpolicy="no-referrer" src={poster} alt="" />}
        <div class="details-info">
          <span class="crumb">{local.data ? t('disc.onServer') : t('disc.notOnServer')}</span>
          <h1>{item.title}</h1>
          {item.tagline && <p class="tagline">{item.tagline}</p>}
          <p class="facts">
            {facts.map((f, i) => (
              <span key={i}>{f}</span>
            ))}
          </p>
          <div class="actions">
            {local.data && (
              <a class="btn primary big" href={`#/item/${local.data.ratingKey}`}>
                <Icon name="play" /> {t('disc.open')}
              </a>
            )}
            <WatchlistButton key={id} id={id} initial={item.watchlisted} />
          </div>
          {!local.data && !local.loading && <p class="muted">{t('disc.hint')}</p>}
          {item.summary && <p class="summary">{item.summary}</p>}
          <dl class="credits">
            {!!item.Genre?.length && <div>{item.Genre.map((g) => g.tag).join(' · ')}</div>}
            {!!item.Director?.length && (
              <div>
                <dt>{t('item.director')}</dt>{' '}
                <dd>
                  <PeopleLinks people={item.Director} />
                </dd>
              </div>
            )}
            {!!item.Writer?.length && (
              <div>
                <dt>{t('item.writer')}</dt>{' '}
                <dd>
                  <PeopleLinks people={item.Writer} />
                </dd>
              </div>
            )}
            {!!item.Producer?.length && (
              <div>
                <dt>{t('item.producer')}</dt>{' '}
                <dd>
                  <PeopleLinks people={item.Producer.slice(0, 8)} />
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>
      <CastRow people={item.Role} title={t('item.cast')} />
    </div>
  );
}

/** Pour une fiche du serveur : le bouton de liste de suivi, si l'élément a un identifiant Plex. */
export function ServerWatchlistButton({ item }: { item: Metadata }) {
  const id = discoverId(item.guid);
  return id && discover.value ? <WatchlistButton key={id} id={id} /> : null;
}
