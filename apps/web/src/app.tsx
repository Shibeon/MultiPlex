import { t } from './i18n';
import { LibraryPage, Home, SearchPage } from './pages/Browse';
import { Details } from './pages/Details';
import { Gate } from './pages/Gate';
import { Player } from './pages/Player';
import { SettingsPage } from './pages/Settings';
import { route } from './router';
import { libraries, server, status } from './store';
import { Icon } from './ui';

function NavLink({ href, icon, label }: { href: string; icon: string; label: string }) {
  const cur = `#${route.value.hash.split('?')[0]}`;
  const active = href === '#/' ? cur === '#/' : cur.startsWith(href);
  return (
    <a class={`nav-link${active ? ' active' : ''}`} href={href} aria-current={active ? 'page' : undefined}>
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
  if (kind === 'settings') return <SettingsPage />;
  return <Home />;
}

export function App() {
  if (status.value !== 'ready' || !server.value) return <Gate />;
  const [kind, id] = route.value.parts;
  if (kind === 'play' && id) return <Player key={id} id={id} />;
  return (
    <div class="shell">
      <nav class="sidebar" aria-label="Navigation">
        <a class="brand" href="#/">
          Multi<span>Plex</span>
        </a>
        <NavLink href="#/" icon="home" label={t('nav.home')} />
        <NavLink href="#/search" icon="search" label={t('nav.search')} />
        <div class="nav-sep" />
        {libraries.value.map((l) => (
          <NavLink key={l.key} href={`#/library/${l.key}`} icon={l.type} label={l.title} />
        ))}
        <div class="nav-sep grow" />
        <NavLink href="#/settings" icon="settings" label={t('nav.settings')} />
      </nav>
      <main class="content">
        <Page />
      </main>
    </div>
  );
}
