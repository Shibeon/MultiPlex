// Relais « Regarder ensemble » de MultiPlex.
//
// Un relais volontairement bête : il fait suivre chaque message d'une salle aux autres membres
// de la même salle, sans rien lire. Les applications chiffrent tout de bout en bout (la clé vient
// de l'invitation, jamais envoyée ici) : le relais ne voit ni titre, ni pseudo, ni position.
//
//   GET  /health            → « ok » (sonde de Docker ou du proxy)
//   GET  /rooms?ids=a,b,…   → {"multiplex":"relay","found":[…],"friends":bool} : les salles qui
//                             existent parmi celles demandées (16 au plus). C'est ainsi que
//                             l'application d'un invité reconnaît un relais MultiPlex et trouve la
//                             séance ; `friends` dit si ce relais liste les séances visibles.
//   WS   /r/<salle>         → la salle ; jusqu'à 16 membres, messages de 16 Ko au plus
//   POST /friends           → séances visibles par les amis (seulement avec PLEX_URL ET
//                             PLEX_TOKEN) : le corps {"token":"…"} porte le jeton propre au serveur
//                             Plex du relais. Le relais l'essaie auprès de ce Plex, retrouve QUI
//                             il est grâce aux partages du propriétaire (plex.tv), et ne liste à
//                             chacun que les séances dont l'hôte l'a mis dans sa liste d'amis Plex.
//                             Un ami autorisé entre dans une séance listée par WS /r/<salle>, puis
//                             demande la clé à l'hôte avec son ticket dans le message (jamais dans
//                             l'adresse ; voir README, « Séances visibles par vos amis »)
//
// Les messages binaires d'une salle sont chiffrés par les applications et suivent tels quels. Les
// messages texte (JSON) s'adressent au relais lui-même et ne sont jamais renvoyés tels quels :
// annonce d'une séance visible (« announce », « unlist », « release ») et remise de la clé d'un
// hôte à un ami autorisé (« key-request », « key-grant », dont le contenu est chiffré pour l'ami
// seul). Ils ont leur propre budget (20 par 10 s), à part de celui des messages de la séance.
//
// Les invitations sont courtes (8 signes) : chaque salle demandée, et chaque entrée dans une
// salle, coûte un jeton à l'adresse IP (30 par minute, 60 d'avance), et les salles demandées qui
// n'existent pas coûtent aussi un jeton à un compteur commun (10 par seconde), pour borner les
// essais au hasard même depuis beaucoup d'adresses. Une demande de liste coûte aussi un jeton à
// l'adresse, et les vérifications demandées à Plex sont bornées par adresse (5 d'avance, puis une
// toutes les 30 s ; IPv6 : par /64) puis pour tout le monde (2 par seconde, 30 d'avance). Une
// salle ferme au bout de ROOM_TTL_HOURS.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const MAX_MESSAGE = 16 * 1024;
const MAX_LOOKUP = 16;
// Au plus 40 messages par tranche de 10 secondes et par membre : largement assez pour la synchro.
const RATE = { count: 40, windowMs: 10_000 };
// Séances visibles par les amis. Un message au relais peut porter la liste d'amis de l'hôte
// (1 000 numéros de compte plex.tv au plus).
const MAX_CONTROL = 16 * 1024;
const MAX_ALLOW = 1000;
// Messages au relais (annonce, demande et remise de clé) : budget à part de celui de la séance,
// pour qu'un flot de demandes ne fasse jamais taire les messages chiffrés de l'hôte.
const CONTROL_RATE = { count: 20, windowMs: 10_000 };
// Demandes de clé transmises à l'hôte d'une salle : 3 d'avance, puis une toutes les 5 secondes.
const KEY_REQUESTS = { burst: 3, perSecond: 0.2 };
const TICKET_TTL_MS = 120_000;
const VERDICT_OK_MS = 5 * 60_000;
const VERDICT_KO_MS = 60_000;
const MAX_VERDICTS = 2000;
const MAX_TICKETS = 5000;
const PROBE_EVERY_MS = 10 * 60_000;
// Partages relus auprès de plex.tv au plus une fois par minute quand un jeton accepté par Plex n'y
// figure pas encore (un partage tout neuf), en plus de la relecture toutes les 10 minutes.
const DIRECTORY_MIN_MS = 60_000;
// Un jeton que Plex accepte mais que plex.tv ne nomme pas encore (un partage tout neuf) : verdict
// gardé le temps d'une relecture seulement.
const VERDICT_UNNAMED_MS = DIRECTORY_MIN_MS;
// Plex ou plex.tv en échec : nouvel essai après 1 minute, puis le double à chaque échec, 30 au plus.
const PROBE_RETRY_MS = 60_000;
const PROBE_RETRY_MAX_MS = 30 * 60_000;

/** Seau à jetons : `burst` d'avance, `perSecond` regagnés chaque seconde. */
export function bucket(burst, perSecond, now = Date.now) {
  let tokens = burst;
  let at = now();
  return {
    take(n = 1) {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - at) / 1000) * perSecond);
      at = t;
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
    full() {
      return Math.min(burst, tokens + ((now() - at) / 1000) * perSecond) >= burst;
    },
  };
}

/**
 * Clé de limite d'une adresse : une adresse IPv4 telle quelle (y compris écrite « ::ffff:a.b.c.d »),
 * une adresse IPv6 par son préfixe /64, que n'importe quel abonné reçoit en entier et peut faire
 * tourner à volonté.
 */
export function limitKey(ip) {
  const a = String(ip ?? '').trim().toLowerCase();
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (v4) return v4[1];
  if (!a.includes(':')) return a;
  const [head, tail = ''] = a.split('::');
  const left = head ? head.split(':') : [];
  const right = a.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = a.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((g) => (parseInt(g, 16) || 0).toString(16))
    .join(':')}::/64`;
}

/** Seaux par adresse IP (IPv6 : par /64), oubliés une fois pleins (pour ne pas grossir sans fin). */
export function perIp(burst, perSecond, now = Date.now) {
  const map = new Map();
  return {
    take(ip, n = 1) {
      const k = limitKey(ip);
      let b = map.get(k);
      if (!b) map.set(k, (b = bucket(burst, perSecond, now)));
      return b.take(n);
    },
    sweep() {
      for (const [ip, b] of map) if (b.full()) map.delete(ip);
    },
    get size() {
      return map.size;
    },
  };
}

const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80:|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i;

/**
 * Adresse du client. Derrière un proxy inverse (sur le NAS, dans Docker), la connexion vient d'une
 * adresse privée : on prend alors la dernière adresse de X-Forwarded-For, celle que le proxy a
 * ajoutée (les précédentes peuvent être inventées par le client). TRUST_PROXY=0 l'interdit,
 * TRUST_PROXY=1 l'impose.
 */
export function clientIp(req, trust = process.env.TRUST_PROXY) {
  const peer = req.socket?.remoteAddress ?? '';
  const fwd = String(req.headers?.['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();
  const useFwd = trust === '1' || (trust !== '0' && PRIVATE.test(peer));
  return (useFwd && fwd) || peer;
}

const ROOM = /^[A-Za-z0-9_-]{16,64}$/;
const KEY = /^[A-Za-z0-9_-]{40,200}$/;
const BOX = /^[A-Za-z0-9_-]{20,3000}$/;
// Preuve d'hôte : valeur tirée du secret de la séance (connue de ses seuls membres), indépendante
// de la clé et du numéro de salle. Le relais n'en garde que l'empreinte.
const PROOF = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Accès au serveur Plex du relais (PLEX_URL, par exemple http://192.168.1.10:32400).
 *
 * - check(jeton) : vrai si Plex accepte ce jeton (« GET /library/sections » : 200), faux s'il le
 *   refuse (401 ou 403), rejette sinon (Plex injoignable, réponse inattendue). Le jeton propre à
 *   un serveur partagé n'est accepté que par ce serveur-là ; celui d'un autre serveur, ou un jeton
 *   inventé, est refusé (401). Rien n'est écrit sur Plex, et le relais ne garde aucun jeton : il
 *   n'en retient que l'empreinte (SHA-256) et le verdict, quelques minutes.
 * - admin(jeton) : vrai si ce jeton est celui de l'administrateur du serveur, c'est-à-dire de son
 *   propriétaire (« GET /status/sessions », réservé à l'administrateur : `security: user_token:
 *   [admin]` dans la description officielle de l'API de Plex, quand le reste est ouvert aux
 *   utilisateurs partagés). Un jeton délégué (`/security/token?type=delegation`) a « le même niveau
 *   d'accès » que celui qui l'a demandé (même description) : celui du propriétaire passe, celui
 *   d'un ami non.
 * - probe() : identifiant du serveur (« GET /identity », sans jeton) et contre-épreuve : un jeton
 *   tiré au hasard doit être refusé. S'il est accepté, ce Plex laisse entrer le relais sans
 *   authentification (Réseau → « Liste des adresses IP et réseaux autorisés sans
 *   authentification ») : le relais ne peut alors rien vérifier, et ne liste aucune séance.
 */
export function plexVerifier(base, { fetch: get = fetch, timeoutMs = 5000 } = {}) {
  const url = String(base).replace(/\/+$/, '');
  const ask = (path, token) => {
    const headers = { accept: 'application/json' };
    if (token !== undefined) headers['x-plex-token'] = token;
    return get(`${url}${path}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  };
  const verdict = async (path, token) => {
    const r = await ask(path, token);
    await r.arrayBuffer().catch(() => {});
    if (r.status === 200) return true;
    if (r.status === 401 || r.status === 403) return false;
    throw new Error(`Plex : ${r.status}`);
  };
  const check = (token) => verdict('/library/sections', token);
  return {
    check,
    admin: (token) => verdict('/status/sessions', token),
    async probe() {
      const r = await ask('/identity');
      if (r.status !== 200) throw new Error(`Plex : ${r.status}`);
      const id = (await r.json())?.MediaContainer?.machineIdentifier;
      if (typeof id !== 'string' || !id) throw new Error('Plex : pas d’identifiant');
      return { server: id, open: await check(randomBytes(15).toString('base64url')) };
    },
  };
}

const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (v) =>
  v.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : XML_ENTITIES[e.toLowerCase()],
  );

/**
 * Attributs de chaque élément `<tag …>` d'une réponse XML de plex.tv (les anciennes adresses
 * /api/… répondent en XML, et python-plexapi les lit ainsi). Pas de bibliothèque : seuls comptent
 * les attributs entre guillemets doubles des éléments demandés.
 */
export function xmlElements(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(\\s[^>]*?)?/?>`, 'g');
  for (const m of String(xml).matchAll(re)) {
    const attrs = {};
    for (const a of (m[1] ?? '').matchAll(/([A-Za-z_][\w:.-]*)="([^"]*)"/g)) attrs[a[1]] = unxml(a[2]);
    out.push(attrs);
  }
  return out;
}

/**
 * Nom d'un compte plex.tv sur une fiche. Le `title` se choisit librement (deux comptes peuvent
 * avoir le même), le `username` est unique sur plex.tv : « title (username) » quand ils diffèrent,
 * sinon le username ; le title seul pour un profil géré, qui n'a pas de username.
 */
export function displayName(u) {
  const title = str(u?.title, 60) ?? str(u?.friendlyName, 60);
  const username = str(u?.username, 60);
  if (username) return title && title !== username ? `${title} (${username})` : username;
  return title;
}
const userName = displayName;
/** Numéro de compte plex.tv (entier positif), sous forme de texte ; sinon undefined. */
const accountId = (v) => (/^\d{1,12}$/.test(String(v ?? '')) && Number(v) > 0 ? String(Number(v)) : undefined);

/**
 * Le compte plex.tv du propriétaire du serveur (PLEX_TOKEN), seulement lu, pour savoir QUI est
 * derrière chaque jeton de serveur. Adresses et champs de python-plexapi (myplex.py) :
 *
 * - me() : `GET https://plex.tv/api/v2/user` (MyPlexAccount) → le propriétaire : `id`, `title`,
 *   `username`, `thumb`.
 * - shares(machineId) : `GET https://plex.tv/api/servers/{machineId}/shared_servers` (ce que lit
 *   MyPlexUser.get_token) → pour chaque partage du serveur, `userID` (le compte de l'ami) et
 *   `accessToken` (le jeton propre à ce serveur que plex.tv attribue à cet ami ; python-plexapi
 *   s'en sert pour ouvrir le serveur en son nom, PlexServer.switchUser).
 * - users() : `GET https://plex.tv/api/users/` (MyPlexUser) → les amis du propriétaire : `id` (le
 *   même numéro de compte que `userID` : get_token compare l'un à l'autre), `title`, `username`,
 *   `thumb`.
 *
 * Le jeton ne part qu'en en-tête, et seulement vers plex.tv ; aucune erreur ne le cite.
 */
export function plexAccount(token, { base = 'https://plex.tv', fetch: get = fetch, timeoutMs = 10_000, clientId = 'multiplex-relay' } = {}) {
  const url = String(base).replace(/\/+$/, '');
  const ask = async (path, accept) => {
    let r;
    try {
      r = await get(`${url}${path}`, {
        headers: { accept, 'x-plex-token': token, 'x-plex-client-identifier': clientId, 'x-plex-product': 'MultiPlex Relay' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error('plex.tv injoignable');
    }
    if (r.status !== 200) {
      await r.arrayBuffer().catch(() => {});
      throw new Error(`plex.tv : ${r.status}`);
    }
    return r;
  };
  return {
    async me() {
      const u = await (await ask('/api/v2/user', 'application/json')).json().catch(() => null);
      const id = accountId(u?.id);
      if (!id) throw new Error('plex.tv : compte illisible');
      return { id, name: userName(u) ?? 'Plex', thumb: str(u?.thumb, 300) };
    },
    async shares(machineId) {
      const xml = await (await ask(`/api/servers/${encodeURIComponent(machineId)}/shared_servers`, 'application/xml')).text();
      return xmlElements(xml, 'SharedServer')
        .map((e) => ({ id: accountId(e.userID), token: e.accessToken }))
        .filter((e) => e.id && typeof e.token === 'string' && e.token);
    },
    async users() {
      const xml = await (await ask('/api/users/', 'application/xml')).text();
      return xmlElements(xml, 'User')
        .map((e) => ({ id: accountId(e.id), name: userName(e), thumb: str(e.thumb, 300) }))
        .filter((e) => e.id);
    },
  };
}

/** Liste d'amis annoncée par un hôte : numéros de compte plex.tv, 1 000 au plus ; sinon null. */
export function allowList(v) {
  if (!Array.isArray(v) || v.length > MAX_ALLOW) return null;
  const out = new Set();
  for (const x of v) {
    const id = typeof x === 'string' || typeof x === 'number' ? accountId(x) : undefined;
    if (!id) return null;
    out.add(id);
  }
  return out;
}

/**
 * Fiche d'une séance visible : titre et position tels que l'hôte les annonce, et son nom tel que
 * le relais l'a vérifié (`verifiedName`, celui de son compte plex.tv ; le nom que l'hôte déclare
 * est ignoré). Tout le reste (appareil, adresse, flux…) est écarté ; le nombre de participants
 * est compté ici.
 */
export function sanitizeCard(c, verifiedName) {
  if (!c || typeof c !== 'object') return null;
  const name = str(verifiedName, 130);
  const title = str(c.title, 200);
  if (!name || !title) return null;
  const time = typeof c.time === 'number' && Number.isFinite(c.time) ? Math.max(0, Math.min(1e6, c.time)) : 0;
  const card = { name, title, time, playing: c.playing === true };
  for (const [k, n] of [
    ['sub', 200],
    ['type', 20],
    ['guid', 200],
    ['key', 40],
  ]) {
    const v = str(c[k], n);
    if (v) card[k] = v;
  }
  return card;
}

const sha = (s) => createHash('sha256').update(s).digest('base64url');

export function createRelay(opts = {}) {
  const env = process.env;
  const maxPeers = opts.maxPeers ?? (Number(env.MAX_PEERS) || 16);
  const maxRooms = opts.maxRooms ?? (Number(env.MAX_ROOMS) || 500);
  const ttlMs = opts.ttlMs ?? (Number(env.ROOM_TTL_HOURS) || 12) * 3600_000;
  const now = opts.now ?? Date.now;
  const ipLimit = perIp(opts.ipBurst ?? 60, opts.ipPerSecond ?? 0.5, now);
  const missLimit = bucket(opts.missBurst ?? 600, opts.missPerSecond ?? 10, now);

  // salle → { peers, created, card, cardAt, owner, proof, private, keyRequests, host, hostId, allow }
  // `host` : compte plex.tv vérifié de l'hôte qui l'annonce ; `hostId` : son numéro, attaché à la
  // salle dès la première annonce (seul ce compte peut la réannoncer) ; `allow` : ses amis.
  const rooms = new Map();

  // Séances visibles par les amis : seulement si le relais connaît son serveur Plex (PLEX_URL) ET
  // le compte plex.tv de son propriétaire (PLEX_TOKEN), sans lequel il ne saurait pas qui est qui.
  // Sans l'un des deux, rien n'est listé : jamais de repli sur « tout utilisateur du serveur ».
  const plexUrl = opts.plexUrl ?? env.PLEX_URL ?? '';
  const plexToken = opts.plexToken ?? env.PLEX_TOKEN ?? '';
  const verifier = plexUrl && plexToken ? (opts.verifier ?? plexVerifier(plexUrl)) : null;
  const account = verifier ? (opts.account ?? plexAccount(plexToken, { base: opts.plexTvUrl })) : null;
  if (plexUrl && !plexToken) console.warn('Séances visibles désactivées : PLEX_URL sans PLEX_TOKEN (le relais ne saurait pas qui est ami avec qui).');
  // `retryAt` : prochain essai permis après un échec (délai doublé à chaque fois, `retryMs`).
  const friends = { ready: false, server: '', reason: verifier ? 'pending' : 'off', probedAt: -Infinity, retryAt: -Infinity, retryMs: 0 };
  /**
   * Qui est derrière un jeton de serveur, d'après plex.tv : empreinte (SHA-256) du jeton de chaque
   * partage → compte de l'ami ; et le propriétaire lui-même, reconnu par Plex comme administrateur.
   * Aucun jeton n'est gardé, seulement leur empreinte.
   */
  const directory = { owner: null, byHash: new Map(), known: new Set(), loadedAt: -Infinity, triedAt: -Infinity, loading: null, ownerCheck: true };
  // Vérifications demandées à Plex (jetons pas encore connus) : bornées pour tout le monde.
  const plexLimit = bucket(opts.plexBurst ?? 30, opts.plexPerSecond ?? 2, now);
  // … et d'abord par adresse (IPv6 : par /64), pour qu'aucune ne vide la réserve commune.
  const plexIp = perIp(opts.plexIpBurst ?? 5, opts.plexIpPerSecond ?? 1 / 30, now);
  const verdicts = new Map(); // empreinte du jeton → { ok, user, until }
  const tickets = new Map(); // ticket → { until, used: salles où il a déjà servi, user }

  const delist = (room) => {
    room.card = null;
    room.cardAt = 0;
    room.host = null;
    room.allow = null;
  };
  /** Connexions ouvertes (renseigné plus bas, une fois le serveur WebSocket créé). */
  let sockets = () => [];

  /**
   * Tout ce que le relais a accordé est retiré : verdicts, tickets, fiches listées, et l'annonce
   * des connexions déjà autorisées (qui devront présenter un nouveau ticket). Appelé quand le relais
   * ne peut plus savoir qui est qui (Plex trop permissif, plex.tv illisible).
   */
  function revokeAll() {
    verdicts.clear();
    tickets.clear();
    for (const room of rooms.values()) delist(room);
    for (const ws of sockets()) {
      ws.authorized = false;
      ws.user = null;
    }
  }

  /**
   * Après une relecture des partages : un compte qui n'est plus partagé (ni propriétaire) perd tout
   * ce qui lui avait été accordé ; il disparaît des listes d'amis ; son annonce est retirée.
   */
  function revalidate() {
    const known = directory.known;
    for (const [k, v] of verdicts) if (v.user && !known.has(v.user.id)) verdicts.delete(k);
    for (const [k, e] of tickets) if (e.user && !known.has(e.user.id)) tickets.delete(k);
    for (const ws of sockets()) {
      if (ws.user && !known.has(ws.user.id)) {
        ws.authorized = false;
        ws.user = null;
      }
    }
    for (const room of rooms.values()) {
      if (room.host && !known.has(room.host.id)) delist(room);
      if (room.allow) for (const uid of room.allow) if (!known.has(uid)) room.allow.delete(uid);
    }
  }

  /** Le relais cesse de lister ; `revoke` : et retire tout ce qu'il avait accordé. */
  function disable(reason, revoke) {
    const was = friends.ready;
    friends.ready = false;
    friends.reason = reason;
    if (revoke) revokeAll();
    friends.retryMs = friends.retryMs ? Math.min(PROBE_RETRY_MAX_MS, friends.retryMs * 2) : PROBE_RETRY_MS;
    friends.retryAt = now() + friends.retryMs;
    if (reason === 'open' && (was || revoke)) console.warn('Séances visibles désactivées : ce Plex accepte un jeton inventé (adresses autorisées sans authentification ?).');
  }

  /**
   * Relit auprès de plex.tv le propriétaire, les partages du serveur et les amis du propriétaire
   * (pour leurs noms). Une seule lecture à la fois. Contre-épreuve : le jeton d'un partage ne doit
   * pas passer pour celui de l'administrateur ; sinon ce Plex ne réserve pas /status/sessions à son
   * propriétaire, et le relais renonce à le reconnaître (ses amis, eux, restent reconnus).
   */
  function loadDirectory() {
    directory.loading ??= (async () => {
      directory.triedAt = now();
      try {
        const [owner, shares, users] = await Promise.all([account.me(), account.shares(friends.server), account.users()]);
        const names = new Map(users.map((u) => [u.id, u]));
        const byHash = new Map();
        for (const sh of shares) {
          if (sh.id === owner.id) continue;
          const u = names.get(sh.id);
          byHash.set(sha(sh.token), { id: sh.id, name: u?.name ?? 'Plex', thumb: u?.thumb });
        }
        const canary = shares.find((sh) => sh.id !== owner.id)?.token;
        directory.ownerCheck = canary ? !(await verifier.admin(canary)) : true;
        if (!directory.ownerCheck) console.warn('Propriétaire non reconnu : ce Plex laisse un ami lire /status/sessions.');
        directory.owner = owner;
        directory.byHash = byHash;
        directory.known = new Set([owner.id, ...[...byHash.values()].map((u) => u.id)]);
        directory.loadedAt = now();
        revalidate();
        return true;
      } finally {
        directory.loading = null;
      }
    })();
    return directory.loading;
  }

  /**
   * Vérifie le Plex du relais (contre-épreuve comprise) puis relit les partages. Une seule à la
   * fois. En cas d'échec, le prochain essai attend (1 minute, puis le double, 30 au plus) : ni le
   * balayage ni une demande anonyme ne le relancent avant.
   */
  async function probeOnce() {
    friends.probedAt = now();
    try {
      const p = await verifier.probe();
      friends.server = p.server;
      if (p.open) return disable('open', true);
    } catch (e) {
      disable('unreachable', false);
      console.warn(`Séances visibles indisponibles : ${e.message}`);
      return;
    }
    try {
      await loadDirectory();
      friends.ready = true;
      friends.reason = 'ok';
      friends.retryMs = 0;
      friends.retryAt = -Infinity;
    } catch (e) {
      // Partages illisibles : le relais ne sait plus qui est qui, il ne liste plus rien.
      directory.byHash = new Map();
      directory.known = new Set();
      directory.owner = null;
      disable('plextv', true);
      console.warn(`Séances visibles indisponibles : ${e.message}`);
    }
  }
  let probing = Promise.resolve();
  let probeRunning = false;
  function probe() {
    if (!verifier || probeRunning) return probing;
    probeRunning = true;
    probing = probeOnce().finally(() => (probeRunning = false));
    return probing;
  }
  /** Un nouvel essai est-il permis maintenant ? (rythme normal, ou délai après un échec) */
  const probeDue = () => (friends.ready ? now() - friends.probedAt >= PROBE_EVERY_MS : now() >= friends.retryAt);
  probe();

  /** Jeton tiré au hasard : celui que Plex doit refuser (contre-épreuve). */
  const randomToken = () => randomBytes(15).toString('base64url');

  /**
   * Compte derrière un jeton accepté par Plex : un ami (partage), le propriétaire, ou null. Le
   * propriétaire n'est reconnu que si, au même moment, un jeton tiré au hasard est refusé par
   * /status/sessions : un Plex qui laisse tout le monde le lire (adresses autorisées sans
   * authentification, ajoutées après le démarrage) ferait sinon d'un jeton inventé le propriétaire.
   */
  async function identify(token) {
    const h = sha(token);
    const known = directory.byHash.get(h);
    if (known) return known;
    if (directory.owner && directory.ownerCheck && (await verifier.admin(token))) {
      if (await verifier.admin(randomToken())) {
        disable('open', true);
        throw new Error('open');
      }
      return directory.owner;
    }
    // Un partage tout neuf : plex.tv relu, au plus une fois par minute.
    if (now() - directory.triedAt >= DIRECTORY_MIN_MS) {
      await loadDirectory().catch(() => {});
      return directory.byHash.get(h) ?? null;
    }
    return null;
  }

  /**
   * { user } : accès au serveur (`user` : le compte vérifié, ou null si plex.tv ne le nomme pas) ;
   * false : refusé ; null : vérification impossible ; 'limited'.
   */
  async function authorize(token, ip) {
    if (typeof token !== 'string' || !token || token.length > 512) return false;
    const h = sha(token);
    const v = verdicts.get(h);
    if (v && v.until > now()) return v.ok && { user: v.user };
    // La part de l'adresse d'abord : la réserve commune n'est entamée que si elle passe.
    if (!plexIp.take(ip)) return 'limited';
    if (!plexLimit.take()) return 'limited';
    let ok;
    let user = null;
    try {
      ok = await verifier.check(token);
      if (ok) {
        // Contre-épreuve au moment même : si Plex accepte aussi un jeton inventé, il n'authentifie
        // plus personne (adresses autorisées sans authentification) ; le relais retire tout.
        if (await verifier.check(randomToken())) {
          disable('open', true);
          return null;
        }
        user = await identify(token);
      }
    } catch {
      return null;
    }
    if (!friends.ready) return null;
    verdicts.delete(h);
    verdicts.set(h, { ok, user, until: now() + (!ok ? VERDICT_KO_MS : user ? VERDICT_OK_MS : VERDICT_UNNAMED_MS) });
    if (verdicts.size > MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value);
    return ok && { user };
  }

  /** Ticket d'entrée, au nom du compte vérifié `user` (null : il ne peut ni annoncer ni entrer). */
  function newTicket(user) {
    const t = randomBytes(18).toString('base64url');
    tickets.set(t, { until: now() + TICKET_TTL_MS, used: new Set(), user });
    if (tickets.size > MAX_TICKETS) tickets.delete(tickets.keys().next().value);
    return t;
  }
  /** Ticket valable (et pas encore servi pour cette salle, quand `room` est donnée). */
  const validTicket = (t, room) => {
    const e = typeof t === 'string' ? tickets.get(t) : undefined;
    return !!e && e.until > now() && (room === undefined || !e.used.has(room));
  };

  /**
   * Séances listées pour le compte `user` : seulement celles qu'un hôte vérifié a annoncées (jamais
   * une salle privée) ET dont il a mis `user` dans sa liste d'amis. Personne d'autre ne les voit,
   * ni l'hôte lui-même (il y est déjà). Pour tous les autres, la liste est vide, comme s'il n'y
   * avait aucune séance.
   */
  const canSee = (r, user) => friends.ready && !!r.card && !!user && !!r.allow?.has(user.id) && r.host?.id !== user.id;
  const listed = (user) =>
    [...rooms]
      .filter(([, r]) => canSee(r, user))
      .sort((a, b) => b[1].cardAt - a[1].cardAt)
      .map(([room, r]) => ({ room, card: r.card, count: r.peers.size, age: Math.max(0, now() - r.cardAt) }));

  const readBody = (req, max) =>
    new Promise((resolve) => {
      let size = 0;
      const parts = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > max) {
          resolve(null);
          req.destroy();
        } else parts.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      req.on('error', () => resolve(null));
    });

  const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  const json = (res, status, body, extra = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...cors, ...extra });
    res.end(JSON.stringify(body));
  };

  async function friendsRequest(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
      return res.end();
    }
    if (!verifier) return json(res, 404, { multiplex: 'relay', friends: false });
    if (req.method !== 'POST') return json(res, 405, { multiplex: 'relay', error: 'method' });
    const ip = clientIp(req);
    if (!ipLimit.take(ip)) return json(res, 429, { multiplex: 'relay', error: 'slow down' }, { 'retry-after': '60' });
    const body = await readBody(req, MAX_CONTROL);
    let token;
    try {
      token = JSON.parse(body ?? '').token;
    } catch {
      token = undefined;
    }
    // Relais pas prêt : un nouvel essai seulement quand le délai après le dernier échec est passé.
    if (!friends.ready && probeDue()) await probe();
    if (!friends.ready) return json(res, 503, { multiplex: 'relay', error: 'unavailable' });
    const ok = await authorize(token, ip);
    if (ok === 'limited') return json(res, 429, { multiplex: 'relay', error: 'slow down' }, { 'retry-after': '10' });
    if (ok === null) return json(res, 503, { multiplex: 'relay', error: 'unavailable' });
    if (!ok) return json(res, 403, { multiplex: 'relay', error: 'forbidden' });
    return json(res, 200, { multiplex: 'relay', server: friends.server, friendsOnly: true, ticket: newTicket(ok.user), ttl: TICKET_TTL_MS / 1000, sessions: listed(ok.user) });
  }

  const http = createServer((req, res) => {
    // Derrière un proxy, le relais peut être servi sous un chemin (/multiplex-relay/health…) :
    // seule la fin de l'adresse compte.
    const [path, query = ''] = (req.url ?? '').split('?');
    if (/(^|\/)health$/.test(path)) {
      // Lisible depuis l'application (bouton « Tester » des réglages).
      res.writeHead(200, { 'content-type': 'text/plain', ...cors });
      res.end('ok');
      return;
    }
    if (/(^|\/)friends$/.test(path)) {
      friendsRequest(req, res).catch(() => {
        if (!res.headersSent) json(res, 500, { multiplex: 'relay', error: 'internal' });
      });
      return;
    }
    if (/(^|\/)rooms$/.test(path)) {
      const ids = [...new Set((new URLSearchParams(query).get('ids') ?? '').split(',').filter((id) => ROOM.test(id)))].slice(0, MAX_LOOKUP);
      if (ids.length && !ipLimit.take(clientIp(req), ids.length)) {
        res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60', ...cors });
        res.end('slow down');
        return;
      }
      const found = ids.filter((id) => rooms.has(id));
      const misses = ids.length - found.length;
      if (misses && !missLimit.take(misses)) {
        res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '10', ...cors });
        res.end('slow down');
        return;
      }
      // `server` (identifiant du Plex du relais, public comme son /identity) : l'application le
      // compare à celui du serveur AVANT de présenter le moindre jeton. `friendsOnly` : ce relais
      // ne liste une séance qu'aux amis Plex de son hôte (un relais plus ancien la listait à tout
      // utilisateur du serveur, et l'application n'y annonce plus rien).
      json(res, 200, friends.ready ? { multiplex: 'relay', found, friends: true, friendsOnly: true, server: friends.server } : { multiplex: 'relay', found, friends: false });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('MultiPlex relay');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
  sockets = () => wss.clients;

  const refuse = (socket, status) => {
    socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
    socket.destroy();
  };

  http.on('upgrade', (req, socket, head) => {
    let id;
    try {
      id = /\/r\/([A-Za-z0-9_-]{16,64})$/.exec(new URL(req.url ?? '', 'http://relay').pathname)?.[1];
    } catch {
      id = undefined;
    }
    if (!id) return refuse(socket, '403 Forbidden');
    if (!ipLimit.take(clientIp(req))) return refuse(socket, '429 Too Many Requests');
    const room = rooms.get(id);
    if ((room && room.peers.size >= maxPeers) || (!room && rooms.size >= maxRooms)) return refuse(socket, '403 Forbidden');
    wss.handleUpgrade(req, socket, head, (ws) => join(id, ws));
  });

  const reply = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const live = (ws) => !!ws && ws.readyState === ws.OPEN;

  /**
   * Une salle listée a UN hôte : le compte plex.tv qui l'annonce le premier (`hostId`, vérifié par
   * son ticket, jamais déclaré), avec l'empreinte de sa preuve d'hôte. Seul ce compte peut ensuite
   * l'annoncer, depuis n'importe laquelle de ses connexions (la plus récente devient `owner`, qui
   * reçoit les demandes de clé) : jamais un autre membre, même avec la preuve. Chaque annonce peut
   * porter sa liste d'amis (`friends`, numéros de compte plex.tv), que le relais remplace à chaque
   * fois et réduit aux comptes qu'il connaît : un ami retiré perd la séance à l'annonce suivante.
   * La première annonce d'une connexion doit la porter.
   * L'hôte la retire (« unlist » : elle devient privée) ou libère l'annonce (« release »). S'il se
   * déconnecte, la fiche disparaît et la séance n'est plus listée (ses membres continuent, et les
   * invitations par code marchent toujours) jusqu'à ce que ce même compte la réannonce.
   */
  function control(room, id, ws, data) {
    if (data.length > MAX_CONTROL) return;
    let m;
    try {
      m = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    const owner = live(room.owner) ? room.owner : null;
    const isHost = () => !!ws.user && !!room.hostId && ws.user.id === room.hostId;
    if (m.t === 'announce') {
      if (!friends.ready) return reply(ws, { t: 'error', error: 'unavailable' });
      if (!ws.authorized) {
        if (!validTicket(m.ticket)) return reply(ws, { t: 'error', error: 'ticket' });
        const ticket = tickets.get(m.ticket);
        // Un jeton accepté par Plex mais que plex.tv ne nomme pas : pas d'annonce possible.
        if (!ticket.user) return reply(ws, { t: 'error', error: 'unavailable' });
        ticket.used.add(id);
        ws.authorized = true;
        ws.user = ticket.user;
      }
      if (typeof m.proof !== 'string' || !PROOF.test(m.proof)) return reply(ws, { t: 'error', error: 'proof' });
      if ((room.proof && room.proof !== sha(m.proof)) || (room.hostId && !isHost())) return reply(ws, { t: 'error', error: 'owner' });
      const allow = m.friends === undefined ? undefined : allowList(m.friends);
      if (allow === null) return reply(ws, { t: 'error', error: 'friends' });
      // Sans liste d'amis, pas d'annonce (une application plus ancienne n'en envoie pas).
      if (!allow && (owner !== ws || !room.allow)) return reply(ws, { t: 'error', error: 'unavailable' });
      const card = sanitizeCard(m.card, ws.user.name);
      if (!card) return reply(ws, { t: 'error', error: 'card' });
      room.proof ??= sha(m.proof);
      room.hostId ??= ws.user.id;
      room.owner = ws;
      room.private = false;
      room.host = ws.user;
      if (allow) {
        // Seulement les comptes que le relais connaît (partages et propriétaire) : le reste du
        // cercle d'amis de l'hôte ne le regarde pas, et n'est pas gardé.
        for (const uid of allow) if (!directory.known.has(uid) || uid === ws.user.id) allow.delete(uid);
        room.allow = allow;
      }
      room.card = card;
      room.cardAt = now();
      return reply(ws, { t: 'announced' });
    }
    if (m.t === 'unlist' || m.t === 'release') {
      if (owner !== ws && !(ws.authorized && isHost())) return;
      delist(room);
      if (m.t === 'unlist') room.private = true;
      room.owner = null;
      return;
    }
    if (m.t === 'key-request') {
      // Un ami entré sans invitation : ticket dans ce message (jamais dans l'adresse), valable pour
      // une seule entrée dans cette salle, et seulement vers l'hôte d'une séance listée.
      // Et seulement pour un ami de l'hôte : pour tout autre, même réponse qu'un ticket invalide.
      if (!friends.ready) return reply(ws, { t: 'error', error: 'unavailable' });
      if (!room.card || ws.asked || typeof m.pub !== 'string' || !KEY.test(m.pub)) return;
      if (!validTicket(m.ticket, id) || !canSee(room, tickets.get(m.ticket).user)) return reply(ws, { t: 'error', error: 'ticket' });
      if (!owner) return reply(ws, { t: 'error', error: 'nohost' });
      if (!room.keyRequests.take()) return reply(ws, { t: 'error', error: 'busy' });
      tickets.get(m.ticket).used.add(id);
      ws.asked = true;
      ws.friend = true;
      return reply(owner, { t: 'key-request', peer: ws.sid, pub: m.pub });
    }
    if (m.t === 'key-grant') {
      if (owner !== ws || typeof m.peer !== 'string' || typeof m.pub !== 'string' || !KEY.test(m.pub) || typeof m.box !== 'string' || !BOX.test(m.box)) return;
      for (const peer of room.peers) if (peer.sid === m.peer && peer.friend) reply(peer, { t: 'key-grant', pub: m.pub, box: m.box });
    }
  }

  function join(id, ws) {
    let room = rooms.get(id);
    if (!room) {
      const keyRequests = bucket(KEY_REQUESTS.burst, KEY_REQUESTS.perSecond, now);
      rooms.set(id, (room = { peers: new Set(), created: now(), card: null, cardAt: 0, owner: null, proof: null, private: false, keyRequests, host: null, hostId: null, allow: null }));
    }
    const peers = room.peers;
    peers.add(ws);
    ws.alive = true;
    ws.sent = [];
    ws.ctl = [];
    ws.sid = randomBytes(9).toString('base64url');
    ws.friend = false;
    ws.asked = false;
    ws.authorized = false;
    ws.user = null;
    ws.on('pong', () => (ws.alive = true));
    ws.on('message', (data, binary) => {
      const t = Date.now();
      // Deux budgets : les messages de la séance (chiffrés) et ceux adressés au relais.
      const [list, rate] = binary ? ['sent', RATE] : ['ctl', CONTROL_RATE];
      ws[list] = ws[list].filter((s) => t - s < rate.windowMs);
      if (ws[list].length >= rate.count) return;
      ws[list].push(t);
      if (!binary) return control(room, id, ws, data);
      for (const peer of peers) if (peer !== ws && peer.readyState === peer.OPEN) peer.send(data, { binary });
    });
    ws.on('close', () => {
      peers.delete(ws);
      if (room.owner === ws) {
        // L'hôte est parti : la séance n'est plus listée, jusqu'à ce que son compte la réannonce.
        room.owner = null;
        delist(room);
      }
      if (!peers.size && rooms.get(id) === room) rooms.delete(id);
    });
    ws.on('error', () => ws.terminate());
  }

  /** Salles trop vieilles fermées, seaux pleins, tickets et verdicts périmés oubliés. */
  function sweep() {
    const t = now();
    for (const [id, room] of rooms) {
      if (t - room.created < ttlMs) continue;
      rooms.delete(id);
      for (const ws of room.peers) ws.close(4000, 'expired');
    }
    ipLimit.sweep();
    plexIp.sweep();
    for (const [k, e] of tickets) if (e.until <= t) tickets.delete(k);
    for (const [k, v] of verdicts) if (v.until <= t) verdicts.delete(k);
    if (verifier && probeDue()) void probe();
  }

  // Connexions mortes (téléphone en veille, réseau coupé) : on les ferme au bout de 30 secondes.
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
    sweep();
  }, 30_000);
  timer.unref();

  return {
    http,
    rooms,
    sweep,
    friends,
    directory,
    /** Résolue une fois la dernière vérification du serveur Plex faite. */
    get probing() {
      return probing;
    },
    close() {
      clearInterval(timer);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => http.close(() => resolve()));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const PORT = Number(process.env.PORT) || 8787;
  const relay = createRelay();
  relay.http.listen(PORT, () => console.log(`Relais MultiPlex à l'écoute sur le port ${PORT}`));
  void relay.probing.then(() => {
    if (relay.friends.ready) console.log(`Séances visibles par les amis Plex de leur hôte : serveur Plex ${relay.friends.server}, ${relay.directory.byHash.size} partage(s) connu(s)`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}
