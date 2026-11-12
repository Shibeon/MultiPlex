import type { Metadata } from '@multiplex/core';
import { resolvePlayable } from '../queue';
import { useState } from 'preact/hooks';
import { formatDuration, t } from '../i18n';
import { go } from '../router';
import { settings } from '../settings';
import { invalidate, server, useData } from '../store';
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
  const title = item.title;
  const poster = item.type === 'episode' ? item.grandparentThumb : (item.thumb ?? item.parentThumb);
  const facts = [
    item.type === 'episode' && `S${item.parentIndex} · E${item.index}`,
    item.year,
    formatDuration(item.duration),
    item.contentRating,
  ].filter(Boolean);
  const leftMin = item.viewOffset && item.duration ? Math.round((item.duration - item.viewOffset) / 60000) : 0;

  return (
    <div class="details">
      {settings.value.backdrops && item.art && <div class="backdrop" style={{ backgroundImage: `url("${srv.image(item.art, ...artSize())}")` }} />}
      <div class="details-main">
        {poster && <img class="details-poster" src={srv.image(poster, 600, 900)} alt="" />}
        <div class="details-info">
          {item.type === 'season' && item.parentRatingKey && (
            <a class="crumb" href={`#/item/${item.parentRatingKey}`}>
              {item.parentTitle}
            </a>
          )}
          {item.type === 'episode' && item.grandparentRatingKey && (
            <a class="crumb" href={`#/item/${item.grandparentRatingKey}`}>
              {item.grandparentTitle}
            </a>
          )}
          <h1>{title}</h1>
          {item.tagline && <p class="tagline">{item.tagline}</p>}
          <p class="facts">
            {facts.map((f, i) => (
              <span key={i}>{f}</span>
            ))}
          </p>
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
          <TechBadges item={item} />
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
                {t('item.restart')}
              </button>
            )}
            {playable && (
              <button class="btn" disabled={busy} onClick={() => void toggleWatched()}>
                <Icon name={isWatched(item) ? 'eye' : 'check'} size={18} /> {isWatched(item) ? t('item.unwatched') : t('item.watched')}
              </button>
            )}
            <ServerWatchlistButton item={item} />
            <OfflineButton item={item} />
            {playable && <CastButton item={item} start={(item.viewOffset ?? 0) / 1000} />}
            {(item.type === 'movie' || item.type === 'episode') && <TogetherButton item={item} />}
          </div>
          {item.summary && <p class="summary">{item.summary}</p>}
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
      </div>
      <CastRow people={item.Role} title={t('item.cast')} />
      {(item.type === 'movie' || item.type === 'show') && <RelatedRows item={item} />}
      {hasKids && (
        <section class="children">
          <h2>{item.type === 'season' ? t('item.episodes') : item.type === 'show' ? t('item.seasons') : ''}</h2>
          {kids.error && <ErrorBox error={kids.error} retry={kids.reload} />}
          {!kids.data && !kids.error && <Spinner />}
          {item.type === 'season' ? (
            <div class="episodes">{kids.data?.map((ep) => <EpisodeRow key={ep.ratingKey} ep={ep} />)}</div>
          ) : (
            <div class="row wrap">{kids.data?.map((m) => <Card key={m.ratingKey} item={{ ...m, parentTitle: m.title, title: '' }} />)}</div>
          )}
        </section>
      )}
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
