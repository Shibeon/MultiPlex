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

/**
 * Salle, clé, et preuve d'hôte : une troisième valeur indépendante, que seuls les membres de la
 * séance (qui ont le secret) savent calculer. L'hôte la présente au relais en annonçant la séance
 * (en clair : elle ne donne ni la clé ni le secret), et le relais n'en garde que l'empreinte ; un
 * utilisateur qui ne connaît que le numéro de salle (listé) ne peut donc pas l'annoncer à sa place.
 */
export interface SessionKeys {
  room: string;
  key: CryptoKey;
  owner?: string;
}

async function split(base: CryptoKey): Promise<SessionKeys> {
  const roomBits = await crypto.subtle.deriveBits(hkdf('multiplex-together-room'), base, 128);
  const ownerBits = await crypto.subtle.deriveBits(hkdf('multiplex-together-owner'), base, 128);
  const key = await crypto.subtle.deriveKey(hkdf('multiplex-together-key'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { room: b64(new Uint8Array(roomBits)), key, owner: b64(new Uint8Array(ownerBits)) };
}

/**
 * Salle et clé d'une séance à invitation courte. Le secret (8 signes) est étiré par PBKDF2, salé
 * par l'identifiant du serveur Plex de l'hôte (que ses amis voient dans leur liste de serveurs,
 * mais pas le relais), puis HKDF en tire deux valeurs indépendantes : le numéro de salle, seul
 * envoyé au relais, et la clé AES-GCM. Du numéro de salle on ne remonte ni à la clé ni au secret,
 * sinon en essayant tous les secrets (≈ 8,5 × 10¹¹), chacun à 200 000 tours de PBKDF2, et en
 * connaissant l'identifiant du serveur.
 */
export async function deriveSession(secret: string, serverId: string, iterations = INVITE_ITERATIONS): Promise<SessionKeys> {
  const pw = await crypto.subtle.importKey('raw', new TextEncoder().encode(clean(secret)), 'PBKDF2', false, ['deriveBits']);
  const salt = new TextEncoder().encode(`multiplex-together-v3|${serverId}`);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, pw, 256);
  return split(await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits', 'deriveKey']));
}

/** Salle et clé des anciennes invitations (v2 : HKDF du secret de 96 bits ; v1 : données telles quelles). */
export async function deriveLegacy(c: Exclude<Invite, { v: 3 }>): Promise<SessionKeys> {
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

// ---------------------------------------------------------------------------------------------
// Séances visibles par les amis (voir apps/relay/README.md, « Séances visibles par vos amis »).
//
// Un relais configuré avec l'adresse de son serveur Plex (PLEX_URL) liste les séances que leurs
// hôtes ont rendues visibles, mais seulement à qui prouve avoir accès à ce serveur : l'application
// lui présente le jeton propre à ce serveur (celui que plex.tv donne pour lui dans les
// ressources), que le relais essaie auprès de son propre Plex. Le jeton du compte plex.tv, lui,
// ne part jamais : il ouvre tout le compte, pas seulement ce serveur. Et le jeton d'un serveur
// n'est remis qu'à un relais trouvé sur les noms publics de ce même serveur (relayCandidates).

/** Une séance visible, telle que le relais la liste à un ami autorisé. */
export interface FriendCard {
  /** Nom de l'hôte, titre et sous-titre de ce qu'il regarde. */
  name: string;
  title: string;
  sub?: string;
  type?: string;
  guid?: string;
  /** Numéro du titre sur le serveur du relais. */
  key?: string;
  /** Position (secondes) et lecture/pause au moment de l'annonce. */
  time: number;
  playing: boolean;
}

export interface FriendsAnswer {
  multiplex: 'relay';
  /** Identifiant (machineIdentifier) du serveur Plex auprès duquel le relais a vérifié l'accès. */
  server: string;
  /** Jeton d'entrée, court (quelques minutes) : annoncer une séance, entrer dans une séance listée. */
  ticket: string;
  ttl: number;
  sessions: { room: string; card: FriendCard; count: number; age: number }[];
}

export const isFriendsAnswer = (x: unknown): x is FriendsAnswer => {
  const a = x as FriendsAnswer;
  return !!a && typeof a === 'object' && a.multiplex === 'relay' && typeof a.server === 'string' && typeof a.ticket === 'string' && Array.isArray(a.sessions);
};

/** Adresse HTTP de la liste des séances visibles d'un relais (POST, jeton dans le corps). */
export const friendsUrl = (relay: string) => `${relay.replace(/^ws/, 'http')}/friends`;

/**
 * Jeton à présenter au relais d'un serveur pour prouver qu'on y a accès : le jeton propre à ce
 * serveur, jamais celui du compte. Quand plex.tv donne pour ce serveur le jeton du compte lui-même
 * (cela peut arriver pour ses propres serveurs), rien : l'appelant peut alors demander au serveur
 * un jeton délégué (voir PlexServer.delegationToken).
 */
export function serverCredential(res: Pick<PlexResource, 'accessToken'>, accountToken: string | undefined): string | null {
  const t = res.accessToken;
  return t && t !== accountToken ? t : null;
}

/**
 * Relais injoignables ou inutiles (pas de liste, autre serveur) : mis de côté un moment, puis
 * redemandés de plus en plus rarement (`base`, doublé à chaque échec, jusqu'à `max`), pour que la
 * relève régulière des séances des amis ne refrappe pas sans fin les mêmes adresses.
 */
export class RelayBackoff {
  private misses = new Map<string, { until: number; delay: number }>();
  constructor(
    private now: () => number = Date.now,
    private base = 60_000,
    private max = 3_600_000,
  ) {}
  blocked(relay: string): boolean {
    return (this.misses.get(relay)?.until ?? 0) > this.now();
  }
  fail(relay: string): void {
    const prev = this.misses.get(relay);
    const delay = prev ? Math.min(this.max, prev.delay * 2) : this.base;
    this.misses.set(relay, { until: this.now() + delay, delay });
  }
  ok(relay: string): void {
    this.misses.delete(relay);
  }
}

export interface FindRelayOptions {
  /** Adresses déjà reconnues comme relais (true) ou non (false, plus jamais redemandées). */
  known?: Map<string, boolean>;
  /** Échecs mis de côté (voir RelayBackoff). */
  backoff?: RelayBackoff;
  /**
   * Identifiant du serveur Plex attendu : seul compte alors un relais qui sait lister ET dont le
   * Plex est ce serveur-là (`server` de sa réponse à /rooms, public comme le /identity de Plex).
   * C'est vérifié AVANT qu'aucun jeton ne parte.
   */
  server?: string;
}

/**
 * Premier relais MultiPlex (dans l'ordre de préférence) parmi des adresses candidates, sans
 * attendre les moins bien classées. `ask` rend la réponse à « GET …/rooms » (sans salle) ;
 * `friends` dit si ce relais sait lister les séances visibles, `server` de quel Plex.
 */
export function findRelay(relays: string[], ask: (relay: string) => Promise<unknown>, opts: FindRelayOptions = {}): Promise<{ relay: string; friends: boolean; server?: string } | null> {
  const { known, backoff, server } = opts;
  const list = [...new Set(relays)].filter((r) => known?.get(r) !== false && !backoff?.blocked(r)).slice(0, MAX_RELAY_CANDIDATES);
  if (!list.length) return Promise.resolve(null);
  type Hit = { friends: boolean; server?: string };
  return new Promise((resolve) => {
    const state: (Hit | null | undefined)[] = list.map(() => undefined);
    const settle = () => {
      for (let i = 0; i < list.length; i++) {
        if (state[i] === undefined) return;
        if (state[i]) return resolve({ relay: list[i], ...state[i]! });
      }
      resolve(null);
    };
    list.forEach((relay, i) => {
      ask(relay)
        .then(
          (a) => {
            const ok = isRoomsAnswer(a);
            known?.set(relay, ok);
            const r = a as RoomsAnswer & { friends?: boolean; server?: unknown };
            const hit: Hit | null = ok ? { friends: r.friends === true, server: typeof r.server === 'string' ? r.server : undefined } : null;
            const useful = !!hit && (server === undefined || (hit.friends && hit.server === server));
            if (useful) backoff?.ok(relay);
            else backoff?.fail(relay);
            state[i] = useful ? hit : null;
          },
          () => {
            backoff?.fail(relay);
            state[i] = null;
          },
        )
        .then(settle);
    });
  });
}

/** Ce que l'hôte remet, chiffré pour lui seul, à un ami autorisé qui demande à entrer. */
export interface GrantPayload {
  /** Secret de l'invitation et serveur qui la sale : l'ami en tire salle et clé (deriveSession). */
  secret: string;
  server: string;
  /** Où en est la séance, pour arriver au bon endroit sans attendre. */
  state?: { time: number; playing: boolean; c: number; by: string };
}

const GRANT_SALT = new TextEncoder().encode('multiplex-together-grant-v1');
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

async function grantKey(priv: CryptoKey, peerPub: string, info: string): Promise<CryptoKey> {
  const pub = await crypto.subtle.importKey('raw', unb64(peerPub), ECDH, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: GRANT_SALT, info: new TextEncoder().encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Clé éphémère (P-256) d'une demande d'entrée : la publique part au relais, la privée reste ici. */
export async function grantRequestKeys(): Promise<{ pub: string; priv: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(ECDH, false, ['deriveBits'])) as CryptoKeyPair;
  return { pub: b64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), priv: pair.privateKey };
}

/** Hôte : chiffre `payload` pour la clé publique de la demande (ECDH éphémère, HKDF, AES-GCM). */
export async function sealGrant(requestPub: string, payload: GrantPayload): Promise<{ pub: string; box: string }> {
  const mine = await grantRequestKeys();
  const key = await grantKey(mine.priv, requestPub, `${requestPub}|${mine.pub}`);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return { pub: mine.pub, box: b64(out) };
}

/** Ami : ouvre la remise de l'hôte (rejette si elle n'est pas pour lui, ou abîmée). */
export async function openGrant(priv: CryptoKey, requestPub: string, grantPub: string, box: string): Promise<GrantPayload> {
  const key = await grantKey(priv, grantPub, `${requestPub}|${grantPub}`);
  const bytes = unb64(box);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  const p = JSON.parse(new TextDecoder().decode(plain)) as GrantPayload;
  if (!p || typeof p.secret !== 'string' || clean(p.secret).length !== INVITE_LENGTH || typeof p.server !== 'string' || !p.server) throw new Error('grant');
  return p;
}
