import { seasonCatalogId, techBadges, upcomingEpisodes, type Metadata } from '@multiplex/core';
import { resolvePlayable } from '../queue';
import { useState } from 'preact/hooks';
import { formatDuration, t } from '../i18n';
import { go } from '../router';
import { settings } from '../settings';
import { discover, invalidate, server, useData } from '../store';
import { Card, ErrorBox, HubRow, Icon, Ratings, Spinner, StarRating, TechBadges, artSize, isWatched } from '../ui';
import { ServerWatchlistButton } from './Discover';
import { OfflineButton } from './Offline';
import { CastButton } from '../castui';
import { TogetherButton } from '../togetherui';
import { CastRow, PeopleLinks } from './Person';

function EpisodeRow({ ep }: { ep: Metadata }) {
  const srv = server.value!;
  const progress = ep.viewOffset && ep.duration ? ep.viewOffset / ep.duration : 0;
  return (
    <a class="episode" href={`#/item/${ep.ratingKey}`}>
      <div class="episode-thumb">
        {ep.thumb && <img loading="lazy" decoding="async" src={srv.image(ep.thumb, 320, 180)} alt="" />}
        {progress > 0 && (
          <span class="progress">
            <i style={{ width: `${progress * 100}%` }} />
          </span>
        )}
      </div>
      <div class="episode-text">
        <strong>
          {ep.index}. {ep.title} {isWatched(ep) && <Icon name="check" size={16} />}
        </strong>
        <span class="muted">{formatDuration(ep.duration)}</span>
        <p>{ep.summary}</p>
      </div>
    </a>
  );
}

/** Date du jour au format AAAA-MM-JJ, en heure locale (comme les dates de diffusion). */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Épisodes annoncés de la saison, absents du serveur : affichés à la suite, avec leur date. */
function UpcomingEpisodes({ season, have }: { season: Metadata; have: Metadata[] }) {
  const srv = server.value!;
  const cat = discover.value;
  const sid = seasonCatalogId(season.guid);
  const lang = settings.value.lang;
  const { data } = useData(cat && sid ? `upcoming:${sid}:${lang}` : null, () => cat!.seasonEpisodes(sid!, lang));
  const list = data ? upcomingEpisodes(data, have, today()) : [];
  return (
    <>
      {list.map((ep) => {
        const date = ep.originallyAvailableAt
          ? new Date(`${ep.originallyAvailableAt}T12:00:00`).toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' })
          : '';
        const when = date ? t('ep.airs').replace('{date}', date) : t('ep.airsUnknown');
        const title = !ep.title || /^(TBA|TBD|Episode \d+)$/i.test(ep.title) ? t('ep.tba') : ep.title;
        return (
          <div key={ep.ratingKey} class="episode upcoming" aria-label={`${ep.index}. ${title} — ${when}`}>
            <div class="episode-thumb">
              {ep.thumb ? <img loading="lazy" decoding="async" src={srv.image(ep.thumb, 320, 180)} alt="" /> : <span class="upcoming-date">{when}</span>}
            </div>
            <div class="episode-text">
              <strong>
                {ep.index}. {title}
              </strong>
              <span class="muted">{when}</span>
              {ep.summary && <p>{ep.summary}</p>}
            </div>
          </div>
        );
      })}
    </>
  );
}

export function Details({ id }: { id: string }) {
  const srv = server.value!;
  const { data: item, error, reload } = useData(`${srv.id}:item:${id}`, () => srv.metadata(id));
  const hasKids = !!item && ['show', 'season', 'artist', 'album'].includes(item.type);
  const kids = useData(hasKids ? `${srv.id}:children:${id}` : null, () => srv.children(id));
  const [busy, setBusy] = useState(false);
  /** Note que l'on vient de donner : undefined = celle du serveur, null = retirée. */
  const [myRating, setMyRating] = useState<number | null | undefined>(undefined);

  if (!item) return error ? <ErrorBox error={error} retry={reload} /> : <Spinner />;

  const play = async (fromStart: boolean) => {
    setBusy(true);
    try {
      const target = await resolvePlayable(srv, item);
      if (target) go(`/play/${target.ratingKey}${fromStart ? '?t=0' : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleWatched = async () => {
    setBusy(true);
    try {
      await srv.scrobble(item.ratingKey, !isWatched(item));
      invalidate(`${srv.id}:`);
      reload();
      kids.reload();
    } finally {
      setBusy(false);
    }
  };

  const playable = ['movie', 'episode', 'show', 'season'].includes(item.type);
  // Comme sur la maquette : la série en titre, l'épisode (ou la saison) en dessous.
  const parentKey = item.type === 'episode' ? item.grandparentRatingKey : item.type === 'season' ? item.parentRatingKey : undefined;
  const heading = item.type === 'episode' ? (item.grandparentTitle ?? item.title) : item.type === 'season' ? (item.parentTitle ?? item.title) : item.title;
  const poster = item.type === 'episode' ? item.grandparentThumb : (item.thumb ?? item.parentThumb);
  const art = settings.value.backdrops ? (item.art ?? item.grandparentArt ?? item.parentArt) : undefined;
  const facts = [item.year, formatDuration(item.duration), item.contentRating].filter(Boolean);
  const leftMin = item.viewOffset && item.duration ? Math.round((item.duration - item.viewOffset) / 60000) : 0;
  const hasTech = !!techBadges(item.Media?.[0]).length;

  return (
    <div class={`details dx${art ? ' has-art' : ''}`}>
      {art && <div class="backdrop dx-art" style={{ backgroundImage: `url("${srv.image(art, ...artSize())}")` }} />}
      <div class="details-main dx-hero">
        {poster && <img class="details-poster" src={srv.image(poster, 600, 900)} alt="" />}
        <div class="details-info">
          <h1 class="dx-title">{parentKey ? <a href={`#/item/${parentKey}`}>{heading}</a> : heading}</h1>
          {item.type === 'episode' && (
            <p class="dx-sub">
              <b>
                S{item.parentIndex} · E{item.index}
              </b>
              <span>{item.title}</span>
            </p>
          )}
          {item.type === 'season' && (
            <p class="dx-sub">
              <span>{item.title}</span>
            </p>
          )}
          {item.tagline && <p class="tagline">{item.tagline}</p>}
          {!!facts.length && (
            <p class="facts">
              {facts.map((f, i) => (
                <span key={i}>{f}</span>
              ))}
            </p>
          )}
          {(item.type === 'movie' || item.type === 'show' || item.type === 'episode') && (
            <p class="ratings-row">
              <Ratings item={item} />
              <StarRating
                value={myRating === undefined ? item.userRating : (myRating ?? undefined)}
                onRate={(r) => {
                  // La fiche reflète le choix tout de suite ; en cas d'échec, elle revient à la note du serveur.
                  setMyRating(r);
                  srv.rate(item.ratingKey, r).then(
                    () => invalidate(`${srv.id}:`),
                    () => setMyRating(undefined),
                  );
                }}
              />
            </p>
          )}
          <div class="actions">
            {playable && (
              <button class="btn primary big" disabled={busy} onClick={() => void play(false)}>
                <Icon name="play" /> {item.viewOffset ? t('item.resume') : t('item.play')}
                {leftMin > 0 && (
                  <small>
                    {' '}
                    · {leftMin} min {t('item.left')}
                  </small>
                )}
              </button>
            )}
            {!!item.viewOffset && (
              <button class="btn" disabled={busy} onClick={() => void play(true)}>
                <Icon name="restart" size={18} /> {t('item.restart')}
              </button>
            )}
            <ServerWatchlistButton item={item} />
            {playable && (
              <button class="btn" disabled={busy} onClick={() => void toggleWatched()}>
                <Icon name={isWatched(item) ? 'eye' : 'check'} size={18} /> {isWatched(item) ? t('item.unwatched') : t('item.watched')}
              </button>
            )}
            <OfflineButton item={item} />
            {playable && <CastButton item={item} start={(item.viewOffset ?? 0) / 1000} />}
            {(item.type === 'movie' || item.type === 'episode') && <TogetherButton item={item} />}
          </div>
        </div>
      </div>
      {(item.summary || hasTech || item.Genre?.length || item.Director?.length || item.Writer?.length) && (
        <div class="dx-info">
          <div class="dx-synopsis">
            {item.summary && (
              <>
                <h3>{t('item.synopsis')}</h3>
                <p class="summary">{item.summary}</p>
              </>
            )}
            <dl class="credits">
              {!!item.Genre?.length && <div>{item.Genre.map((g) => g.tag).join(' · ')}</div>}
              {!!item.Director?.length && (
                <div>
                  <dt>{t('item.director')}</dt> <dd>
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
          {hasTech && (
            <div class="dx-formats">
              <h3>{t('item.formats')}</h3>
              <TechBadges item={item} />
            </div>
          )}
        </div>
      )}
      <CastRow people={item.Role} title={t('item.cast')} />
      {hasKids && (
        <section class="children">
          <h2>{item.type === 'season' ? t('item.episodes') : item.type === 'show' ? t('item.seasons') : ''}</h2>
          {kids.error && <ErrorBox error={kids.error} retry={kids.reload} />}
          {!kids.data && !kids.error && <Spinner />}
          {item.type === 'season' ? (
            <div class="episodes">
              {kids.data?.map((ep) => <EpisodeRow key={ep.ratingKey} ep={ep} />)}
              {kids.data && <UpcomingEpisodes season={item} have={kids.data} />}
            </div>
          ) : (
            <div class="row wrap">{kids.data?.map((m) => <Card key={m.ratingKey} item={{ ...m, parentTitle: m.title, title: '' }} />)}</div>
          )}
        </section>
      )}
      {(item.type === 'movie' || item.type === 'show') && <RelatedRows item={item} />}
    </div>
  );
}

/** Comme dans Plex : titres associés, puis « Plus avec » les têtes d'affiche. */
function RelatedRows({ item }: { item: Metadata }) {
  const srv = server.value!;
  const lang = settings.value.lang;
  const { data } = useData(`${srv.id}:related:${item.ratingKey}:${lang}`, () => srv.related(item.ratingKey, lang));
  if (!data?.length) return null;
  return (
    <section class="related">
      {data.map((h) => (
        <HubRow key={h.hubIdentifier} hub={h} />
      ))}
    </section>
  );
}
