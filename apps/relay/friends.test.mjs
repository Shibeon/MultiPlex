// Tests du relais : séances visibles par les amis. Un faux serveur Plex répond comme un vrai sur les
// deux adresses dont le relais se sert : /identity (sans jeton) et /library/sections (200 avec un
// jeton qu'il connaît, 401 sinon).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createRelay, limitKey, sanitizeCard } from './server.mjs';

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
// Preuve d'hôte : tirée du secret de la séance (connue des seuls membres), jamais la clé.
const PROOF = 'O'.repeat(22);
const card = (name = 'Camille', title = 'Film') => ({ name, title, time: 10, playing: false });
const ticketFor = async (b, token, ip) => (await (await list(b, token, ip)).json()).ticket;
/** L'hôte annonce sa séance (ticket obtenu avec son jeton) et attend la réponse du relais. */
async function announce(ws, b, { proof = PROOF, c = card(), token = HOST } = {}) {
  const n = ws.inbox.length;
  ws.send(JSON.stringify({ t: 'announce', ticket: await ticketFor(b, token), proof, card: c }));
  await until(() => ws.inbox.length > n);
  return ws.inbox[ws.inbox.length - 1];
}

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
  // Identifiant du serveur (non secret, comme /identity) : comparé AVANT d'envoyer un jeton.
  assert.deepEqual(await (await fetch(`http://${base}/rooms?ids=`)).json(), { multiplex: 'relay', found: [], friends: true, server: SERVER_ID });
});

test('séances : listées aux seuls utilisateurs du serveur ; une séance privée jamais', async () => {
  // Une séance privée (ouverte par invitation, jamais annoncée) et une séance visible.
  const priv = await open(base, PRIVATE_ROOM);
  const host = await open(base, ROOM);
  const t = await (await list(base, HOST)).json();
  host.send(JSON.stringify({ t: 'announce', ticket: t.ticket, proof: PROOF, card: { name: 'Camille', title: 'Le Grand Voyage', sub: '1987', type: 'movie', guid: 'plex://movie/abc', key: '42', time: 125.5, playing: true, device: 'Salon', address: '192.168.1.20', stream: 'direct' } }));
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
  // Salle fermée avec son dernier membre (la suivante repart de zéro).
  await until(() => !relay.rooms.has(ROOM));
});

test('annonce sans ticket valable : refusée, la séance reste privée', async () => {
  const host = await open(base, ROOM);
  host.send(JSON.stringify({ t: 'announce', ticket: 'invente', proof: PROOF, card: { name: 'X', title: 'Y', time: 1, playing: true } }));
  host.send(JSON.stringify({ t: 'announce', proof: PROOF, card: { name: 'X', title: 'Y', time: 1, playing: true } }));
  await until(() => host.inbox.length === 2);
  assert.deepEqual(host.inbox, [
    { t: 'error', error: 'ticket' },
    { t: 'error', error: 'ticket' },
  ]);
  assert.deepEqual((await (await list(base, FRIEND)).json()).sessions, []);
  host.close();
  await until(() => !relay.rooms.has(ROOM));
});

test('entrée d’un ami : ticket dans le premier message, lié à la salle, une seule fois ; la clé ne passe que de l’hôte à lui', async () => {
  const host = await open(base, ROOM);
  const guest = await open(base, ROOM); // invité par code, déjà là
  assert.deepEqual(await announce(host, base), { t: 'announced' });
  const friendTicket = await ticketFor(base, FRIEND);

  // Le ticket ne voyage plus dans l'adresse (les proxys la journalisent) : il vient dans le message.
  const friend = await open(base, ROOM);
  // Sans ticket, ou avec un ticket inventé : refusé.
  friend.send(JSON.stringify({ t: 'key-request', pub: PUB }));
  friend.send(JSON.stringify({ t: 'key-request', ticket: 'invente', pub: PUB }));
  await until(() => friend.inbox.length === 2);
  assert.deepEqual(friend.inbox, [
    { t: 'error', error: 'ticket' },
    { t: 'error', error: 'ticket' },
  ]);
  friend.inbox.length = 0;
  // Demande de clé : seulement vers l'hôte, avec un numéro de demandeur donné par le relais.
  friend.send(JSON.stringify({ t: 'key-request', ticket: friendTicket, pub: PUB }));
  await until(() => host.inbox.some((m) => m.t === 'key-request'));
  const req = host.inbox.find((m) => m.t === 'key-request');
  assert.deepEqual(Object.keys(req).sort(), ['peer', 'pub', 't']);
  assert.equal(req.pub, PUB);
  assert.match(req.peer, /^[A-Za-z0-9_-]{12}$/);
  // Le même ticket ne rouvre pas cette salle (une entrée par salle et par ticket).
  const again = await open(base, ROOM);
  again.send(JSON.stringify({ t: 'key-request', ticket: friendTicket, pub: PUB }));
  await until(() => again.inbox.length === 1);
  assert.deepEqual(again.inbox, [{ t: 'error', error: 'ticket' }]);
  // Un invité par code ne peut pas demander la clé sans ticket (il l'a déjà).
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

  // Les messages chiffrés suivent comme avant ; les messages texte ne sont jamais renvoyés.
  guest.send(Buffer.from([1, 2, 3]));
  await until(() => host.bin.length === 1 && friend.bin.length === 1);
  assert.deepEqual([...host.bin[0]], [1, 2, 3]);
  for (const ws of [host, guest, friend, again]) ws.close();
});

test('ticket pour une salle non listée : refusé, sans rien demander à personne', async () => {
  const priv = await open(base, PRIVATE_ROOM);
  const friend = await open(base, PRIVATE_ROOM);
  friend.send(JSON.stringify({ t: 'key-request', ticket: await ticketFor(base, FRIEND), pub: PUB }));
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(priv.inbox, []);
  priv.close();
  friend.close();
});

test('la séance appartient à son premier hôte : personne d’autre ne l’annonce, ne la retire ni ne la relance une fois privée', async () => {
  const ROOM2 = 'HHHHHHHHHHHHHHHHHHHHHH';
  const host = await open(base, ROOM2);
  assert.deepEqual(await announce(host, base, { c: card('Camille', 'Vrai titre') }), { t: 'announced' });
  // Un autre utilisateur du serveur, entré dans la salle (le numéro est listé) : pas d'annonce…
  const intruder = await open(base, ROOM2);
  assert.deepEqual(await announce(intruder, base, { proof: 'Z'.repeat(22), c: card('Camille', 'Faux'), token: FRIEND }), { t: 'error', error: 'owner' });
  // … même avec la bonne preuve tant que l'hôte est là ; ni retrait.
  assert.deepEqual(await announce(intruder, base, { c: card('Camille', 'Faux'), token: FRIEND }), { t: 'error', error: 'owner' });
  intruder.send(JSON.stringify({ t: 'unlist' }));
  intruder.send(JSON.stringify({ t: 'release' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relay.rooms.get(ROOM2).card.title, 'Vrai titre');
  // Les demandes de clé vont toujours au premier hôte.
  const friend = await open(base, ROOM2);
  friend.send(JSON.stringify({ t: 'key-request', ticket: await ticketFor(base, FRIEND), pub: PUB }));
  await until(() => host.inbox.some((m) => m.t === 'key-request'));
  assert.equal(intruder.inbox.filter((m) => m.t === 'key-request').length, 0);

  // L'hôte rend la séance privée : personne d'autre ne la relance, même avec la preuve.
  host.send(JSON.stringify({ t: 'unlist' }));
  await until(() => !relay.rooms.get(ROOM2).card);
  assert.deepEqual(await announce(intruder, base, { token: FRIEND }), { t: 'error', error: 'private' });
  host.close();
  await until(() => relay.rooms.get(ROOM2).peers.size === 2);
  assert.deepEqual(await announce(intruder, base, { token: FRIEND }), { t: 'error', error: 'private' });
  assert.equal(relay.rooms.get(ROOM2).card, null);
  for (const ws of [intruder, friend]) ws.close();
});

test('hôte reparti : un membre (qui a la preuve) reprend l’annonce ; un inconnu non', async () => {
  const ROOM3 = 'GGGGGGGGGGGGGGGGGGGGGG';
  const host = await open(base, ROOM3);
  const member = await open(base, ROOM3);
  assert.deepEqual(await announce(host, base), { t: 'announced' });
  host.close();
  await until(() => !relay.rooms.get(ROOM3).card);
  const stranger = await open(base, ROOM3);
  assert.deepEqual(await announce(stranger, base, { proof: 'Z'.repeat(22), token: FRIEND }), { t: 'error', error: 'owner' });
  assert.deepEqual(await announce(member, base, { token: FRIEND }), { t: 'announced' });
  // Passage de main volontaire : « release » libère l'annonce sans rendre la séance privée.
  member.send(JSON.stringify({ t: 'release' }));
  await until(() => !relay.rooms.get(ROOM3).card);
  assert.deepEqual(await announce(member, base, { token: FRIEND }), { t: 'announced' });
  for (const ws of [member, stranger]) ws.close();
});

test('messages au relais : budget à part ; un flot de demandes de clé ne fait pas taire l’hôte', async () => {
  const ROOM4 = 'KKKKKKKKKKKKKKKKKKKKKK';
  const host = await open(base, ROOM4);
  const peer = await open(base, ROOM4);
  assert.deepEqual(await announce(host, base), { t: 'announced' });
  // Des demandes en rafale (tickets valables) : le relais n'en fait suivre que quelques-unes.
  const flood = [];
  for (let i = 0; i < 12; i++) flood.push(await open(base, ROOM4));
  for (const [i, ws] of flood.entries()) ws.send(JSON.stringify({ t: 'key-request', ticket: await ticketFor(base, FRIEND, `198.51.100.${100 + i}`), pub: PUB }));
  await new Promise((r) => setTimeout(r, 150));
  const forwarded = host.inbox.filter((m) => m.t === 'key-request').length;
  assert.ok(forwarded >= 1 && forwarded <= 5, `demandes transmises : ${forwarded}`);
  // L'hôte répond au relais sans entamer le budget des messages de la séance.
  for (let i = 0; i < 15; i++) host.send(JSON.stringify({ t: 'key-grant', peer: 'x'.repeat(12), pub: PUB, box: 'D'.repeat(60) }));
  for (let i = 0; i < 40; i++) host.send(Buffer.from([i]));
  await until(() => peer.bin.length === 40);
  for (const ws of [host, peer, ...flood]) ws.close();
});

test('vérifications Plex : chaque adresse a sa part avant la réserve commune ; IPv6 par /64', async () => {
  const p = mockPlex();
  const url = await p.listen();
  const { relay: r, base: b } = await startRelay(url, { plexBurst: 3, plexPerSecond: 0.001, plexIpBurst: 2, plexIpPerSecond: 0.001 });
  // Une adresse qui essaie des jetons au hasard n'épuise que sa part…
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await list(b, `faux-a-${i}`, '203.0.113.7')).status);
  assert.deepEqual(statuses, [403, 403, 429, 429]);
  // … un utilisateur légitime ailleurs est encore vérifié (la réserve commune n'est pas vide)…
  assert.equal((await list(b, FRIEND, '203.0.113.9')).status, 200);
  await r.close();
  await p.close();
  // … et des adresses IPv6 tournantes du même /64 partagent une seule part.
  const p2 = mockPlex();
  const url2 = await p2.listen();
  const { relay: r2, base: b2 } = await startRelay(url2, { plexBurst: 30, plexPerSecond: 0.001, plexIpBurst: 2, plexIpPerSecond: 0.001 });
  assert.equal((await list(b2, 'faux-b', '2001:db8:1:2::1')).status, 403);
  assert.equal((await list(b2, 'faux-c', '2001:db8:1:2:ffff::9')).status, 403);
  assert.equal((await list(b2, 'faux-d', '2001:db8:1:2:aaaa::3')).status, 429);
  assert.equal((await list(b2, 'faux-e', '2001:db8:1:3::1')).status, 403);
  await r2.close();
  await p2.close();
});

test('clé de limite : IPv4 telle quelle, IPv4 dans IPv6 ramenée, IPv6 par /64', () => {
  assert.equal(limitKey('203.0.113.7'), '203.0.113.7');
  assert.equal(limitKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(limitKey('2001:db8:1:2::1'), limitKey('2001:0db8:0001:0002:ffff:0:0:9'));
  assert.notEqual(limitKey('2001:db8:1:2::1'), limitKey('2001:db8:1:3::1'));
  assert.equal(limitKey('::1'), limitKey('0:0:0:0:0:0:0:1'));
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
  const { relay: r, base: b } = await startRelay(url, { plexBurst: 3, plexPerSecond: 0.001, plexIpBurst: 100 });
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
