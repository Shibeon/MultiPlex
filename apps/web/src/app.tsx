import { t } from './i18n';
import { ActivityPage } from './pages/Activity';
import { LibraryPage, Home, SearchPage } from './pages/Browse';
import { Details } from './pages/Details';
import { Gate } from './pages/Gate';
import { NativePlayer } from './pages/NativePlayer';
import { Player } from './pages/Player';
import { nativeAvailable } from './native';
import { SettingsPage } from './pages/Settings';
import { route } from './router';
import { settings } from './settings';
import { libraries, server, status } from './store';
import { Icon } from './ui';

function NavLink({ href, icon, label, iconOnly }: { href: string; icon: string; label: string; iconOnly?: boolean }) {
  const cur = `#${route.value.hash.split('?')[0]}`;
  const active = href === '#/' ? cur === '#/' : cur.startsWith(href);
  return (
    <a class={`nav-link${active ? ' active' : ''}${iconOnly ? ' icon-only' : ''}`} href={href} aria-current={active ? 'page' : undefined} title={label}>
      <Icon name={icon} />
      <span>{label}</span>
    </a>
  );
}

function Page() {
  const [kind, id] = route.value.parts;
  // `key` : chaque élément repart d'un état neuf.
  if (kind === 'library' && id) return <LibraryPage key={id} id={id} />;
  if (kind === 'item' && id) return <Details key={id} id={id} />;
  if (kind === 'search') return <SearchPage />;
  if (kind === 'activity') return <ActivityPage />;
  if (kind === 'settings') return <SettingsPage />;
  return <Home />;
}

export function App() {
  if (status.value !== 'ready' || !server.value) return <Gate />;
  const [kind, id] = route.value.parts;
  if (kind === 'play' && id) {
    // Dans l'application de bureau, mpv lit le fichier d'origine ; « ?web=1 » force le lecteur intégré.
    const useNative = nativeAvailable.value && settings.value.nativePlayer && !route.value.query.has('web');
    return useNative ? <NativePlayer key={id} id={id} /> : <Player key={id} id={id} />;
  }
  return (
    <div class={`shell ${settings.value.layout === 'side' ? 'side' : 'top'}`}>
      <nav class="sidebar" aria-label="Navigation">
        <a class="brand" href="#/">
          Multi<span>Plex</span>
        </a>
        <NavLink href="#/" icon="home" label={t('nav.home')} />
        <NavLink href="#/activity" icon="live" label={t('nav.live')} />
        <div class="nav-sep" />
        {libraries.value.map((l) => (
          <NavLink key={l.key} href={`#/library/${l.key}`} icon={l.type} label={l.title} />
        ))}
        <div class="nav-sep grow" />
        <NavLink href="#/search" icon="search" label={t('nav.search')} iconOnly />
        <NavLink href="#/settings" icon="settings" label={t('nav.settings')} iconOnly />
      </nav>
      <main class="content">
        <Page />
      </main>
    </div>
  );
}
