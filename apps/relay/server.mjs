// Relais « Regarder ensemble » de MultiPlex.
//
// Un relais volontairement bête : il fait suivre chaque message d'une salle aux autres membres
// de la même salle, sans rien lire. Les applications chiffrent tout de bout en bout (la clé vient
// de l'invitation, jamais envoyée ici) : le relais ne voit ni titre, ni pseudo, ni position.
//
//   GET  /health            → « ok » (sonde de Docker ou du proxy)
//   GET  /rooms?ids=a,b,…   → {"multiplex":"relay","found":[…]} : les salles qui existent parmi
//                             celles demandées (16 au plus). C'est ainsi que l'application d'un
//                             invité reconnaît un relais MultiPlex et trouve la séance.
//   WS   /r/<salle>         → la salle ; jusqu'à 16 membres, messages de 16 Ko au plus
//
// Les invitations sont courtes (8 signes) : chaque salle demandée, et chaque entrée dans une
// salle, coûte un jeton à l'adresse IP (30 par minute, 60 d'avance), et les salles demandées qui
// n'existent pas coûtent aussi un jeton à un compteur commun (10 par seconde), pour borner les
// essais au hasard même depuis beaucoup d'adresses. Une salle ferme au bout de ROOM_TTL_HOURS.
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const MAX_MESSAGE = 16 * 1024;
const MAX_LOOKUP = 16;
// Au plus 40 messages par tranche de 10 secondes et par membre : largement assez pour la synchro.
const RATE = { count: 40, windowMs: 10_000 };

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

/** Seaux par adresse IP, oubliés une fois pleins (pour ne pas grossir sans fin). */
export function perIp(burst, perSecond, now = Date.now) {
  const map = new Map();
  return {
    take(ip, n = 1) {
      let b = map.get(ip);
      if (!b) map.set(ip, (b = bucket(burst, perSecond, now)));
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

export function createRelay(opts = {}) {
  const env = process.env;
  const maxPeers = opts.maxPeers ?? (Number(env.MAX_PEERS) || 16);
  const maxRooms = opts.maxRooms ?? (Number(env.MAX_ROOMS) || 500);
  const ttlMs = opts.ttlMs ?? (Number(env.ROOM_TTL_HOURS) || 12) * 3600_000;
  const now = opts.now ?? Date.now;
  const ipLimit = perIp(opts.ipBurst ?? 60, opts.ipPerSecond ?? 0.5, now);
  const missLimit = bucket(opts.missBurst ?? 600, opts.missPerSecond ?? 10, now);

  const rooms = new Map(); // salle → { peers: Set<WebSocket>, created }

  const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
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
      res.writeHead(200, { 'content-type': 'application/json', ...cors });
      res.end(JSON.stringify({ multiplex: 'relay', found }));
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

  function join(id, ws) {
    let room = rooms.get(id);
    if (!room) rooms.set(id, (room = { peers: new Set(), created: now() }));
    const peers = room.peers;
    peers.add(ws);
    ws.alive = true;
    ws.sent = [];
    ws.on('pong', () => (ws.alive = true));
    ws.on('message', (data, binary) => {
      const t = Date.now();
      ws.sent = ws.sent.filter((s) => t - s < RATE.windowMs);
      if (ws.sent.length >= RATE.count) return;
      ws.sent.push(t);
      for (const peer of peers) if (peer !== ws && peer.readyState === peer.OPEN) peer.send(data, { binary });
    });
    ws.on('close', () => {
      peers.delete(ws);
      if (!peers.size && rooms.get(id) === room) rooms.delete(id);
    });
    ws.on('error', () => ws.terminate());
  }

  /** Salles trop vieilles fermées, seaux pleins oubliés. */
  function sweep() {
    const t = now();
    for (const [id, room] of rooms) {
      if (t - room.created < ttlMs) continue;
      rooms.delete(id);
      for (const ws of room.peers) ws.close(4000, 'expired');
    }
    ipLimit.sweep();
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
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
}
