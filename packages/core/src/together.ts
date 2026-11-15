// « Regarder ensemble » : invitations, clés de séance et recherche du relais. Rien ici ne touche
// au réseau : la recherche reçoit sa fonction d'interrogation, ce qui la rend testable.
import type { PlexResource } from './types';

/**
 * Alphabet des invitations : chiffres et lettres sans les caractères que l'on confond à l'œil ou
 * à l'oreille (ni 0/O, ni 1/I/L). 31 signes, soit 8 × log2(31) ≈ 39,6 bits pour 8 caractères.
 */
export const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const INVITE_LENGTH = 8;

/**
 * Coût de la dérivation (PBKDF2-SHA256) : quelques dizaines de millisecondes sur un ordinateur,
 * et ce qui rend le secret court coûteux à éprouver hors ligne (voir deriveSession).
 */
export const INVITE_ITERATIONS = 200_000;

/** Chemin conventionnel du relais quand il est servi à la même adresse que le serveur Plex. */
export const RELAY_PATH = '/multiplex-relay';

/** Au plus tant d'adresses de relais essayées, et de serveurs (salles) demandées à chacune. */
export const MAX_RELAY_CANDIDATES = 16;
export const MAX_ROOM_LOOKUP = 16;

/**
 * Invitation lue :
 * - v3 : « MPX-K7Q2-9XFD », secret court ; le relais est trouvé grâce au serveur Plex (ou donné
 *   après « @ » quand l'hôte n'a pas pu le rendre trouvable) ;
 * - v2 : « MPX-<secret de 16 signes>@<relais> » (avant les invitations courtes) ;
 * - v1 : « MPX- » suivi de relais, salle et clé en JSON (les toutes premières).
 */
export type Invite = { v: 3; secret: string; relay?: string } | { v: 2; relay: string; secret: string } | { v: 1; relay: string; room: string; key: string };

const SEP = '[\\s\\-–—_.]*';
const CHAR = '[2-9A-HJKMNP-Z]';
const SHORT = new RegExp(`MPX${SEP}(${CHAR}(?:${SEP}${CHAR}){${INVITE_LENGTH - 1}})(?![A-Za-z0-9])(?:\\s*@\\s*([^\\s]+))?`, 'i');
const BARE = new RegExp(`^(${CHAR}(?:${SEP}${CHAR}){${INVITE_LENGTH - 1}})$`, 'i');

/** Secret d'une nouvelle invitation : 8 signes tirés au hasard, uniformément, dans l'alphabet. */
export function makeSecret(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let out = '';
  // Tirage par rejet : 248 = 8 × 31, au-delà l'octet est jeté pour ne favoriser aucun signe.
  const limit = 256 - (256 % INVITE_ALPHABET.length);
  while (out.length < INVITE_LENGTH) {
    for (const b of random(INVITE_LENGTH * 2)) {
      if (b < limit && out.length < INVITE_LENGTH) out += INVITE_ALPHABET[b % INVITE_ALPHABET.length];
    }
  }
  return out;
}

/** « MPX-K7Q2-9XFD », ou « MPX-K7Q2-9XFD@relais.exemple.fr » quand le relais doit être donné. */
export function formatInvite(secret: string, relay?: string): string {
  const s = secret.toUpperCase();
  const code = `MPX-${s.slice(0, 4)}-${s.slice(4)}`;
  return relay ? `${code}@${relay.replace(/^wss:\/\//, '')}` : code;
}

const clean = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

/** Lit une invitation dans un texte collé (majuscules ou non, espaces et tirets libres). */
export function parseInvite(text: string): Invite | null {
  const s = text.trim();
  // v2 : secret de 16 signes base64url, sensible à la casse.
  const v2 = /MPX-([A-Za-z0-9_-]{16})@([^\s]+)/.exec(s);
  if (v2) {
    const relay = relayUrl(v2[2]);
    return relay ? { v: 2, relay, secret: v2[1] } : null;
  }
  const short = SHORT.exec(s) ?? BARE.exec(s);
  if (short) {
    const secret = clean(short[1]);
    if (!short[2]) return { v: 3, secret };
    const relay = relayUrl(short[2].replace(/[)\].,;!?»"']+$/, ''));
    return relay ? { v: 3, secret, relay } : null;
  }
  const v1 = /MPX-([A-Za-z0-9_-]{20,600})/.exec(s);
  if (!v1) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(unb64(v1[1]))) as { r?: string; i?: string; k?: string };
    if (!j.r || !/^wss?:\/\//.test(j.r) || !j.i || !/^[A-Za-z0-9_-]{16,64}$/.test(j.i) || !j.k || unb64(j.k).length !== 32) return null;
    return { v: 1, relay: j.r, room: j.i, key: j.k };
  } catch {
    return null;
  }
}

/** Texte à repartager pour une invitation déjà lue (une ancienne se repartage telle quelle). */
export function inviteText(c: Invite): string {
  if (c.v === 3) return formatInvite(c.secret, c.relay);
  if (c.v === 2) return `MPX-${c.secret}@${c.relay.replace(/^wss:\/\//, '')}`;
  return `MPX-${b64(new TextEncoder().encode(JSON.stringify({ r: c.relay, i: c.room, k: c.key })))}`;
}

/** Adresse de relais saisie (https://…, wss://… ou un nom seul) → wss://… sans « / » final. */
export function relayUrl(input: string): string {
  const s = input.trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol === 'https:') u.protocol = 'wss:';
    else if (u.protocol === 'http:') u.protocol = 'ws:';
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const hkdf = (info: string) => ({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(info) });

async function split(base: CryptoKey): Promise<{ room: string; key: CryptoKey }> {
  const roomBits = await crypto.subtle.deriveBits(hkdf('multiplex-together-room'), base, 128);
  const key = await crypto.subtle.deriveKey(hkdf('multiplex-together-key'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { room: b64(new Uint8Array(roomBits)), key };
}

/**
 * Salle et clé d'une séance à invitation courte. Le secret (8 signes) est étiré par PBKDF2, salé
 * par l'identifiant du serveur Plex de l'hôte (que ses amis voient dans leur liste de serveurs,
 * mais pas le relais), puis HKDF en tire deux valeurs indépendantes : le numéro de salle, seul
 * envoyé au relais, et la clé AES-GCM. Du numéro de salle on ne remonte ni à la clé ni au secret,
 * sinon en essayant tous les secrets (≈ 8,5 × 10¹¹), chacun à 200 000 tours de PBKDF2, et en
 * connaissant l'identifiant du serveur.
 */
export async function deriveSession(secret: string, serverId: string, iterations = INVITE_ITERATIONS): Promise<{ room: string; key: CryptoKey }> {
  const pw = await crypto.subtle.importKey('raw', new TextEncoder().encode(clean(secret)), 'PBKDF2', false, ['deriveBits']);
  const salt = new TextEncoder().encode(`multiplex-together-v3|${serverId}`);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, pw, 256);
  return split(await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits', 'deriveKey']));
}

/** Salle et clé des anciennes invitations (v2 : HKDF du secret de 96 bits ; v1 : données telles quelles). */
export async function deriveLegacy(c: Exclude<Invite, { v: 3 }>): Promise<{ room: string; key: CryptoKey }> {
  if (c.v === 1) return { room: c.room, key: await crypto.subtle.importKey('raw', unb64(c.key), 'AES-GCM', false, ['encrypt', 'decrypt']) };
  return split(await crypto.subtle.importKey('raw', unb64(c.secret), 'HKDF', false, ['deriveBits', 'deriveKey']));
}

const isIp = (host: string) => /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[');

/**
 * Adresses où peut se trouver le relais d'un serveur Plex : sur les noms publics de ses
 * connexions (les « URL d'accès personnalisées » du serveur, publiées par plex.tv à ceux avec qui
 * il est partagé), à la racine ou sous /multiplex-relay, sur le port de la connexion ou en 443.
 * Les adresses locales, celles du relais de Plex, les IP et les noms *.plex.direct sont écartés :
 * aucun relais ne peut y présenter un certificat valable.
 */
export function relayCandidates(servers: Pick<PlexResource, 'connections'>[]): string[] {
  const out: string[] = [];
  for (const srv of servers) {
    for (const c of srv.connections ?? []) {
      if (c.local || c.relay) continue;
      let u: URL;
      try {
        u = new URL(c.uri);
      } catch {
        continue;
      }
      const host = u.hostname.toLowerCase();
      if (u.protocol !== 'https:' || isIp(host) || host.endsWith('.plex.direct') || !host.includes('.')) continue;
      const port = u.port && u.port !== '443' ? `:${u.port}` : '';
      const forms = [`wss://${host}${port}${RELAY_PATH}`, `wss://${host}${port}`];
      if (port) forms.push(`wss://${host}${RELAY_PATH}`, `wss://${host}`);
      for (const f of forms) if (!out.includes(f)) out.push(f);
    }
  }
  return out.slice(0, MAX_RELAY_CANDIDATES);
}

/** Vrai si un ami qui voit `servers` trouvera tout seul le relais `relay`. */
export function relayDiscoverable(relay: string, servers: Pick<PlexResource, 'connections'>[]): boolean {
  const r = relayUrl(relay);
  return !!r && relayCandidates(servers).includes(r);
}

/** Réponse d'un relais MultiPlex à « GET …/rooms?ids=… ». */
export interface RoomsAnswer {
  multiplex: 'relay';
  found: string[];
}

export const isRoomsAnswer = (x: unknown): x is RoomsAnswer => !!x && typeof x === 'object' && (x as RoomsAnswer).multiplex === 'relay' && Array.isArray((x as RoomsAnswer).found);

/** Adresse HTTP de la recherche de salles d'un relais. */
export const roomsUrl = (relay: string, rooms: string[]) => `${relay.replace(/^ws/, 'http')}/rooms?ids=${rooms.map(encodeURIComponent).join(',')}`;

/**
 * Cherche, parmi les relais candidats (dans l'ordre de préférence), celui où l'une des salles
 * existe. Tous sont interrogés en même temps ; on rend le mieux classé qui la connaît, sans
 * attendre les moins bien classés. `ask` rend la réponse du relais, ou rejette (injoignable, pas
 * un relais MultiPlex, délai dépassé). `known` retient les adresses qui ne sont pas des relais,
 * pour ne pas les réinterroger.
 */
export function findRoom(
  relays: string[],
  rooms: string[],
  ask: (relay: string, rooms: string[]) => Promise<unknown>,
  known?: Map<string, boolean>,
): Promise<{ relay: string; room: string } | null> {
  const list = [...new Set(relays)].filter((r) => known?.get(r) !== false).slice(0, MAX_RELAY_CANDIDATES);
  const ids = [...new Set(rooms)].slice(0, MAX_ROOM_LOOKUP);
  if (!list.length || !ids.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    const state: (string | null | undefined)[] = list.map(() => undefined);
    const settle = () => {
      for (let i = 0; i < list.length; i++) {
        if (state[i] === undefined) return;
        if (state[i]) return resolve({ relay: list[i], room: state[i]! });
      }
      resolve(null);
    };
    list.forEach((relay, i) => {
      ask(relay, ids)
        .then(
          (a) => {
            const ok = isRoomsAnswer(a);
            known?.set(relay, ok);
            state[i] = ok ? (ids.find((id) => a.found.includes(id)) ?? null) : null;
          },
          () => (state[i] = null),
        )
        .then(settle);
    });
  });
}
