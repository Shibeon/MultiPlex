import { hdrKind, streamsOf, type MediaServer, type Metadata } from '@multiplex/core';
import { useState } from 'preact/hooks';
import { formatDuration, t } from '../i18n';
import { go } from '../router';
import { settings } from '../settings';
import { invalidate, server, useData } from '../store';
import { Card, ErrorBox, Icon, Spinner, isWatched } from '../ui';
import { ServerWatchlistButton } from './Discover';

/** Pour une série ou une saison : le premier épisode pas encore vu. */
async function resolvePlayable(srv: MediaServer, item: Metadata): Promise<Metadata | undefined> {
  if (item.type === 'movie' || item.type === 'episode') return item;
  const kids = await srv.children(item.ratingKey);
  if (item.type === 'season') return kids.find((e) => !e.viewCount) ?? kids[0];
  if (item.type === 'show') {
    const season = kids.find((s) => (s.index ?? 0) > 0 && !isWatched(s)) ?? kids.find((s) => (s.index ?? 0) > 0) ?? kids[0];
    return season && resolvePlayable(srv, season);
  }
  return undefined;
}

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
  const title = item.type === 'episode' ? item.title : item.type === 'season' ? `${item.parentTitle} — ${item.title}` : item.title;
  const poster = item.type === 'episode' ? item.grandparentThumb : (item.thumb ?? item.parentThumb);
  const media = item.Media?.[0];
  const facts = [
    item.type === 'episode' && `S${item.parentIndex} · E${item.index}`,
    item.year,
    formatDuration(item.duration),
    item.contentRating,
    item.rating && `★ ${item.rating.toFixed(1)}`,
    media?.videoResolution && (/^\d+$/.test(media.videoResolution) ? `${media.videoResolution}p` : media.videoResolution.toUpperCase()),
    media?.videoCodec?.toUpperCase(),
    hdrKind(streamsOf(media?.Part?.[0], 1)[0]),
    [media?.audioCodec?.toUpperCase(), media?.audioChannels && (media.audioChannels > 2 ? `${media.audioChannels - 1}.1` : media.audioChannels === 2 ? 'stéréo' : 'mono')].filter(Boolean).join(' '),
  ].filter(Boolean);
  const leftMin = item.viewOffset && item.duration ? Math.round((item.duration - item.viewOffset) / 60000) : 0;

  return (
    <div class="details">
      {settings.value.backdrops && item.art && <div class="backdrop" style={{ backgroundImage: `url("${srv.image(item.art, 1280, 720)}")` }} />}
      <div class="details-main">
        {poster && <img class="details-poster" src={srv.image(poster, 400, 600)} alt="" />}
        <div class="details-info">
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
          </div>
          {item.summary && <p class="summary">{item.summary}</p>}
          <dl class="credits">
            {!!item.Genre?.length && <div>{item.Genre.map((g) => g.tag).join(' · ')}</div>}
            {!!item.Director?.length && (
              <div>
                <dt>{t('item.director')}</dt> <dd>{item.Director.map((d) => d.tag).join(', ')}</dd>
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
