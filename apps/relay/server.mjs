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
//   POST /friends           → séances visibles par les amis (seulement avec PLEX_URL) : le corps
//                             {"token":"…"} porte le jeton propre au serveur Plex du relais ; le
//                             relais l'essaie auprès de ce Plex et ne liste qu'à qui y a accès
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
// Séances visibles par les amis.
const MAX_CONTROL = 4 * 1024;
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
  const check = async (token) => {
    const r = await ask('/library/sections', token);
    await r.arrayBuffer().catch(() => {});
    if (r.status === 200) return true;
    if (r.status === 401 || r.status === 403) return false;
    throw new Error(`Plex : ${r.status}`);
  };
  return {
    check,
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

/**
 * Fiche d'une séance visible, telle que l'hôte l'annonce : nom de l'hôte, titre, position. Tout le
 * reste (appareil, adresse, flux…) est écarté ; le nombre de participants est compté ici.
 */
export function sanitizeCard(c) {
  if (!c || typeof c !== 'object') return null;
  const name = str(c.name, 60);
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

  const rooms = new Map(); // salle → { peers, created, card, cardAt, owner, proof, private, keyRequests }

  // Séances visibles par les amis : seulement si le relais connaît son serveur Plex.
  const plexUrl = opts.plexUrl ?? env.PLEX_URL ?? '';
  const verifier = opts.verifier ?? (plexUrl ? plexVerifier(plexUrl) : null);
  const friends = { ready: false, server: '', reason: verifier ? 'pending' : 'off', probedAt: -Infinity };
  // Vérifications demandées à Plex (jetons pas encore connus) : bornées pour tout le monde.
  const plexLimit = bucket(opts.plexBurst ?? 30, opts.plexPerSecond ?? 2, now);
  // … et d'abord par adresse (IPv6 : par /64), pour qu'aucune ne vide la réserve commune.
  const plexIp = perIp(opts.plexIpBurst ?? 5, opts.plexIpPerSecond ?? 1 / 30, now);
  const verdicts = new Map(); // empreinte du jeton → { ok, until }
  const tickets = new Map(); // ticket → { until, used: salles où il a déjà servi }

  async function probe() {
    if (!verifier) return;
    friends.probedAt = now();
    try {
      const p = await verifier.probe();
      friends.server = p.server;
      friends.ready = !p.open;
      friends.reason = p.open ? 'open' : 'ok';
      if (p.open) console.warn('Séances visibles désactivées : ce Plex accepte un jeton inventé (adresses autorisées sans authentification ?).');
    } catch (e) {
      friends.ready = false;
      friends.reason = 'unreachable';
      console.warn(`Séances visibles indisponibles : ${e.message}`);
    }
  }
  const probing = probe();

  /** true : accès au serveur ; false : refusé ; null : vérification impossible ; 'limited'. */
  async function authorize(token, ip) {
    if (typeof token !== 'string' || !token || token.length > 512) return false;
    const h = sha(token);
    const v = verdicts.get(h);
    if (v && v.until > now()) return v.ok;
    // La part de l'adresse d'abord : la réserve commune n'est entamée que si elle passe.
    if (!plexIp.take(ip)) return 'limited';
    if (!plexLimit.take()) return 'limited';
    let ok;
    try {
      ok = await verifier.check(token);
    } catch {
      return null;
    }
    verdicts.delete(h);
    verdicts.set(h, { ok, until: now() + (ok ? VERDICT_OK_MS : VERDICT_KO_MS) });
    if (verdicts.size > MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value);
    return ok;
  }

  function newTicket() {
    const t = randomBytes(18).toString('base64url');
    tickets.set(t, { until: now() + TICKET_TTL_MS, used: new Set() });
    if (tickets.size > MAX_TICKETS) tickets.delete(tickets.keys().next().value);
    return t;
  }
  /** Ticket valable (et pas encore servi pour cette salle, quand `room` est donnée). */
  const validTicket = (t, room) => {
    const e = typeof t === 'string' ? tickets.get(t) : undefined;
    return !!e && e.until > now() && (room === undefined || !e.used.has(room));
  };

  /** Séances listées : seulement celles qu'un hôte autorisé a annoncées (jamais une salle privée). */
  const listed = () =>
    [...rooms]
      .filter(([, r]) => r.card)
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
    if (!friends.ready && now() - friends.probedAt > 30_000) await probe();
    if (!friends.ready) return json(res, 503, { multiplex: 'relay', error: 'unavailable' });
    const ok = await authorize(token, ip);
    if (ok === 'limited') return json(res, 429, { multiplex: 'relay', error: 'slow down' }, { 'retry-after': '10' });
    if (ok === null) return json(res, 503, { multiplex: 'relay', error: 'unavailable' });
    if (!ok) return json(res, 403, { multiplex: 'relay', error: 'forbidden' });
    return json(res, 200, { multiplex: 'relay', server: friends.server, ticket: newTicket(), ttl: TICKET_TTL_MS / 1000, sessions: listed() });
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
      // compare à celui du serveur AVANT de présenter le moindre jeton.
      json(res, 200, friends.ready ? { multiplex: 'relay', found, friends: true, server: friends.server } : { multiplex: 'relay', found, friends: false });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('MultiPlex relay');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });

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
   * Une salle listée a UN hôte : le premier qui l'annonce (`owner`, avec l'empreinte de sa preuve).
   * Lui seul la rafraîchit, la retire (« unlist » : elle devient privée, et personne d'autre ne
   * peut la relancer) ou la cède (« release » : passage de main, elle reste annonçable). S'il se
   * déconnecte, la fiche disparaît ; un membre qui a la même preuve (tirée du secret de la séance)
   * peut alors la reprendre, sauf si elle était devenue privée.
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
    if (m.t === 'announce') {
      if (!friends.ready) return reply(ws, { t: 'error', error: 'unavailable' });
      if (!ws.authorized) {
        if (!validTicket(m.ticket)) return reply(ws, { t: 'error', error: 'ticket' });
        tickets.get(m.ticket).used.add(id);
        ws.authorized = true;
      }
      if (typeof m.proof !== 'string' || !PROOF.test(m.proof)) return reply(ws, { t: 'error', error: 'proof' });
      if (room.private && owner !== ws) return reply(ws, { t: 'error', error: 'private' });
      if ((room.proof && room.proof !== sha(m.proof)) || (owner && owner !== ws)) return reply(ws, { t: 'error', error: 'owner' });
      const card = sanitizeCard(m.card);
      if (!card) return reply(ws, { t: 'error', error: 'card' });
      room.proof ??= sha(m.proof);
      room.owner = ws;
      room.private = false;
      room.card = card;
      room.cardAt = now();
      return reply(ws, { t: 'announced' });
    }
    if (m.t === 'unlist' || m.t === 'release') {
      if (owner !== ws) return;
      room.card = null;
      room.cardAt = 0;
      if (m.t === 'unlist') room.private = true;
      else room.owner = null;
      return;
    }
    if (m.t === 'key-request') {
      // Un ami entré sans invitation : ticket dans ce message (jamais dans l'adresse), valable pour
      // une seule entrée dans cette salle, et seulement vers l'hôte d'une séance listée.
      if (!room.card || ws.asked || typeof m.pub !== 'string' || !KEY.test(m.pub)) return;
      if (!validTicket(m.ticket, id)) return reply(ws, { t: 'error', error: 'ticket' });
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
      rooms.set(id, (room = { peers: new Set(), created: now(), card: null, cardAt: 0, owner: null, proof: null, private: false, keyRequests }));
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
        // L'hôte est parti : la fiche disparaît ; une séance devenue privée le reste.
        room.owner = null;
        room.card = null;
        room.cardAt = 0;
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
    if (verifier && t - friends.probedAt >= PROBE_EVERY_MS) void probe();
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
    /** Résolue une fois la première vérification du serveur Plex faite. */
    probing,
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
    if (relay.friends.ready) console.log(`Séances visibles par les amis : accès vérifié auprès du serveur Plex ${relay.friends.server}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}
