// Tests du relais : séances visibles par les amis Plex de leur hôte, et par eux seuls.
//
// Deux faux serveurs répondent comme les vrais, sur les seules adresses dont le relais se sert :
// - le Plex du relais : /identity (sans jeton), /library/sections (200 avec un jeton de ce serveur,
//   401 sinon) et /status/sessions (200 pour l'administrateur seulement) ;
// - plex.tv, avec le jeton du propriétaire (PLEX_TOKEN) : /api/v2/user (le propriétaire),
//   /api/servers/{machineId}/shared_servers (un SharedServer par partage : userID, accessToken)
//   et /api/users/ (ses amis : id, title, username, thumb), en XML comme le vrai.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { allowList, createRelay, limitKey, sanitizeCard, xmlElements } from './server.mjs';

const ROOM = 'FFFFFFFFFFFFFFFFFFFFFF';
const PRIVATE_ROOM = 'PPPPPPPPPPPPPPPPPPPPPP';
const SERVER_ID = 'mock-machine-identifier-0001';
// Jeton plex.tv du propriétaire : ne doit jamais sortir ailleurs que vers plex.tv, en en-tête.
const PLEX_TOKEN = 'OWNER-PLEXTV-ACCOUNT-TOKEN-must-never-leak';

// Comptes plex.tv. Le propriétaire du serveur, puis trois utilisateurs du serveur (partages).
const OWNER_ID = '1000';
const HOST_ID = '2002';
const FRIEND_ID = '2001';
const OTHER_ID = '2003';
// Jetons propres au serveur (accessToken de chaque partage) ; celui du propriétaire est délégué.
const HOST = 'host-server-token';
const FRIEND = 'friend-server-token';
const OTHER = 'other-server-user-token';
const OWNER = 'owner-delegation-token';
// Accepté par Plex mais inconnu de plex.tv (un profil du foyer, par exemple) : personne.
const UNNAMED = 'unnamed-server-token';

/** Faux Plex : `open` = laisse tout passer ; `adminOpen` = /status/sessions ouvert à tous. */
function mockPlex({ open = false, adminOpen = false, tokens = [HOST, FRIEND, OTHER, OWNER, UNNAMED] } = {}) {
  const calls = [];
  const srv = createServer((req, res) => {
    const token = req.headers['x-plex-token'];
    calls.push({ path: req.url, token });
    if (req.url === '/identity') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ MediaContainer: { size: 0, claimed: true, machineIdentifier: SERVER_ID, version: '1.43.4' } }));
    }
    const allowed = req.url === '/library/sections' ? open || tokens.includes(token) : req.url === '/status/sessions' ? open || token === OWNER || (adminOpen && tokens.includes(token)) : null;
    if (allowed === null) {
      res.writeHead(404);
      return res.end();
    }
    if (allowed) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ MediaContainer: { size: 0 } }));
    }
    res.writeHead(401, { 'content-type': 'text/html' });
    res.end('<html><head><title>Unauthorized</title></head><body><h1>401 Unauthorized</h1></body></html>');
  });
  return {
    calls,
    listen: () => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`))),
    close: () => new Promise((r) => srv.close(() => r())),
  };
}

/** Faux plex.tv : `shares` (userID → accessToken) et `users` modifiables pendant un test. */
function mockPlexTv({ fail = false } = {}) {
  const calls = [];
  const state = {
    shares: [
      [FRIEND_ID, FRIEND],
      [HOST_ID, HOST],
      [OTHER_ID, OTHER],
    ],
    users: [
      [FRIEND_ID, 'Camille', 'camille'],
      [HOST_ID, 'Dominique', 'dom'],
      [OTHER_ID, 'Eli', 'eli'],
    ],
  };
  const srv = createServer((req, res) => {
    const token = req.headers['x-plex-token'];
    calls.push({ path: req.url, token, client: req.headers['x-plex-client-identifier'] });
    if (fail || token !== PLEX_TOKEN) {
      res.writeHead(fail ? 503 : 401);
      return res.end();
    }
    if (req.url === '/api/v2/user') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: Number(OWNER_ID), uuid: 'u-owner', username: 'proprio', title: 'Proprio', thumb: 'https://plex.tv/users/u-owner/avatar' }));
    }
    if (req.url === `/api/servers/${SERVER_ID}/shared_servers`) {
      res.writeHead(200, { 'content-type': 'application/xml' });
      const rows = state.shares.map(([id, t], i) => `<SharedServer id="${90 + i}" userID="${id}" accessToken="${t}" serverId="7" machineIdentifier="${SERVER_ID}"><Section id="1" key="1" title="Films" type="movie" shared="1"/></SharedServer>`);
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer friendlyName="myPlex" identifier="com.plexapp.plugins.myplex" machineIdentifier="${SERVER_ID}" size="${rows.length}">${rows.join('')}</MediaContainer>`);
    }
    if (req.url === '/api/users/') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      const rows = state.users.map(([id, title, username]) => `<User id="${id}" title="${title}" username="${username}" thumb="https://plex.tv/users/${username}/avatar" home="0"><Server id="7" machineIdentifier="${SERVER_ID}" name="nas" owned="1"/></User>`);
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer friendlyName="myPlex" size="${rows.length}">${rows.join('')}</MediaContainer>`);
    }
    res.writeHead(404);
    res.end();
  });
  return {
    calls,
    state,
    listen: () => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`))),
    close: () => new Promise((r) => srv.close(() => r())),
  };
}

async function startRelay(plexUrl, plexTvUrl, extra = {}) {
  const relay = createRelay({ plexUrl, plexTvUrl, plexToken: PLEX_TOKEN, ipBurst: 200, ipPerSecond: 10, ...extra });
  await relay.probing;
  await new Promise((r) => relay.http.listen(0, '127.0.0.1', r));
  return { relay, base: `127.0.0.1:${relay.http.address().port}` };
}

const list = (base, token, ip = '198.51.100.40') =>
  fetch(`http://${base}/multiplex-relay/friends`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-forwarded-for': ip }, body: JSON.stringify({ token }) });
const sessionsFor = async (base, token, ip) => (await (await list(base, token, ip)).json()).sessions;

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
/** Un message de l'hôte au relais, et la réponse du relais. */
async function control(ws, msg) {
  const n = ws.inbox.length;
  ws.send(JSON.stringify(msg));
  await until(() => ws.inbox.length > n);
  return ws.inbox[ws.inbox.length - 1];
}
/** L'hôte annonce sa séance (ticket obtenu avec son jeton) avec sa liste d'amis. */
const announce = async (ws, b, { proof = PROOF, c = card(), token = HOST, friends = [FRIEND_ID, OWNER_ID] } = {}) =>
  control(ws, { t: 'announce', ticket: await ticketFor(b, token), proof, card: c, ...(friends ? { friends } : {}) });

let plex;
let tv;
let relay;
let base;
const logs = [];
const realWarn = console.warn;
const realLog = console.log;
before(async () => {
  // Tout ce que le relais écrit est gardé, pour vérifier qu'aucun jeton n'y figure.
  console.warn = (...a) => logs.push(a.join(' '));
  console.log = (...a) => logs.push(a.join(' '));
  plex = mockPlex();
  tv = mockPlexTv();
  ({ relay, base } = await startRelay(await plex.listen(), await tv.listen(), { plexIpBurst: 100 }));
});
after(async () => {
  await relay.close();
  await plex.close();
  await tv.close();
  console.warn = realWarn;
  console.log = realLog;
});

test('sans PLEX_URL : aucune liste, et le relais le dit (invitations inchangées)', async () => {
  const { relay: r, base: b } = await startRelay('', '');
  const res = await list(b, FRIEND);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { multiplex: 'relay', friends: false });
  assert.deepEqual(await (await fetch(`http://${b}/rooms?ids=`)).json(), { multiplex: 'relay', found: [], friends: false });
  await r.close();
});

test('sans PLEX_TOKEN : rien n’est listé, jamais de repli sur « tout utilisateur du serveur »', async () => {
  const p = mockPlex();
  const r = createRelay({ plexUrl: await p.listen(), plexToken: '', ipBurst: 200, ipPerSecond: 10 });
  await r.probing;
  await new Promise((ok) => r.http.listen(0, '127.0.0.1', ok));
  const b = `127.0.0.1:${r.http.address().port}`;
  assert.equal(r.friends.ready, false);
  assert.equal(r.friends.reason, 'off');
  for (const token of [FRIEND, HOST, OWNER]) {
    const res = await list(b, token);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { multiplex: 'relay', friends: false });
  }
  assert.deepEqual(await (await fetch(`http://${b}/rooms?ids=`)).json(), { multiplex: 'relay', found: [], friends: false });
  // Une annonce est refusée, la séance reste privée ; et Plex n'a même pas été interrogé.
  const host = await open(b, ROOM);
  assert.deepEqual(await control(host, { t: 'announce', ticket: 'x', proof: PROOF, card: card(), friends: [FRIEND_ID] }), { t: 'error', error: 'unavailable' });
  assert.equal(p.calls.length, 0);
  assert.ok(logs.some((l) => l.includes('PLEX_TOKEN')));
  host.close();
  await r.close();
  await p.close();
});

test('le relais vérifie son Plex et lit les partages du propriétaire au démarrage', async () => {
  assert.equal(relay.friends.ready, true);
  assert.equal(relay.friends.server, SERVER_ID);
  assert.equal(relay.directory.owner.id, OWNER_ID);
  assert.equal(relay.directory.byHash.size, 3);
  // Rien que des empreintes : aucun jeton gardé tel quel.
  const kept = JSON.stringify([...relay.directory.byHash]);
  for (const t of [HOST, FRIEND, OTHER, PLEX_TOKEN]) assert.ok(!kept.includes(t));
  // Identifiant du serveur (non secret, comme /identity) : comparé AVANT d'envoyer un jeton.
  assert.deepEqual(await (await fetch(`http://${base}/rooms?ids=`)).json(), { multiplex: 'relay', found: [], friends: true, friendsOnly: true, server: SERVER_ID });
  // Les trois adresses de plex.tv, avec le jeton du propriétaire en en-tête seulement.
  assert.deepEqual(new Set(tv.calls.map((c) => c.path)), new Set(['/api/v2/user', `/api/servers/${SERVER_ID}/shared_servers`, '/api/users/']));
  assert.ok(tv.calls.every((c) => c.token === PLEX_TOKEN && c.client));
  // Le jeton du propriétaire ne part jamais vers son Plex.
  assert.ok(plex.calls.every((c) => c.token !== PLEX_TOKEN));
});

test('séance listée aux seuls amis Plex de l’hôte ; ni aux autres utilisateurs du serveur, ni à l’hôte, ni privée', async () => {
  const priv = await open(base, PRIVATE_ROOM);
  const host = await open(base, ROOM);
  // L'hôte déclare un autre nom : le relais affiche celui de son compte plex.tv.
  assert.deepEqual(
    await control(host, {
      t: 'announce',
      ticket: await ticketFor(base, HOST),
      proof: PROOF,
      friends: [FRIEND_ID, OWNER_ID, HOST_ID],
      card: { name: 'Camille', title: 'Le Grand Voyage', sub: '1987', type: 'movie', guid: 'plex://movie/abc', key: '42', time: 125.5, playing: true, device: 'Salon', address: '192.168.1.20', stream: 'direct' },
    }),
    { t: 'announced' },
  );

  // Ami de l'hôte : la séance, avec seulement les champs utiles et le nom vérifié.
  const ok = await list(base, FRIEND);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), '*');
  const a = await ok.json();
  assert.equal(a.server, SERVER_ID);
  assert.equal(a.friendsOnly, true);
  assert.match(a.ticket, /^[A-Za-z0-9_-]{24}$/);
  assert.deepEqual(
    a.sessions.map((s) => s.room),
    [ROOM],
  );
  assert.deepEqual(a.sessions[0].card, { name: 'Dominique', title: 'Le Grand Voyage', sub: '1987', type: 'movie', guid: 'plex://movie/abc', key: '42', time: 125.5, playing: true });
  assert.equal(a.sessions[0].count, 1);
  // Le propriétaire, ami de l'hôte, reconnu par son jeton délégué (administrateur du serveur).
  assert.deepEqual(
    (await sessionsFor(base, OWNER)).map((s) => s.room),
    [ROOM],
  );

  // Un utilisateur du serveur qui n'est pas ami de l'hôte : une réponse ordinaire, mais vide,
  // comme quand il n'y a aucune séance. L'hôte non plus ne se voit pas ; ni un jeton sans nom.
  for (const token of [OTHER, HOST, UNNAMED]) {
    const r = await list(base, token);
    assert.equal(r.status, 200, token);
    const body = await r.json();
    assert.deepEqual(Object.keys(body).sort(), ['friendsOnly', 'multiplex', 'server', 'sessions', 'ticket', 'ttl']);
    assert.deepEqual(body.sessions, [], token);
  }

  // Personne d'autre : ni jeton inventé, ni jeton d'un autre serveur, ni rien.
  for (const token of ['jeton-invente', 'other-server-token', '', undefined, 'x'.repeat(600), PLEX_TOKEN]) {
    const r = await list(base, token);
    assert.equal(r.status, 403, String(token));
    assert.deepEqual(await r.json(), { multiplex: 'relay', error: 'forbidden' });
  }
  // Pas par un GET non plus.
  assert.equal((await fetch(`http://${base}/friends`)).status, 405);

  // L'hôte retire sa séance : plus listée ; il part : plus rien.
  host.send(JSON.stringify({ t: 'unlist' }));
  await until(() => !relay.rooms.get(ROOM).card);
  assert.deepEqual(await sessionsFor(base, FRIEND), []);
  priv.close();
  host.close();
  // Salle fermée avec son dernier membre (la suivante repart de zéro).
  await until(() => !relay.rooms.has(ROOM));
});

test('ami retiré de la liste : il perd la séance à l’annonce suivante, et ne peut plus y entrer', async () => {
  const ROOM5 = 'LLLLLLLLLLLLLLLLLLLLLL';
  const host = await open(base, ROOM5);
  assert.deepEqual(await announce(host, base, { friends: [FRIEND_ID, OTHER_ID] }), { t: 'announced' });
  assert.deepEqual(
    (await sessionsFor(base, OTHER)).map((s) => s.room),
    [ROOM5],
  );
  const otherTicket = await ticketFor(base, OTHER);
  // Rafraîchissement sans liste : la précédente tient.
  assert.deepEqual(await control(host, { t: 'announce', proof: PROOF, card: card('x', 'Film 2') }), { t: 'announced' });
  assert.equal((await sessionsFor(base, OTHER)).length, 1);
  // Nouvelle liste sans Eli : il ne voit plus rien, et son ticket n'ouvre plus la salle.
  assert.deepEqual(await control(host, { t: 'announce', proof: PROOF, card: card('x', 'Film 2'), friends: [FRIEND_ID] }), { t: 'announced' });
  assert.deepEqual(await sessionsFor(base, OTHER), []);
  assert.equal((await sessionsFor(base, FRIEND)).length, 1);
  const other = await open(base, ROOM5);
  assert.deepEqual(await control(other, { t: 'key-request', ticket: otherTicket, pub: PUB }), { t: 'error', error: 'ticket' });
  assert.equal(host.inbox.filter((m) => m.t === 'key-request').length, 0);
  // Liste mal formée : refusée, la précédente tient.
  assert.deepEqual(await control(host, { t: 'announce', proof: PROOF, card: card(), friends: ['camille'] }), { t: 'error', error: 'friends' });
  assert.deepEqual(await control(host, { t: 'announce', proof: PROOF, card: card(), friends: Array.from({ length: 1001 }, (_, i) => String(i + 1)) }), { t: 'error', error: 'friends' });
  assert.equal((await sessionsFor(base, FRIEND)).length, 1);
  for (const ws of [host, other]) ws.close();
});

test('première annonce sans liste d’amis (application ancienne) : refusée, rien de listé', async () => {
  const ROOM6 = 'MMMMMMMMMMMMMMMMMMMMMM';
  const host = await open(base, ROOM6);
  assert.deepEqual(await announce(host, base, { friends: null }), { t: 'error', error: 'unavailable' });
  assert.equal(relay.rooms.get(ROOM6).card, null);
  // Un jeton que Plex accepte mais que plex.tv ne nomme pas n'annonce rien non plus.
  const anon = await open(base, 'NNNNNNNNNNNNNNNNNNNNNN');
  assert.deepEqual(await announce(anon, base, { token: UNNAMED }), { t: 'error', error: 'unavailable' });
  for (const ws of [host, anon]) ws.close();
});

test('le propriétaire héberge : reconnu par son jeton délégué, nommé d’après son compte, vu de ses amis', async () => {
  const ROOM7 = 'QQQQQQQQQQQQQQQQQQQQQQ';
  const host = await open(base, ROOM7);
  assert.deepEqual(await announce(host, base, { token: OWNER, c: card('Faux nom'), friends: [HOST_ID] }), { t: 'announced' });
  const s = await sessionsFor(base, HOST);
  assert.equal(s.length, 1);
  assert.equal(s[0].card.name, 'Proprio');
  assert.deepEqual(await sessionsFor(base, FRIEND), []);
  assert.deepEqual(await sessionsFor(base, OWNER), []);
  host.close();
});

test('annonce sans ticket valable : refusée, la séance reste privée', async () => {
  const host = await open(base, ROOM);
  host.send(JSON.stringify({ t: 'announce', ticket: 'invente', proof: PROOF, card: card(), friends: [FRIEND_ID] }));
  host.send(JSON.stringify({ t: 'announce', proof: PROOF, card: card(), friends: [FRIEND_ID] }));
  await until(() => host.inbox.length === 2);
  assert.deepEqual(host.inbox, [
    { t: 'error', error: 'ticket' },
    { t: 'error', error: 'ticket' },
  ]);
  assert.deepEqual(await sessionsFor(base, FRIEND), []);
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
  // Un utilisateur du serveur qui n'est pas ami de l'hôte : ticket valable, mais refusé ici.
  const stranger = await open(base, ROOM);
  assert.deepEqual(await control(stranger, { t: 'key-request', ticket: await ticketFor(base, OTHER), pub: PUB }), { t: 'error', error: 'ticket' });
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
  assert.deepEqual(
    stranger.inbox.filter((m) => m.t === 'key-grant'),
    [],
  );
  assert.equal(host.inbox.filter((m) => m.t === 'key-request').length, 1);

  // Les messages chiffrés suivent comme avant ; les messages texte ne sont jamais renvoyés.
  guest.send(Buffer.from([1, 2, 3]));
  await until(() => host.bin.length === 1 && friend.bin.length === 1);
  assert.deepEqual([...host.bin[0]], [1, 2, 3]);
  for (const ws of [host, guest, friend, again, stranger]) ws.close();
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

test('hôte reparti : un membre (qui a la preuve) reprend l’annonce, sous son nom et avec SES amis ; un inconnu non', async () => {
  const ROOM3 = 'GGGGGGGGGGGGGGGGGGGGGG';
  const host = await open(base, ROOM3);
  const member = await open(base, ROOM3);
  assert.deepEqual(await announce(host, base), { t: 'announced' });
  host.close();
  await until(() => !relay.rooms.get(ROOM3).card);
  const stranger = await open(base, ROOM3);
  assert.deepEqual(await announce(stranger, base, { proof: 'Z'.repeat(22), token: FRIEND }), { t: 'error', error: 'owner' });
  // Le nouvel hôte doit apporter sa liste : celle de l'ancien ne le suit pas.
  assert.deepEqual(await announce(member, base, { token: FRIEND, friends: null }), { t: 'error', error: 'unavailable' });
  assert.deepEqual(await control(member, { t: 'announce', proof: PROOF, card: card(), friends: [OTHER_ID] }), { t: 'announced' });
  assert.equal((await sessionsFor(base, OTHER)).find((s) => s.room === ROOM3)?.card.name, 'Camille');
  assert.deepEqual(
    (await sessionsFor(base, OWNER)).filter((s) => s.room === ROOM3),
    [],
  );
  // Passage de main volontaire : « release » libère l'annonce sans rendre la séance privée.
  member.send(JSON.stringify({ t: 'release' }));
  await until(() => !relay.rooms.get(ROOM3).card);
  assert.deepEqual(await control(member, { t: 'announce', proof: PROOF, card: card(), friends: [OTHER_ID] }), { t: 'announced' });
  for (const ws of [member, stranger]) ws.close();
});

test('nouveau partage : plex.tv relu (au plus une fois par minute), le nouvel ami reconnu', async () => {
  const p = mockPlex({ tokens: [HOST, FRIEND, OTHER, OWNER, 'new-share-token'] });
  const t = mockPlexTv();
  let clock = 1_000_000;
  const { relay: r, base: b } = await startRelay(await p.listen(), await t.listen(), { now: () => clock });
  const ROOM8 = 'RRRRRRRRRRRRRRRRRRRRRR';
  const host = await open(b, ROOM8);
  assert.deepEqual(await announce(host, b, { friends: ['2004'] }), { t: 'announced' });
  // Le propriétaire partage son serveur avec 2004 : son jeton n'est pas encore connu du relais.
  t.state.shares.push(['2004', 'new-share-token']);
  t.state.users.push(['2004', 'Fanny', 'fanny']);
  const shares = () => t.calls.filter((c) => c.path.endsWith('/shared_servers')).length;
  // Moins d'une minute après la dernière lecture : pas de relecture, rien de listé.
  assert.deepEqual(await sessionsFor(b, 'new-share-token'), []);
  assert.equal(shares(), 1);
  // Plus tard (verdict expiré, et plus d'une minute depuis la dernière lecture) : relu, reconnu.
  clock += 6 * 60_000;
  assert.deepEqual(
    (await sessionsFor(b, 'new-share-token')).map((s) => s.room),
    [ROOM8],
  );
  assert.equal(shares(), 2);
  host.close();
  await r.close();
  await p.close();
  await t.close();
});

test('plex.tv injoignable ou PLEX_TOKEN refusé : rien n’est listé, et le jeton n’apparaît nulle part', async () => {
  for (const fail of [true, false]) {
    const p = mockPlex();
    const t = mockPlexTv({ fail });
    const r = createRelay({ plexUrl: await p.listen(), plexTvUrl: await t.listen(), plexToken: fail ? PLEX_TOKEN : `${PLEX_TOKEN}-revoked`, ipBurst: 200, ipPerSecond: 10 });
    await r.probing;
    await new Promise((ok) => r.http.listen(0, '127.0.0.1', ok));
    const b = `127.0.0.1:${r.http.address().port}`;
    assert.equal(r.friends.ready, false);
    assert.equal(r.friends.reason, 'plextv');
    const res = await list(b, FRIEND);
    assert.equal(res.status, 503);
    assert.ok(!(await res.text()).includes(PLEX_TOKEN));
    assert.equal((await (await fetch(`http://${b}/rooms?ids=`)).json()).friends, false);
    await r.close();
    await p.close();
    await t.close();
  }
});

test('Plex qui laisse un ami lire /status/sessions : le propriétaire n’est plus reconnu, ses amis si', async () => {
  const p = mockPlex({ adminOpen: true });
  const t = mockPlexTv();
  const { relay: r, base: b } = await startRelay(await p.listen(), await t.listen());
  assert.equal(r.friends.ready, true);
  assert.equal(r.directory.ownerCheck, false);
  const host = await open(b, ROOM);
  assert.deepEqual(await announce(host, b), { t: 'announced' });
  assert.equal((await sessionsFor(b, FRIEND)).length, 1);
  assert.deepEqual(await sessionsFor(b, OWNER), []);
  host.close();
  await r.close();
  await p.close();
  await t.close();
});

test('vérifications Plex : chaque adresse a sa part avant la réserve commune ; IPv6 par /64', async () => {
  const p = mockPlex();
  const t = mockPlexTv();
  const tvUrl = await t.listen();
  const { relay: r, base: b } = await startRelay(await p.listen(), tvUrl, { plexBurst: 3, plexPerSecond: 0.001, plexIpBurst: 2, plexIpPerSecond: 0.001 });
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
  const { relay: r2, base: b2 } = await startRelay(await p2.listen(), tvUrl, { plexBurst: 30, plexPerSecond: 0.001, plexIpBurst: 2, plexIpPerSecond: 0.001 });
  assert.equal((await list(b2, 'faux-b', '2001:db8:1:2::1')).status, 403);
  assert.equal((await list(b2, 'faux-c', '2001:db8:1:2:ffff::9')).status, 403);
  assert.equal((await list(b2, 'faux-d', '2001:db8:1:2:aaaa::3')).status, 429);
  assert.equal((await list(b2, 'faux-e', '2001:db8:1:3::1')).status, 403);
  await r2.close();
  await p2.close();
  await t.close();
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
  const t = mockPlexTv();
  const { relay: r, base: b } = await startRelay(await lax.listen(), await t.listen());
  assert.equal(r.friends.ready, false);
  assert.equal(r.friends.reason, 'open');
  assert.equal((await list(b, FRIEND)).status, 503);
  assert.equal((await (await fetch(`http://${b}/rooms?ids=`)).json()).friends, false);
  await r.close();
  await lax.close();
  await t.close();
});

test('verdicts gardés quelques minutes ; vérifications auprès de Plex bornées pour tout le monde', async () => {
  const p = mockPlex();
  const t = mockPlexTv();
  const { relay: r, base: b } = await startRelay(await p.listen(), await t.listen(), { plexBurst: 3, plexPerSecond: 0.001, plexIpBurst: 100 });
  const before = p.calls.filter((c) => c.path === '/library/sections').length; // contre-épreuve
  for (let i = 0; i < 5; i++) assert.equal((await list(b, FRIEND)).status, 200);
  assert.equal(p.calls.filter((c) => c.path === '/library/sections').length - before, 1);
  // Jetons inventés en rafale : au-delà de la réserve, 429 sans même demander à Plex.
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await list(b, `faux-${i}`)).status);
  assert.deepEqual(statuses, [403, 403, 429, 429]);
  await r.close();
  await p.close();
  await t.close();
});

test('chaque demande de liste coûte un jeton à l’adresse', async () => {
  const p = mockPlex();
  const t = mockPlexTv();
  const { relay: r, base: b } = await startRelay(await p.listen(), await t.listen(), { ipBurst: 2, ipPerSecond: 0.001 });
  assert.equal((await list(b, FRIEND, '203.0.113.50')).status, 200);
  assert.equal((await list(b, FRIEND, '203.0.113.50')).status, 200);
  assert.equal((await list(b, FRIEND, '203.0.113.50')).status, 429);
  assert.equal((await list(b, FRIEND, '203.0.113.51')).status, 200);
  await r.close();
  await p.close();
  await t.close();
});

test('fiche annoncée : champs connus seulement, bornés, sous le nom vérifié', () => {
  assert.equal(sanitizeCard({ title: 'sans nom vérifié' }), null);
  assert.equal(sanitizeCard('texte', 'A'), null);
  assert.equal(sanitizeCard({ name: 'Déclaré' }, 'A'), null);
  const c = sanitizeCard({ name: 'Déclaré', title: 'T'.repeat(500), time: -5, playing: 'oui', device: 'TV', ip: '10.0.0.1' }, ' A ');
  assert.deepEqual(Object.keys(c).sort(), ['name', 'playing', 'time', 'title']);
  assert.equal(c.name, 'A');
  assert.equal(c.title.length, 200);
  assert.equal(c.time, 0);
  assert.equal(c.playing, false);
});

test('liste d’amis : numéros de compte seulement, 1 000 au plus', () => {
  assert.deepEqual([...allowList(['12', 12, '0012', '7'])], ['12', '7']);
  assert.deepEqual([...allowList([])], []);
  for (const bad of [null, 'x', {}, ['abc'], [0], [-1], ['1.5'], [{}], ['1234567890123']]) assert.equal(allowList(bad), null, JSON.stringify(bad));
  assert.equal(allowList(Array.from({ length: 1001 }, (_, i) => i + 1)), null);
});

test('XML de plex.tv : attributs des éléments demandés, entités décodées', () => {
  const xml = '<MediaContainer size="2"><SharedServer id="1" userID="42" accessToken="a&amp;b"><Section id="3"/></SharedServer><SharedServer userID="7" accessToken="x" /><User id="9" title="L&#233;a &quot;L&quot;"/></MediaContainer>';
  assert.deepEqual(xmlElements(xml, 'SharedServer'), [
    { id: '1', userID: '42', accessToken: 'a&b' },
    { userID: '7', accessToken: 'x' },
  ]);
  assert.deepEqual(xmlElements(xml, 'User'), [{ id: '9', title: 'Léa "L"' }]);
  assert.deepEqual(xmlElements(xml, 'Server'), []);
});

test('aucun jeton dans ce que le relais écrit', () => {
  const all = logs.join('\n');
  for (const t of [PLEX_TOKEN, HOST, FRIEND, OTHER, OWNER, UNNAMED, 'new-share-token']) assert.ok(!all.includes(t), t);
});
