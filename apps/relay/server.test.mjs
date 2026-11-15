// Tests du relais : recherche de salles, limites par adresse et commune, expiration des salles.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { bucket, clientIp, createRelay, perIp } from './server.mjs';

const ROOM = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'BBBBBBBBBBBBBBBBBBBBBB';

let clock = 1_000_000;
const now = () => clock;

let relay;
let base;
before(async () => {
  relay = createRelay({ now, ipBurst: 20, ipPerSecond: 1, missBurst: 1000, missPerSecond: 10, ttlMs: 60_000 });
  await new Promise((r) => relay.http.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${relay.http.address().port}`;
});
after(() => relay.close());

const open = (room, headers = {}) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/multiplex-relay/r/${room}`, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
    ws.once('error', reject);
  });

const lookup = (ids, headers = {}) => fetch(`http://${base}/multiplex-relay/rooms?ids=${ids.join(',')}`, { headers });

test('seau à jetons : avance, puis un jeton par seconde', () => {
  let t = 0;
  const b = bucket(3, 1, () => t);
  assert.equal(b.take(), true);
  assert.equal(b.take(2), true);
  assert.equal(b.take(), false);
  t += 1000;
  assert.equal(b.take(), true);
  assert.equal(b.take(), false);
  t += 10_000;
  assert.equal(b.full(), true);
});

test('seaux par adresse : indépendants, oubliés une fois pleins', () => {
  let t = 0;
  const l = perIp(2, 1, () => t);
  assert.equal(l.take('a', 2), true);
  assert.equal(l.take('a'), false);
  assert.equal(l.take('b'), true);
  t += 5000;
  l.sweep();
  assert.equal(l.size, 0);
});

test('adresse du client : X-Forwarded-For seulement derrière un proxy privé', () => {
  const req = (peer, fwd) => ({ socket: { remoteAddress: peer }, headers: fwd ? { 'x-forwarded-for': fwd } : {} });
  assert.equal(clientIp(req('203.0.113.9', '1.2.3.4'), undefined), '203.0.113.9');
  assert.equal(clientIp(req('172.18.0.2', '6.6.6.6, 198.51.100.7'), undefined), '198.51.100.7');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '198.51.100.7'), undefined), '198.51.100.7');
  assert.equal(clientIp(req('172.18.0.2', '198.51.100.7'), '0'), '172.18.0.2');
  assert.equal(clientIp(req('203.0.113.9', '198.51.100.7'), '1'), '198.51.100.7');
});

test('recherche : se présente comme relais MultiPlex et ne cite que les salles ouvertes', async () => {
  const ws = await open(ROOM, { 'x-forwarded-for': '198.51.100.1' });
  const r = await lookup([ROOM, OTHER, 'trop-court'], { 'x-forwarded-for': '198.51.100.1' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  // `friends` : ajouté sans rien changer au reste (un ancien client l'ignore).
  assert.deepEqual(await r.json(), { multiplex: 'relay', found: [ROOM], friends: false });
  ws.close();
});

test('chaque salle demandée coûte un jeton à l’adresse : au-delà, 429', async () => {
  const h = { 'x-forwarded-for': '198.51.100.2' };
  const ids = Array.from({ length: 10 }, (_, i) => `C${String(i).padStart(21, 'C')}`);
  assert.equal((await lookup(ids, h)).status, 200);
  assert.equal((await lookup(ids, h)).status, 200);
  assert.equal((await lookup(ids.slice(0, 1), h)).status, 429);
  // Une autre adresse n'est pas gênée.
  assert.equal((await lookup(ids.slice(0, 1), { 'x-forwarded-for': '198.51.100.3' })).status, 200);
  // Les entrées dans une salle comptent aussi.
  await assert.rejects(open(OTHER, h), /429/);
  clock += 5000;
  assert.equal((await lookup(ids.slice(0, 5), h)).status, 200);
});

test('les salles inexistantes demandées sont aussi bornées pour tout le monde', async () => {
  const r = createRelay({ now, ipBurst: 1000, ipPerSecond: 100, missBurst: 3, missPerSecond: 1 });
  await new Promise((res) => r.http.listen(0, '127.0.0.1', res));
  const port = r.http.address().port;
  const ask = (ip) => fetch(`http://127.0.0.1:${port}/rooms?ids=${ROOM},${OTHER}`, { headers: { 'x-forwarded-for': ip } });
  assert.equal((await ask('198.51.100.10')).status, 200);
  assert.equal((await ask('198.51.100.11')).status, 429);
  await r.close();
});

test('une salle ferme au bout de sa durée de vie', async () => {
  const room = 'DDDDDDDDDDDDDDDDDDDDDD';
  const ws = await open(room, { 'x-forwarded-for': '198.51.100.20' });
  assert.ok(relay.rooms.has(room));
  const closed = new Promise((r) => ws.once('close', (code) => r(code)));
  clock += 61_000;
  relay.sweep();
  assert.equal(relay.rooms.has(room), false);
  assert.equal(await closed, 4000);
});
