import { discoverId, discoverImage, type Metadata } from '@multiplex/core';
import { useState } from 'preact/hooks';
import { formatDuration, t } from '../i18n';
import { settings } from '../settings';
import { discover, invalidate, server, useData } from '../store';
import { ErrorBox, Icon, Spinner } from '../ui';

const PAGE = 60;

/** Carte d'un titre du catalogue Plex : mène à sa fiche « hors serveur ». */
export function DiscoverCard({ item }: { item: Metadata }) {
  const poster = discoverImage(item, 'poster');
  return (
    <a class="card" href={`#/discover/${item.ratingKey}`} title={item.title}>
      <div class="poster">
        <span class="poster-fallback">{item.title}</span>
        {poster && <img loading="lazy" decoding="async" referrerpolicy="no-referrer" src={poster} alt="" />}
      </div>
      <div class="card-text">
        <div class="card-title">{item.title}</div>
        <div class="card-sub">{[item.year, item.type === 'show' ? t('disc.show') : ''].filter(Boolean).join(' · ')}</div>
      </div>
    </a>
  );
}

/** Bouton « liste de suivi » pour un titre du catalogue, utilisable aussi depuis une fiche du serveur. */
export function WatchlistButton({ id, initial }: { id: string; initial?: boolean }) {
  const d = discover.value;
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
  if (!d) return <p class="page muted">{t('disc.needAccount')}</p>;
  return (
    <div class="page">
      <header class="page-head">
        <h1>{t('nav.watchlist')}</h1>
        {data && <span class="muted">{data.total}</span>}
      </header>
      <p class="muted">{t('disc.lead')}</p>
      {error && <ErrorBox error={error} retry={reload} />}
      {!data && !error && <Spinner />}
      {data?.total === 0 && <p class="muted">{t('disc.empty')}</p>}
      <div class="row wrap grid-gap">
        {data?.items.map((m) => (
          <DiscoverCard key={m.ratingKey} item={m} />
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
      <div class="row">
        {data?.map((m) => (
          <DiscoverCard key={m.ratingKey} item={m} />
        ))}
      </div>
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
                <dt>{t('item.director')}</dt> <dd>{item.Director.map((x) => x.tag).join(', ')}</dd>
              </div>
            )}
            {!!item.Role?.length && (
              <div>
                <dt>{t('item.cast')}</dt>{' '}
                <dd>
                  {item.Role.slice(0, 8)
                    .map((r) => r.tag)
                    .join(', ')}
                </dd>
              </div>
            )}
          </dl>
        </div>
      </div>
    </div>
  );
}

/** Pour une fiche du serveur : le bouton de liste de suivi, si l'élément a un identifiant Plex. */
export function ServerWatchlistButton({ item }: { item: Metadata }) {
  const id = discoverId(item.guid);
  return id && discover.value ? <WatchlistButton key={id} id={id} /> : null;
}
