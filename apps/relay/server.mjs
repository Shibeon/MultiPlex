// Relais « Regarder ensemble » de MultiPlex.
//
// Un relais volontairement bête : il fait suivre chaque message d'une salle aux autres membres
// de la même salle, sans rien lire. Les applications chiffrent tout de bout en bout (la clé est
// dans l'invitation, jamais envoyée ici) : le relais ne voit ni titre, ni pseudo, ni position.
//
//   GET  /health        → « ok » (sonde de Docker ou du proxy)
//   WS   /r/<salle>     → la salle ; jusqu'à 16 membres, messages de 16 Ko au plus
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const MAX_PEERS = Number(process.env.MAX_PEERS) || 16;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
const MAX_MESSAGE = 16 * 1024;
// Au plus 40 messages par tranche de 10 secondes et par membre : largement assez pour la synchro.
const RATE = { count: 40, windowMs: 10_000 };

const rooms = new Map(); // salle → Set<WebSocket>

const http = createServer((req, res) => {
  // Derrière un proxy, le relais peut être servi sous un chemin (/multiplex-relay/health…) :
  // seule la fin de l'adresse compte.
  if (/(^|\/)health$/.test((req.url ?? '').split('?')[0])) {
    // Lisible depuis l'application (bouton « Tester » des réglages).
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end('ok');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('MultiPlex relay');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });

http.on('upgrade', (req, socket, head) => {
  let id;
  try {
    id = /\/r\/([A-Za-z0-9_-]{16,64})$/.exec(new URL(req.url ?? '', 'http://relay').pathname)?.[1];
  } catch {
    id = undefined;
  }
  const room = id ? rooms.get(id) : undefined;
  if (!id || (room && room.size >= MAX_PEERS) || (!room && rooms.size >= MAX_ROOMS)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => join(id, ws));
});

function join(id, ws) {
  const room = rooms.get(id) ?? new Set();
  rooms.set(id, room);
  room.add(ws);
  ws.alive = true;
  ws.sent = [];
  ws.on('pong', () => (ws.alive = true));
  ws.on('message', (data, binary) => {
    const now = Date.now();
    ws.sent = ws.sent.filter((t) => now - t < RATE.windowMs);
    if (ws.sent.length >= RATE.count) return;
    ws.sent.push(now);
    for (const peer of room) if (peer !== ws && peer.readyState === peer.OPEN) peer.send(data, { binary });
  });
  ws.on('close', () => {
    room.delete(ws);
    if (!room.size) rooms.delete(id);
  });
  ws.on('error', () => ws.terminate());
}

// Connexions mortes (téléphone en veille, réseau coupé) : on les ferme au bout de 30 secondes.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 30_000).unref();

http.listen(PORT, () => console.log(`Relais MultiPlex à l'écoute sur le port ${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
