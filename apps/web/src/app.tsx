import { useLayoutEffect, useRef } from 'preact/hooks';
import { tvDevice } from './platform';
import { libraryTitle, t } from './i18n';
import { ActivityPage } from './pages/Activity';
import { LibraryPage, Home, SearchPage } from './pages/Browse';
import { Details } from './pages/Details';
import { DiscoverDetails, WatchlistPage } from './pages/Discover';
import { Gate } from './pages/Gate';
import { NativePlayer } from './pages/NativePlayer';
import { Player } from './pages/Player';
import { PersonPage, ResumePill, resumeAfter } from './pages/Person';
import { ProfilesPage } from './pages/Profiles';
import { ItemMenuHost } from './menu';
import { OfflinePage, OfflinePlayer } from './pages/Offline';
import { offlineApi } from './offline';
import { DownloadsPanel } from './downloads';
import { nativeAvailable } from './native';
import { SettingsPage } from './pages/Settings';
import { ThemesPage } from './pages/Themes';
import { UpdateBanner, WhatsNew } from './pages/Update';
import { back, route } from './router';
import { settings } from './settings';
import { auth, discover, home, libraries, server, status } from './store';
import { Icon } from './ui';
import { ReadyGate } from './ready';
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

/**
 * La barre flottante doit tenir à l'écran : sinon ses derniers boutons (réglages, profil)
 * sortent à droite, invisibles — c'était le cas en mode TV sur un téléviseur réglé à 200 %.
 * On lui réserve la place du bouton Retour (centrée, elle le recouvrait), puis, si elle
 * déborde encore, on resserre les boutons, et en dernier recours on n'affiche que les icônes.
 */
const FIT_LEVELS = ['nav-tight', 'nav-small', 'nav-icons'];
function fitNav(nav: HTMLElement): void {
  nav.classList.remove(...FIT_LEVELS);
  nav.style.cssText = '';
  if (!nav.closest('.shell.top') || innerWidth <= 760) return;
  const fits = () => nav.scrollWidth <= nav.clientWidth + 1;
  const backBtn = document.querySelector<HTMLElement>('.page-back');
  const reserve = backBtn ? backBtn.getBoundingClientRect().right + 12 : 16;
  // Centrée, en laissant de chaque côté la place du bouton Retour.
  nav.style.maxWidth = `${Math.max(0, innerWidth - 2 * reserve)}px`;
  if (fits()) return;
  // Sinon, calée juste à droite du bouton Retour, sur toute la largeur restante.
  if (backBtn) {
    nav.style.left = `${reserve}px`;
    nav.style.transform = 'none';
    nav.style.maxWidth = `${Math.max(0, innerWidth - reserve - 16)}px`;
  }
  for (const level of FIT_LEVELS) {
    if (fits()) return;
    nav.classList.add(level);
  }
}

function useFitNav() {
  const ref = useRef<HTMLElement>(null);
  // À chaque rendu (changement de page, de bibliothèques, de langue, de mode TV)…
  useLayoutEffect(() => {
    if (ref.current) fitNav(ref.current);
  });
  // … et quand la fenêtre change de taille ou que les polices finissent de charger.
  useLayoutEffect(() => {
    const run = () => ref.current && fitNav(ref.current);
    addEventListener('resize', run);
    void document.fonts?.ready.then(run);
    return () => removeEventListener('resize', run);
  }, []);
  return ref;
}

/** Pages où l'on arrive depuis une autre : elles ont un bouton Retour. Les pages de la navigation n'en ont pas. */
const DEEP = new Set(['item', 'discover', 'person', 'themes', 'profiles']);

function BackBar() {
  const [kind] = route.value.parts;
  // Téléviseur : la télécommande a sa touche Retour.
  if (!DEEP.has(kind) || tvDevice) return null;
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
  if (kind === 'offline') return <OfflinePage />;
  return <Home />;
}

/** Serveur injoignable : uniquement les titres téléchargés. */
function OfflineShell() {
  const navRef = useFitNav();
  return (
    <div class={`shell ${settings.value.layout === 'side' ? 'side' : 'top'}`}>
      <nav class="sidebar" aria-label="Navigation" ref={navRef}>
        <a class="brand" href="#/offline">
          Multi<span>Plex</span>
        </a>
        <NavLink href="#/offline" icon="download" label={t('nav.offline')} />
        <div class="nav-sep grow" />
        <i class="nav-divider" aria-hidden="true" />
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
    </>
  );
}

function Routes() {
  const [kind, id] = route.value.parts;
  const navRef = useFitNav();
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
      <nav class="sidebar" aria-label="Navigation" ref={navRef}>
        {/* Illustration du thème, quand il en a une : médaillon dans la navigation. */}
        <a class="nav-art" href="#/themes" title={settings.value.themeImageCredit || settings.value.themeLabel} aria-label={settings.value.themeLabel} />
        <a class="brand" href="#/">
          Multi<span>Plex</span>
        </a>
        {/* Recherche en tête ; les pages principales avec leur nom ; Amis et Hors ligne en icônes ;
            un filet, puis les réglages et le profil. */}
        <NavLink href="#/search" icon="search" label={t('nav.search')} iconOnly />
        <NavLink href="#/" icon="home" label={t('nav.home')} />
        {/* Les bibliothèques (Films, Séries…), puis Ma liste. */}
        {libraries.value.map((l) => (
          <NavLink key={l.key} href={`#/library/${l.key}`} icon={l.type} label={libraryTitle(l)} />
        ))}
        {discover.value && <NavLink href="#/watchlist" icon="bookmark" label={t('nav.watchlist')} />}
        <div class="nav-sep" />
        <NavLink href="#/activity" icon="friends" label={t('nav.live')} iconOnly />
        {offlineApi && <NavLink href="#/offline" icon="download" label={t('nav.offline')} iconOnly />}
        <div class="nav-sep grow" />
        <i class="nav-divider" aria-hidden="true" />
        <NavLink href="#/settings" icon="settings" label={t('nav.settings')} iconOnly />
        {home.value.length > 1 && <ProfileLink />}
      </nav>
      <div class="theme-art" aria-hidden="true" />
      <main class="content">
        <BackBar />
        <ReadyGate key={route.value.parts.join('/')}>
          <Page />
        </ReadyGate>
      </main>
      <ResumePill />
      <UpdateBanner />
      <WhatsNew />
      <ItemMenuHost />
    </div>
  );
}
