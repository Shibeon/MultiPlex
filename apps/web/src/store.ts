import { signal } from '@preact/signals';
import {
  DemoCommunity,
  DemoDiscover,
  PlexCommunity,
  DemoServer,
  PlexDiscover,
  PlexServer,
  getJson,
  getServers,
  getUser,
  pickConnection,
  randomId,
  type ClientInfo,
  type Community,
  type Discover,
  type Library,
  type MediaServer,
  type PlexResource,
  type PlexUser,
} from '@multiplex/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import { load, save } from './settings';

function browserName(): string {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Edg\//.test(ua)) return 'Microsoft Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Chrome';
}

let clientId = load<string>('mp.clientId');
if (!clientId) {
  clientId = randomId(32);
  save('mp.clientId', clientId);
}

export const client: ClientInfo = {
  clientId,
  product: 'MultiPlex',
  version: '0.1.0',
  platform: browserName(),
  device: navigator.platform || 'Web',
  deviceName: 'MultiPlex',
};

interface Auth {
  token: string;
  user: PlexUser;
}
interface SavedServer {
  id: string;
  name: string;
  uri: string;
  token: string;
}

export type Status = 'boot' | 'login' | 'servers' | 'connecting' | 'ready';

export const status = signal<Status>('boot');
export const auth = signal<Auth | null>(load<Auth>('mp.auth'));
export const server = signal<MediaServer | null>(null);
export const libraries = signal<Library[]>([]);
export const resources = signal<PlexResource[]>([]);
export const bootError = signal('');
/** Catalogue en ligne de Plex et liste de suivi ; absent sans compte Plex (connexion manuelle). */
export const discover = signal<Discover | null>(null);
/** Activité des amis Plex ; absente sans compte Plex (connexion manuelle). */
export const community = signal<Community | null>(null);

const cache = new Map<string, unknown>();

async function use(srv: MediaServer): Promise<void> {
  cache.clear();
  discover.value = srv instanceof DemoServer ? new DemoDiscover() : auth.value ? new PlexDiscover(auth.value.token, client) : null;
  community.value = srv instanceof DemoServer ? new DemoCommunity() : auth.value ? new PlexCommunity(auth.value.token, client) : null;
  libraries.value = await srv.libraries();
  server.value = srv;
  status.value = 'ready';
}

export async function connectManual(uri: string, token: string): Promise<void> {
  uri = uri.trim().replace(/\/+$/, '');
  const id = await getJson<{ MediaContainer: { machineIdentifier: string } }>(`${uri}/identity`, { timeout: 6000 });
  const saved: SavedServer = { id: id.MediaContainer.machineIdentifier, name: new URL(uri).hostname, uri, token: token.trim() };
  await use(new PlexServer(saved.id, saved.name, saved.uri, saved.token, client));
  save('mp.server', saved);
}

export async function connect(res: PlexResource): Promise<void> {
  status.value = 'connecting';
  bootError.value = '';
  try {
    const conn = await pickConnection(res.connections, { secureOnly: location.protocol === 'https:' });
    if (!conn) throw new Error('unreachable');
    const saved: SavedServer = { id: res.clientIdentifier, name: res.name, uri: conn.uri, token: res.accessToken };
    await use(new PlexServer(saved.id, saved.name, saved.uri, saved.token, client));
    save('mp.server', saved);
  } catch {
    bootError.value = res.name;
    status.value = 'servers';
  }
}

export async function chooseServer(): Promise<void> {
  const a = auth.value;
  if (!a) {
    status.value = 'login';
    return;
  }
  status.value = 'connecting';
  try {
    resources.value = await getServers(client, a.token);
  } catch {
    resources.value = [];
  }
  if (resources.value.length === 1 && !bootError.value) await connect(resources.value[0]);
  else status.value = 'servers';
}

export async function signIn(token: string): Promise<void> {
  const user = await getUser(client, token);
  auth.value = { token, user };
  save('mp.auth', auth.value);
  await chooseServer();
}

export async function boot(): Promise<void> {
  if (load<boolean>('mp.demo')) return startDemo();
  const saved = load<SavedServer>('mp.server');
  if (saved) {
    // Démarrage rapide : on réutilise la dernière adresse connue sans repasser par plex.tv.
    try {
      await use(new PlexServer(saved.id, saved.name, saved.uri, saved.token, client));
      return;
    } catch {
      /* adresse périmée : on retombe sur la découverte */
    }
  }
  await chooseServer();
}

export async function startDemo(): Promise<void> {
  save('mp.demo', true);
  await use(new DemoServer());
}

export function switchServer(): void {
  save('mp.server', null);
  save('mp.demo', null);
  server.value = null;
  bootError.value = '';
  void chooseServer();
}

export function logout(): void {
  for (const k of ['mp.auth', 'mp.server', 'mp.demo']) save(k, null);
  cache.clear();
  auth.value = null;
  discover.value = null;
  community.value = null;
  server.value = null;
  libraries.value = [];
  status.value = 'login';
}

/** Oublie les données en cache dont la clé commence par `prefix`. */
export function invalidate(prefix = ''): void {
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}

/**
 * Chargement « stale-while-revalidate » : la donnée en cache s'affiche
 * immédiatement (retour arrière instantané) puis est rafraîchie en fond.
 */
export function useData<T>(key: string | null, fetcher: () => Promise<T>): { data?: T; error?: Error; loading: boolean; reload: () => void } {
  const [tick, setTick] = useState(0);
  const [, render] = useState(0);
  const st = useRef<{ key: string | null; data?: T; error?: Error; loading: boolean }>({ key: null, loading: false });
  if (st.current.key !== key) st.current = { key, data: key ? (cache.get(key) as T | undefined) : undefined, loading: !!key };
  useEffect(() => {
    if (!key) return;
    let alive = true;
    fetcher().then(
      (data) => {
        cache.set(key, data);
        if (alive) {
          st.current = { key, data, loading: false };
          render((n) => n + 1);
        }
      },
      (error: Error) => {
        if (alive) {
          st.current = { ...st.current, error, loading: false };
          render((n) => n + 1);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [key, tick]);
  return { ...st.current, reload: () => setTick((n) => n + 1) };
}
