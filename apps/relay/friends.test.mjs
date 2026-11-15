// Tests du relais : séances visibles par les amis. Un faux serveur Plex répond comme un vrai sur les
// deux adresses dont le relais se sert : /identity (sans jeton) et /library/sections (200 avec un
// jeton qu'il connaît, 401 sinon).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createRelay, sanitizeCard } from './server.mjs';

const ROOM = 'FFFFFFFFFFFFFFFFFFFFFF';
const PRIVATE_ROOM = 'PPPPPPPPPPPPPPPPPPPPPP';
const SERVER_ID = 'mock-machine-identifier-0001';
const FRIEND = 'friend-server-token';
const HOST = 'host-server-token';

/** Faux Plex : `open` = laisse tout passer (adresses autorisées sans authentification). */
function mockPlex({ open = false } = {}) {
  const calls = [];
  const srv = createServer((req, res) => {
    const token = req.headers['x-plex-token'];
    calls.push({ path: req.url, token });
    if (req.url === '/identity') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ MediaContainer: { size: 0, claimed: true, machineIdentifier: SERVER_ID, version: '1.43.4' } }));
    }
    if (req.url === '/library/sections') {
      if (open || token === FRIEND || token === HOST) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ MediaContainer: { size: 1, Directory: [{ key: '1', title: 'Films' }] } }));
      }
      res.writeHead(401, { 'content-type': 'text/html' });
      return res.end('<html><head><title>Unauthorized</title></head><body><h1>401 Unauthorized</h1></body></html>');
    }
    res.writeHead(404);
    res.end();
  });
  return {
    calls,
    listen: () => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`))),
    close: () => new Promise((r) => srv.close(() => r())),
  };
}

async function startRelay(plexUrl, extra = {}) {
  const relay = createRelay({ plexUrl, ipBurst: 200, ipPerSecond: 10, ...extra });
  await relay.probing;
  await new Promise((r) => relay.http.listen(0, '127.0.0.1', r));
  return { relay, base: `127.0.0.1:${relay.http.address().port}` };
}

const list = (base, token, ip = '198.51.100.40') =>
  fetch(`http://${base}/multiplex-relay/friends`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-forwarded-for': ip }, body: JSON.stringify({ token }) });

/** Ouvre une salle ; messages texte reçus rangés dans `inbox`, binaires dans `bin`. */
const open = (base, room, query = '') =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/multiplex-relay/r/${room}${query}`, { headers: { 'x-forwarded-for': '198.51.100.41' } });
    ws.inbox = [];
    ws.bin = [];
    ws.on('message', (data, binary) => (binary ? ws.bin : ws.inbox).push(binary ? Buffer.from(data) : JSON.parse(String(data))));
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
    ws.once('error', reject);
  });

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const PUB = 'B'.repeat(87);

let plex;
let plexUrl;
let relay;
let base;
before(async () => {
  plex = mockPlex();
  plexUrl = await plex.listen();
  ({ relay, base } = await startRelay(plexUrl));
});
after(async () => {
  await relay.close();
  await plex.close();
});

test('sans PLEX_URL : aucune liste, et le relais le dit (invitations inchangées)', async () => {
  const { relay: r, base: b } = await startRelay('');
  const res = await list(b, FRIEND);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { multiplex: 'relay', friends: false });
  assert.deepEqual(await (await fetch(`http://${b}/rooms?ids=`)).json(), { multiplex: 'relay', found: [], friends: false });
  await r.close();
});

test('le relais vérifie son Plex au démarrage', async () => {
  assert.equal(relay.friends.ready, true);
  assert.equal(relay.friends.server, SERVER_ID);
  assert.deepEqual(await (await fetch(`http://${base}/rooms?ids=`)).json(), { multiplex: 'relay', found: [], friends: true });
});

test('séances : listées aux seuls utilisateurs du serveur ; une séance privée jamais', async () => {
  // Une séance privée (ouverte par invitation, jamais annoncée) et une séance visible.
  const priv = await open(base, PRIVATE_ROOM);
  const host = await open(base, ROOM);
  const t = await (await list(base, HOST)).json();
  host.send(JSON.stringify({ t: 'announce', ticket: t.ticket, card: { name: 'Camille', title: 'Le Grand Voyage', sub: '1987', type: 'movie', guid: 'plex://movie/abc', key: '42', time: 125.5, playing: true, device: 'Salon', address: '192.168.1.20', stream: 'direct' } }));
  await until(() => host.inbox.some((m) => m.t === 'announced'));

  // Utilisateur du serveur : la séance visible, et seulement les champs utiles.
  const ok = await list(base, FRIEND);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  const a = await ok.json();
  assert.equal(a.server, SERVER_ID);
  assert.match(a.ticket, /^[A-Za-z0-9_-]{24}$/);
  assert.deepEqual(
    a.sessions.map((s) => s.room),
    [ROOM],
  );
  assert.deepEqual(a.sessions[0].card, { name: 'Camille', title: 'Le Grand Voyage', sub: '1987', type: 'movie', guid: 'plex://movie/abc', key: '42', time: 125.5, playing: true });
  assert.equal(a.sessions[0].count, 1);

  // Personne d'autre : ni jeton inventé, ni jeton d'un autre serveur, ni rien.
  for (const token of ['jeton-invente', 'other-server-token', '', undefined, 'x'.repeat(600)]) {
    const r = await list(base, token);
    assert.equal(r.status, 403, String(token));
    const body = await r.json();
    assert.deepEqual(body, { multiplex: 'relay', error: 'forbidden' });
  }
  // Pas par un GET non plus.
  assert.equal((await fetch(`http://${base}/friends`)).status, 405);

  // L'hôte retire sa séance : plus listée ; il part : plus rien.
  host.send(JSON.stringify({ t: 'unlist' }));
  await until(() => !relay.rooms.get(ROOM).card);
  assert.deepEqual((await (await list(base, FRIEND)).json()).sessions, []);
  priv.close();
  host.close();
});

test('annonce sans ticket valable : refusée, la séance reste privée', async () => {
  const host = await open(base, ROOM);
  host.send(JSON.stringify({ t: 'announce', ticket: 'invente', card: { name: 'X', title: 'Y', time: 1, playing: true } }));
  host.send(JSON.stringify({ t: 'announce', card: { name: 'X', title: 'Y', time: 1, playing: true } }));
  await until(() => host.inbox.length === 2);
  assert.deepEqual(host.inbox, [
    { t: 'error', error: 'ticket' },
    { t: 'error', error: 'ticket' },
  ]);
  assert.deepEqual((await (await list(base, FRIEND)).json()).sessions, []);
  host.close();
});

test('entrée d’un ami : ticket exigé, séance listée seulement ; la clé ne passe que de l’hôte à lui', async () => {
  const host = await open(base, ROOM);
  const guest = await open(base, ROOM); // invité par code, déjà là
  const { ticket } = await (await list(base, HOST)).json();
  host.send(JSON.stringify({ t: 'announce', ticket, card: { name: 'Camille', title: 'Film', time: 10, playing: false } }));
  await until(() => host.inbox.some((m) => m.t === 'announced'));
  const { ticket: friendTicket } = await (await list(base, FRIEND)).json();

  await assert.rejects(open(base, ROOM, '?ticket=invente'), /403/);
  await assert.rejects(open(base, PRIVATE_ROOM, `?ticket=${friendTicket}`), /403/);
  const friend = await open(base, ROOM, `?ticket=${friendTicket}`);

  // Demande de clé : seulement vers l'hôte, avec un numéro de demandeur donné par le relais.
  friend.send(JSON.stringify({ t: 'key-request', pub: PUB }));
  await until(() => host.inbox.some((m) => m.t === 'key-request'));
  const req = host.inbox.find((m) => m.t === 'key-request');
  assert.equal(req.pub, PUB);
  assert.match(req.peer, /^[A-Za-z0-9_-]{12}$/);
  // Un invité par code ne peut pas demander la clé par ce chemin (il l'a déjà).
  guest.send(JSON.stringify({ t: 'key-request', pub: PUB }));
  // Seul l'hôte remet une clé, et seulement au demandeur.
  guest.send(JSON.stringify({ t: 'key-grant', peer: req.peer, pub: PUB, box: 'C'.repeat(60) }));
  host.send(JSON.stringify({ t: 'key-grant', peer: req.peer, pub: PUB, box: 'D'.repeat(60) }));
  await until(() => friend.inbox.some((m) => m.t === 'key-grant'));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    friend.inbox.filter((m) => m.t === 'key-grant'),
    [{ t: 'key-grant', pub: PUB, box: 'D'.repeat(60) }],
  );
  assert.equal(host.inbox.filter((m) => m.t === 'key-request').length, 1);
  assert.deepEqual(guest.inbox, []);

  // Les messages chiffrés suivent comme avant ; les messages texte ne sont jamais renvoyés.
  guest.send(Buffer.from([1, 2, 3]));
  await until(() => host.bin.length === 1 && friend.bin.length === 1);
  assert.deepEqual([...host.bin[0]], [1, 2, 3]);
  for (const ws of [host, guest, friend]) ws.close();
});

test('Plex qui laisse tout passer : le relais ne peut rien vérifier et ne liste rien', async () => {
  const lax = mockPlex({ open: true });
  const url = await lax.listen();
  const { relay: r, base: b } = await startRelay(url);
  assert.equal(r.friends.ready, false);
  assert.equal(r.friends.reason, 'open');
  assert.equal((await list(b, FRIEND)).status, 503);
  assert.equal((await (await fetch(`http://${b}/rooms?ids=`)).json()).friends, false);
  await r.close();
  await lax.close();
});

test('verdicts gardés quelques minutes ; vérifications auprès de Plex bornées pour tout le monde', async () => {
  const p = mockPlex();
  const url = await p.listen();
  const { relay: r, base: b } = await startRelay(url, { plexBurst: 3, plexPerSecond: 0.001 });
  const before = p.calls.filter((c) => c.path === '/library/sections').length; // contre-épreuve
  for (let i = 0; i < 5; i++) assert.equal((await list(b, FRIEND)).status, 200);
  assert.equal(p.calls.filter((c) => c.path === '/library/sections').length - before, 1);
  // Jetons inventés en rafale : au-delà de la réserve, 429 sans même demander à Plex.
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await list(b, `faux-${i}`)).status);
  assert.deepEqual(statuses, [403, 403, 429, 429]);
  await r.close();
  await p.close();
});

test('chaque demande de liste coûte un jeton à l’adresse', async () => {
  const p = mockPlex();
  const url = await p.listen();
  const { relay: r, base: b } = await startRelay(url, { ipBurst: 2, ipPerSecond: 0.001 });
  assert.equal((await list(b, FRIEND, '203.0.113.50')).status, 200);
  assert.equal((await list(b, FRIEND, '203.0.113.50')).status, 200);
  assert.equal((await list(b, FRIEND, '203.0.113.50')).status, 429);
  assert.equal((await list(b, FRIEND, '203.0.113.51')).status, 200);
  await r.close();
  await p.close();
});

test('fiche annoncée : champs connus seulement, bornés', () => {
  assert.equal(sanitizeCard({ title: 'sans nom' }), null);
  assert.equal(sanitizeCard('texte'), null);
  const c = sanitizeCard({ name: ' A ', title: 'T'.repeat(500), time: -5, playing: 'oui', device: 'TV', ip: '10.0.0.1' });
  assert.deepEqual(Object.keys(c).sort(), ['name', 'playing', 'time', 'title']);
  assert.equal(c.name, 'A');
  assert.equal(c.title.length, 200);
  assert.equal(c.time, 0);
  assert.equal(c.playing, false);
});
