import { t } from './i18n';
import { ActivityPage } from './pages/Activity';
import { LibraryPage, Home, SearchPage } from './pages/Browse';
import { Details } from './pages/Details';
import { DiscoverDetails, WatchlistPage } from './pages/Discover';
import { Gate } from './pages/Gate';
import { NativePlayer } from './pages/NativePlayer';
import { Player } from './pages/Player';
import { PersonPage, ResumePill, resumeAfter } from './pages/Person';
import { ProfilesPage } from './pages/Profiles';
import { PlaylistPage, PlaylistsPage } from './pages/Playlists';
import { ItemMenuHost } from './menu';
import { OfflinePage, OfflinePlayer } from './pages/Offline';
import { offlineApi } from './offline';
import { DownloadsPanel } from './downloads';
import { nativeAvailable } from './native';
import { SettingsPage } from './pages/Settings';
import { ThemesPage } from './pages/Themes';
import { UpdateBanner, WhatsNew } from './pages/Update';
import { back, route } from './router';
import { setCouch, settings } from './settings';
import { auth, discover, home, libraries, server, status } from './store';
import { CouchBanner, Icon } from './ui';
import { CastBar, CastPicker } from './castui';
import { TogetherBar, TogetherDialog } from './togetherui';

function NavLink({ href, icon, label, iconOnly }: { href: string; icon: string; label: string; iconOnly?: boolean }) {
  const cur = `#${route.value.hash.split('?')[0]}`;
  const active = href === '#/' ? cur === '#/' : cur.startsWith(href) || (href === '#/settings' && cur.startsWith('#/themes'));
  return (
    <a class={`nav-link${active ? ' active' : ''}${iconOnly ? ' icon-only' : ''}`} href={href} aria-current={active ? 'page' : undefined} title={label}>
      <Icon name={icon} />
      <span>{label}</span>
    </a>
  );
}

/** Le profil en cours du foyer Plex Home ; un clic ouvre « Qui regarde ? ». */
function ProfileLink() {
  const me = home.value.find((u) => u.uuid === auth.value?.user.uuid);
  const name = me?.title ?? auth.value?.user.title ?? '';
  return (
    <a class="nav-profile" href="#/profiles" title={`${name} — ${t('home.switch')}`} aria-label={t('home.switch')}>
      {me?.thumb ? <img referrerpolicy="no-referrer" src={me.thumb} alt="" /> : <b>{name.slice(0, 1).toUpperCase()}</b>}
    </a>
  );
}

/** Pages où l'on arrive depuis une autre : elles ont un bouton Retour. Les pages de la navigation n'en ont pas. */
const DEEP = new Set(['item', 'discover', 'person', 'playlist', 'themes', 'profiles']);

function BackBar() {
  const [kind, id] = route.value.parts;
  if (!DEEP.has(kind) || (kind === 'playlist' && !id)) return null;
  return (
    <div class="page-back-bar">
      <button class="btn page-back" onClick={back} title={`${t('common.back')} (Retour arrière)`}>
        <Icon name="back" size={20} /> {t('common.back')}
      </button>
    </div>
  );
}

function Page() {
  const [kind, id] = route.value.parts;
  // `key` : chaque élément repart d'un état neuf.
  if (kind === 'library' && id) return <LibraryPage key={id} id={id} />;
  if (kind === 'item' && id) return <Details key={id} id={id} />;
  if (kind === 'search') return <SearchPage />;
  if (kind === 'activity') return <ActivityPage />;
  if (kind === 'watchlist') return <WatchlistPage />;
  if (kind === 'discover' && id) return <DiscoverDetails key={id} id={id} />;
  if (kind === 'settings') return <SettingsPage />;
  if (kind === 'themes') return <ThemesPage />;
  if (kind === 'profiles') return <ProfilesPage />;
  if (kind === 'person' && id) return <PersonPage key={id} id={id} />;
  if (kind === 'playlists' || (kind === 'playlist' && !id)) return <PlaylistsPage />;
  if (kind === 'offline') return <OfflinePage />;
  if (kind === 'playlist' && id) return <PlaylistPage key={id} id={id} title={route.value.query.get('n') ?? ''} />;
  return <Home />;
}

/** Serveur injoignable : uniquement les titres téléchargés. */
function OfflineShell() {
  return (
    <div class={`shell ${settings.value.layout === 'side' ? 'side' : 'top'}`}>
      <nav class="sidebar" aria-label="Navigation">
        <a class="brand" href="#/offline">
          Multi<span>Plex</span>
        </a>
        <NavLink href="#/offline" icon="download" label={t('nav.offline')} />
        <div class="nav-sep grow" />
        <NavLink href="#/settings" icon="settings" label={t('nav.settings')} iconOnly />
      </nav>
      <main class="content">{route.value.parts[0] === 'settings' ? <SettingsPage /> : <OfflinePage />}</main>
      <DownloadsPanel />
    </div>
  );
}

export function App() {
  return (
    <>
      <Routes />
      <CastPicker />
      <CastBar />
      <TogetherDialog />
      <TogetherBar />
      <CouchBanner />
    </>
  );
}

function Routes() {
  const [kind, id] = route.value.parts;
  // Un titre téléchargé se lit avec ou sans serveur.
  if (kind === 'offline-play' && id) return <OfflinePlayer key={id} id={id} />;
  if (status.value === 'offline') return <OfflineShell />;
  if (status.value !== 'ready' || !server.value) return <Gate />;
  if (kind === 'play' && id) {
    if (resumeAfter.peek()) resumeAfter.value = null;
    // Dans l'application de bureau, mpv lit le fichier d'origine ; « ?web=1 » force le lecteur intégré.
    const useNative = nativeAvailable.value && settings.value.nativePlayer && !route.value.query.has('web');
    return useNative ? <NativePlayer key={id} id={id} /> : <Player key={id} id={id} />;
  }
  return (
    <div class={`shell ${settings.value.layout === 'side' ? 'side' : 'top'}`}>
      <nav class="sidebar" aria-label="Navigation">
        {/* Illustration du thème, quand il en a une : médaillon dans la navigation. */}
        <a class="nav-art" href="#/themes" title={settings.value.themeImageCredit || settings.value.themeLabel} aria-label={settings.value.themeLabel} />
        <a class="brand" href="#/">
          Multi<span>Plex</span>
        </a>
        <NavLink href="#/" icon="home" label={t('nav.home')} />
        {discover.value && <NavLink href="#/watchlist" icon="bookmark" label={t('nav.watchlist')} />}
        <NavLink href="#/activity" icon="live" label={t('nav.live')} />
        <NavLink href="#/playlist" icon="list" label={t('nav.playlists')} />
        {offlineApi && <NavLink href="#/offline" icon="download" label={t('nav.offline')} />}
        <div class="nav-sep" />
        {libraries.value.map((l) => (
          <NavLink key={l.key} href={`#/library/${l.key}`} icon={l.type} label={l.title} />
        ))}
        <div class="nav-sep grow" />
        <NavLink href="#/search" icon="search" label={t('nav.search')} iconOnly />
        <button class={`nav-link${settings.value.couch ? ' couch-on' : ' icon-only'}`} aria-pressed={settings.value.couch} title={`${t('couch.title')} (F10)`} onClick={() => setCouch(!settings.value.couch)}>
          <Icon name="tv" />
          <span>{t('couch.title')}</span>
        </button>
        <NavLink href="#/settings" icon="settings" label={t('nav.settings')} iconOnly />
        {home.value.length > 1 && <ProfileLink />}
      </nav>
      <div class="theme-art" aria-hidden="true" />
      <main class="content">
        <BackBar />
        <Page />
      </main>
      <ResumePill />
      <UpdateBanner />
      <WhatsNew />
      <ItemMenuHost />
    </div>
  );
}
