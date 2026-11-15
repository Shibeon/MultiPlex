import { arrangeByAvailability, discoverId, discoverImage, type Availability, type Metadata } from '@multiplex/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { localOf, noteLibraries, useAvailability } from '../availability';
import { formatDuration, t } from '../i18n';
import { settings } from '../settings';
import { discover, invalidate, managedProfile, server, useData } from '../store';
import { Carousel } from '../carousel';
import { ErrorBox, Icon, Spinner } from '../ui';
import { CastRow, PeopleLinks } from './Person';

const PAGE = 60;

/** Pastille de disponibilité d'un titre de la liste de suivi (icône, intitulé pour les lecteurs d'écran). */
const AVAIL_ICON: Record<Availability, string> = { available: 'play', missing: 'minus', unknown: 'help' };

/**
 * Carte d'un titre du catalogue Plex. `local` : l'élément correspondant s'il est
 * déjà disponible (la carte y mène alors directement), null s'il ne l'est pas
 * encore, absent tant qu'on ne sait pas. `state` (liste de suivi) : la disponibilité
 * en trois états, montrée par une pastille discrète.
 */
export function DiscoverCard({ item, local, note, state }: { item: Metadata; local?: Metadata | null; note?: string; state?: Availability }) {
  // Dans une filmographie (`note` = le rôle), on signale ce qui est disponible plutôt que ce qui manque.
  const filmography = note !== undefined;
  const poster = discoverImage(item, 'poster');
  const label = state ? t(`avail.${state}`) : '';
  return (
    <a
      class={`card${local === null && !filmography ? ' pending' : ''}`}
      href={local ? `#/item/${local.ratingKey}` : `#/discover/${item.ratingKey}`}
      title={label ? `${item.title} · ${label}` : item.title}
      aria-label={label ? `${item.title}, ${label}` : undefined}
      data-avail={state}
    >
      <div class="poster">
        <span class="poster-fallback">{item.title}</span>
        {poster && <img loading="lazy" decoding="async" referrerpolicy="no-referrer" src={poster} alt="" />}
        {state ? (
          <span class={`badge avail ${state}`} aria-hidden="true">
            <Icon name={AVAIL_ICON[state]} size={14} />
          </span>
        ) : (
          local === null && !filmography && <span class="soon">{t('disc.notOnServer')}</span>
        )}
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

type WatchSort = 'list' | 'availability';

export function WatchlistPage() {
  const d = discover.value;
  const srv = server.value!;
  const [count, setCount] = useState(PAGE);
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [sort, setSort] = useState<WatchSort>('list');
  const { data, error, reload } = useData(d ? `disc:watchlist:${count}` : null, () => d!.watchlist(0, count));
  // Les bibliothèques sont relues quand l'app invalide les données du serveur (lecture, analyse…)
  // et au retour sur la fenêtre : si elles ont changé, les disponibilités sont revues.
  const libs = useData(d ? `${srv.id}:libraries` : null, () => srv.libraries());
  useEffect(() => {
    if (libs.data) noteLibraries(srv, libs.data);
    else if (libs.error) noteLibraries(srv, null);
  }, [libs.data, libs.error, srv]);
  const reloadLibs = useRef(libs.reload);
  reloadLibs.current = libs.reload;
  useEffect(() => {
    const again = () => document.visibilityState === 'visible' && reloadLibs.current();
    document.addEventListener('visibilitychange', again);
    addEventListener('focus', again);
    return () => {
      document.removeEventListener('visibilitychange', again);
      removeEventListener('focus', again);
    };
  }, []);
  const availability = useAvailability(data?.items);
  const stateOf = (m: Metadata) => availability(m)?.state;
  const shown = data ? arrangeByAvailability(data.items, stateOf, { onlyAvailable, byAvailability: sort === 'availability' }) : [];
  if (!d) return <p class="page muted">{t('disc.needAccount')}</p>;
  const waiting = data?.items.filter((m) => stateOf(m) === 'missing').length ?? 0;
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
      {!!data?.items.length && (
        <div class="lib-tools watch-tools">
          <div class="lib-filters">
            <button class={`btn toggle-pill${onlyAvailable ? ' on' : ''}`} aria-pressed={onlyAvailable} onClick={() => setOnlyAvailable(!onlyAvailable)}>
              {onlyAvailable && <Icon name="check" size={16} />}
              {t('avail.only')}
            </button>
          </div>
          <div class="lib-sort">
            <select class={sort !== 'list' ? 'on' : ''} aria-label={t('lib.sort')} value={sort} onChange={(e) => setSort(e.currentTarget.value as WatchSort)}>
              <option value="list">{t('avail.sort.list')}</option>
              <option value="availability">{t('avail.sort.availability')}</option>
            </select>
          </div>
        </div>
      )}
      {error && <ErrorBox error={error} retry={reload} />}
      {!data && !error && <Spinner />}
      {data?.total === 0 && <p class="muted">{t('disc.empty')}</p>}
      {onlyAvailable && !!data?.items.length && !shown.length && <p class="muted">{t('avail.none')}</p>}
      <div class="card-grid">
        {shown.map((m) => {
          const r = availability(m);
          return <DiscoverCard key={m.ratingKey} item={m} local={localOf(r)} state={r?.state} />;
        })}
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
          <span class="crumb">{local.data ? t('disc.onServer') : local.error ? t('avail.unknown') : t('disc.notOnServer')}</span>
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
          {!local.data && !local.loading && !local.error && <p class="muted">{t('disc.hint')}</p>}
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
