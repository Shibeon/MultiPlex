import { t } from '../i18n';
import { enqueue } from '../queue';
import { go } from '../router';
import { server, useData } from '../store';
import { Card, ErrorBox, Icon, Spinner } from '../ui';

/** Listes de lecture vidéo du compte, telles que Plex les garde (communes à toutes les applications Plex). */
export function PlaylistsPage() {
  const srv = server.value!;
  const { data, error, reload } = useData(`${srv.id}:playlists`, () => srv.playlists());
  return (
    <div class="page">
      <header class="page-head">
        <h1>{t('nav.playlists')}</h1>
        {data && <span class="muted">{data.length}</span>}
      </header>
      {error && <ErrorBox error={error} retry={reload} />}
      {!data && !error && <Spinner />}
      {data?.length === 0 && <p class="muted">{t('pl.empty')}</p>}
      <div class="playlist-grid">
        {data?.map((p) => (
          <a key={p.ratingKey} class="playlist-tile" href={`#/playlist/${p.ratingKey}?n=${encodeURIComponent(p.title)}`}>
            <span class="playlist-art">{p.composite ? <img loading="lazy" src={srv.image(p.composite, 480, 270)} alt="" /> : <Icon name="list" size={40} />}</span>
            <strong>{p.title}</strong>
            <small class="muted">
              {p.leafCount ?? 0} {t('pl.items')}
            </small>
          </a>
        ))}
      </div>
    </div>
  );
}

export function PlaylistPage({ id, title }: { id: string; title: string }) {
  const srv = server.value!;
  const { data, error, reload } = useData(`${srv.id}:playlist:${id}`, () => srv.playlistItems(id));
  const playAll = () => {
    if (!data?.length) return;
    // Le premier titre démarre, les autres attendent dans la file, dans l'ordre de la liste.
    enqueue(data.slice(1), true);
    go(`/play/${data[0].ratingKey}`);
  };
  return (
    <div class="page">
      <header class="page-head">
        <h1>{title || t('nav.playlists')}</h1>
        {data && <span class="muted">{data.length}</span>}
        {!!data?.length && (
          <button class="btn primary" onClick={playAll}>
            <Icon name="play" size={18} /> {t('pl.playAll')}
          </button>
        )}
      </header>
      {error && <ErrorBox error={error} retry={reload} />}
      {!data && !error && <Spinner />}
      {data?.length === 0 && <p class="muted">{t('pl.emptyList')}</p>}
      <div class="row wrap grid-gap">{data?.map((m) => <Card key={m.ratingKey} item={m} />)}</div>
    </div>
  );
}
