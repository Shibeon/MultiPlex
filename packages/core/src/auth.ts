import { getJson } from './http';
import type { ClientInfo, PlexConnection, PlexPin, PlexResource, PlexUser } from './types';

const TV = 'https://plex.tv/api/v2';

export function identityHeaders(c: ClientInfo, token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'X-Plex-Client-Identifier': c.clientId,
    'X-Plex-Product': c.product,
    'X-Plex-Version': c.version,
    'X-Plex-Platform': c.platform,
    'X-Plex-Device': c.device,
    'X-Plex-Device-Name': c.deviceName,
  };
  if (token) h['X-Plex-Token'] = token;
  return h;
}

/**
 * Crée un PIN de connexion. `strong` = long code pour le lien navigateur ;
 * sinon code à 4 caractères à saisir sur plex.tv/link (pratique sur TV).
 */
export function createPin(c: ClientInfo, strong: boolean): Promise<PlexPin> {
  return getJson<PlexPin>(`${TV}/pins?strong=${strong}`, { method: 'POST', headers: identityHeaders(c) });
}

export function pinAuthUrl(c: ClientInfo, pin: PlexPin): string {
  const p = new URLSearchParams({
    clientID: c.clientId,
    code: pin.code,
    'context[device][product]': c.product,
    'context[device][platform]': c.platform,
    'context[device][device]': c.device,
  });
  return `https://app.plex.tv/auth#?${p}`;
}

/** Renvoie le jeton une fois le PIN validé par l'utilisateur, sinon null. */
export async function checkPin(c: ClientInfo, pin: PlexPin): Promise<string | null> {
  const r = await getJson<{ authToken: string | null }>(`${TV}/pins/${pin.id}?code=${encodeURIComponent(pin.code)}`, {
    headers: identityHeaders(c),
  });
  return r.authToken || null;
}

export function getUser(c: ClientInfo, token: string): Promise<PlexUser> {
  return getJson<PlexUser>(`${TV}/user`, { headers: identityHeaders(c, token) });
}

export async function getServers(c: ClientInfo, token: string): Promise<PlexResource[]> {
  const all = await getJson<PlexResource[]>(`${TV}/resources?includeHttps=1&includeRelay=1&includeIPv6=1`, {
    headers: identityHeaders(c, token),
  });
  return all.filter((r) => r.provides.split(',').includes('server'));
}

/** Local direct d'abord, puis distant direct, puis relais. */
export function rankConnections(conns: PlexConnection[], secureOnly: boolean): PlexConnection[] {
  const rank = (c: PlexConnection) => (c.relay ? 2 : c.local ? 0 : 1);
  return conns.filter((c) => !secureOnly || c.uri.startsWith('https:')).sort((a, b) => rank(a) - rank(b));
}

/**
 * Teste toutes les connexions en parallèle et renvoie la mieux classée qui
 * répond, sans attendre les moins bonnes dès qu'une meilleure a répondu.
 */
export function pickConnection(
  conns: PlexConnection[],
  opts: { secureOnly: boolean; timeout?: number; token?: string; probe?: (uri: string) => Promise<unknown> },
): Promise<PlexConnection | null> {
  const list = rankConnections(conns, opts.secureOnly);
  // Avec le jeton : sans lui, Plex n'autorise que ses propres sites (app.plex.tv, localhost) à lire
  // la réponse, et la version web hébergée ailleurs croyait le serveur injoignable.
  const q = opts.token ? `?X-Plex-Token=${encodeURIComponent(opts.token)}` : '';
  const probe = opts.probe ?? ((uri: string) => getJson(`${uri}/identity${q}`, { timeout: opts.timeout ?? 5000 }));
  if (!list.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    const state: ('pending' | 'ok' | 'fail')[] = list.map(() => 'pending');
    const settle = () => {
      for (let i = 0; i < list.length; i++) {
        if (state[i] === 'ok') return resolve(list[i]);
        if (state[i] === 'pending') return;
      }
      resolve(null);
    };
    list.forEach((c, i) => {
      probe(c.uri)
        .then(
          () => (state[i] = 'ok'),
          () => (state[i] = 'fail'),
        )
        .then(settle);
    });
  });
}

/** Un profil du foyer Plex Home. */
export interface HomeUser {
  id: number;
  uuid: string;
  title: string;
  thumb?: string;
  /** Propriétaire du foyer. */
  admin: boolean;
  /** Profil géré (sans compte Plex à lui, souvent un enfant). */
  restricted: boolean;
  /** Protégé par un code PIN. */
  protected: boolean;
}

/** Les profils du foyer Plex Home du compte ; un seul (ou aucun) s'il n'y a pas de foyer. */
export async function getHomeUsers(c: ClientInfo, token: string): Promise<HomeUser[]> {
  const home = await getJson<{ users?: Partial<HomeUser>[] }>(`${TV}/home/users`, { headers: identityHeaders(c, token) });
  return (home.users ?? [])
    .filter((u): u is Partial<HomeUser> & { uuid: string } => typeof u.uuid === 'string')
    .map((u) => ({ id: Number(u.id) || 0, uuid: u.uuid, title: String(u.title ?? '?'), thumb: u.thumb || undefined, admin: !!u.admin, restricted: !!u.restricted, protected: !!u.protected }));
}

/**
 * Vrai si le profil connecté est un profil géré du foyer Plex Home : ni liste de suivi ni amis
 * pour lui. Sa fiche dans la liste du foyer fait foi ; sans elle (liste pas encore chargée, ou
 * pas de foyer), on s'en tient à ce que plex.tv a dit du compte à la connexion. Dans le doute : non.
 */
export function isManagedProfile(user: Pick<PlexUser, 'uuid' | 'restricted'> | null | undefined, home: readonly Pick<HomeUser, 'uuid' | 'restricted'>[]): boolean {
  if (!user) return false;
  const me = home.find((u) => u.uuid === user.uuid);
  return me ? me.restricted === true : user.restricted === true;
}

/** Passe sur un autre profil du foyer et renvoie son jeton. `pin` : son code, s'il est protégé. */
export async function switchHomeUser(c: ClientInfo, token: string, uuid: string, pin?: string): Promise<string> {
  if (!/^[0-9a-f]{8,40}$/i.test(uuid)) throw new Error('Profil invalide');
  const q = pin ? `?pin=${encodeURIComponent(pin)}` : '';
  const user = await getJson<{ authToken?: string }>(`${TV}/home/users/${uuid}/switch${q}`, { method: 'POST', headers: identityHeaders(c, token) });
  if (!user.authToken) throw new Error('Changement de profil refusé');
  return user.authToken;
}
