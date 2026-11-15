import { describe, expect, it } from 'vitest';
import {
  INVITE_ALPHABET,
  b64,
  deriveLegacy,
  deriveSession,
  findRoom,
  formatInvite,
  inviteText,
  makeSecret,
  parseInvite,
  relayCandidates,
  relayDiscoverable,
  relayUrl,
  type PlexConnection,
} from '../src';

const conn = (uri: string, more: Partial<PlexConnection> = {}): PlexConnection => {
  const u = new URL(uri);
  return { uri, local: false, relay: false, protocol: u.protocol.slice(0, -1), address: u.hostname, port: Number(u.port) || 443, ...more };
};

describe('invitations courtes', () => {
  it('alphabet : 31 signes, sans 0/O ni 1/I/L', () => {
    expect(INVITE_ALPHABET).toHaveLength(31);
    expect(new Set(INVITE_ALPHABET).size).toBe(31);
    for (const c of '0O1IL') expect(INVITE_ALPHABET).not.toContain(c);
  });

  it('secret : 8 signes de l’alphabet, tirés uniformément', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      const s = makeSecret();
      expect(s).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
      for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect(counts.size).toBe(31);
    // 32 000 signes / 31 ≈ 1032 chacun ; un biais modulo (octets 248 à 255) se verrait.
    for (const n of counts.values()) expect(Math.abs(n - 1032)).toBeLessThan(200);
  });

  it('rejette les octets qui biaiseraient le tirage', () => {
    let calls = 0;
    const s = makeSecret((n) => new Uint8Array(n).fill(calls++ ? 0 : 255));
    expect(s).toBe('22222222');
  });

  it('forme : MPX-XXXX-XXXX, et le relais après « @ » seulement si on le donne', () => {
    expect(formatInvite('K7Q29XFD')).toBe('MPX-K7Q2-9XFD');
    expect(formatInvite('k7q29xfd', 'wss://relais.exemple.fr')).toBe('MPX-K7Q2-9XFD@relais.exemple.fr');
  });

  it('lecture tolérante : casse, espaces, tirets, texte autour', () => {
    for (const text of ['MPX-K7Q2-9XFD', 'mpx-k7q2-9xfd', '  MPX K7Q2 9XFD ', 'MPX-K7Q29XFD', 'MPX–K7Q2–9XFD', 'Rejoins-moi : MPX-K7Q2-9XFD !', 'K7Q2-9XFD', 'k7q2 9xfd', 'mpxk7q29xfd']) {
      expect(parseInvite(text), text).toEqual({ v: 3, secret: 'K7Q29XFD' });
    }
  });

  it('refuse les signes ambigus et les longueurs fausses', () => {
    for (const text of ['MPX-K7Q2-9XF0', 'MPX-K7Q2-9XFO', 'MPX-K7Q2-9XFI', 'MPX-K7Q2-9XF', 'MPX-K7Q2-9XFDA', 'K7Q2-9XF', 'bonjour', '']) {
      expect(parseInvite(text), text).toBeNull();
    }
  });

  it('forme de secours avec relais', () => {
    expect(parseInvite('MPX-K7Q2-9XFD@relais.exemple.fr')).toEqual({ v: 3, secret: 'K7Q29XFD', relay: 'wss://relais.exemple.fr' });
    expect(parseInvite('(MPX-K7Q2-9XFD @ https://relais.exemple.fr:1744/multiplex-relay).')).toEqual({ v: 3, secret: 'K7Q29XFD', relay: 'wss://relais.exemple.fr:1744/multiplex-relay' });
    expect(inviteText({ v: 3, secret: 'K7Q29XFD' })).toBe('MPX-K7Q2-9XFD');
  });

  it('anciennes formes toujours acceptées et repartagées telles quelles', () => {
    const v2 = 'MPX-q3Vb8xK2mT0wZr5L@relais.exemple.fr';
    expect(parseInvite(v2)).toEqual({ v: 2, secret: 'q3Vb8xK2mT0wZr5L', relay: 'wss://relais.exemple.fr' });
    expect(inviteText(parseInvite(v2)!)).toBe(v2);
    const key = b64(new Uint8Array(32).fill(7));
    const v1 = `MPX-${b64(new TextEncoder().encode(JSON.stringify({ r: 'wss://relais.exemple.fr', i: 'AAAAAAAAAAAAAAAAAAAAAA', k: key })))}`;
    expect(parseInvite(`voici : ${v1}`)).toEqual({ v: 1, relay: 'wss://relais.exemple.fr', room: 'AAAAAAAAAAAAAAAAAAAAAA', key });
    expect(inviteText(parseInvite(v1)!)).toBe(v1);
  });
});

describe('clés de séance', () => {
  it('même secret et même serveur : même salle et même clé ; un autre serveur change tout', async () => {
    const a = await deriveSession('K7Q2-9XFD', 'machine-a', 1000);
    const b = await deriveSession('k7q29xfd', 'machine-a', 1000);
    const c = await deriveSession('K7Q29XFD', 'machine-b', 1000);
    expect(a.room).toBe(b.room);
    expect(a.room).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(c.room).not.toBe(a.room);
    const iv = new Uint8Array(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, a.key, new TextEncoder().encode('salut'));
    expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, b.key, ct))).toBe('salut');
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, c.key, ct)).rejects.toThrow();
  });

  it('la salle n’est pas la clé : la clé ne sort pas de l’application', async () => {
    const s = await deriveSession('K7Q29XFD', 'machine-a', 1000);
    expect(s.key.extractable).toBe(false);
  });

  it('anciennes invitations : salle v2 inchangée', async () => {
    const d = await deriveLegacy({ v: 2, relay: 'wss://relais.exemple.fr', secret: 'q3Vb8xK2mT0wZr5L' });
    expect(d.room).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await deriveLegacy({ v: 2, relay: 'wss://x.fr', secret: 'q3Vb8xK2mT0wZr5L' })).room).toBe(d.room);
  });
});

describe('recherche du relais par le serveur Plex', () => {
  const server = {
    connections: [
      conn('https://192-168-1-10.abc.plex.direct:32400', { local: true }),
      conn('https://203-0-113-9.abc.plex.direct:32400'),
      conn('https://203-0-113-9.abc.plex.direct:8443', { relay: true }),
      conn('https://plex.exemple.fr:32400'),
      conn('http://relais.exemple.fr'),
      conn('https://203.0.113.9:443'),
    ],
  };

  it('candidats : noms publics en https seulement, chemin conventionnel puis racine', () => {
    expect(relayCandidates([server])).toEqual(['wss://plex.exemple.fr:32400/multiplex-relay', 'wss://plex.exemple.fr:32400', 'wss://plex.exemple.fr/multiplex-relay', 'wss://plex.exemple.fr']);
    expect(relayCandidates([{ connections: [conn('https://relais.exemple.fr')] }])).toEqual(['wss://relais.exemple.fr/multiplex-relay', 'wss://relais.exemple.fr']);
  });

  it('bornés et sans doublons', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ connections: [conn(`https://s${i}.exemple.fr`), conn(`https://s${i}.exemple.fr`)] }));
    const list = relayCandidates(many);
    expect(list).toHaveLength(16);
    expect(new Set(list).size).toBe(16);
  });

  it('l’hôte sait si ses amis trouveront son relais', () => {
    expect(relayDiscoverable('https://plex.exemple.fr/multiplex-relay/', [server])).toBe(true);
    expect(relayDiscoverable('relais.exemple.fr:1744', [server])).toBe(false);
    expect(relayDiscoverable('', [server])).toBe(false);
  });

  it('adresse de relais normalisée', () => {
    expect(relayUrl('https://relais.exemple.fr/')).toBe('wss://relais.exemple.fr');
    expect(relayUrl('relais.exemple.fr:1744')).toBe('wss://relais.exemple.fr:1744');
    expect(relayUrl('http://localhost:8787')).toBe('ws://localhost:8787');
    expect(relayUrl('ftp://x.fr')).toBe('');
  });

  it('rend le mieux classé des relais qui connaissent la salle, sans attendre les autres', async () => {
    const asked: string[] = [];
    const never = new Promise<never>(() => {});
    const answers: Record<string, () => Promise<unknown>> = {
      'wss://a': () => Promise.reject(new Error('injoignable')),
      'wss://b': () => Promise.resolve({ multiplex: 'relay', found: ['r2'] }),
      'wss://c': () => never,
    };
    const found = await findRoom(['wss://a', 'wss://b', 'wss://c'], ['r1', 'r2'], (relay, rooms) => {
      asked.push(`${relay}:${rooms.join(',')}`);
      return answers[relay]();
    });
    expect(found).toEqual({ relay: 'wss://b', room: 'r2' });
    expect(asked).toEqual(['wss://a:r1,r2', 'wss://b:r1,r2', 'wss://c:r1,r2']);
  });

  it('attend un mieux classé encore en route', async () => {
    let release!: (v: unknown) => void;
    const slow = new Promise((r) => (release = r));
    const p = findRoom(['wss://a', 'wss://b'], ['r1'], (relay) => (relay === 'wss://a' ? slow : Promise.resolve({ multiplex: 'relay', found: ['r1'] })));
    release({ multiplex: 'relay', found: ['r1'] });
    expect(await p).toEqual({ relay: 'wss://a', room: 'r1' });
  });

  it('ne retient pas ce qui n’est pas un relais MultiPlex, et ne le réinterroge pas', async () => {
    const known = new Map<string, boolean>();
    const ask = (relay: string) => Promise.resolve(relay === 'wss://plex' ? { MediaContainer: {} } : { multiplex: 'relay', found: [] });
    expect(await findRoom(['wss://plex', 'wss://relay'], ['r1'], ask, known)).toBeNull();
    expect(known.get('wss://plex')).toBe(false);
    expect(known.get('wss://relay')).toBe(true);
    const asked: string[] = [];
    await findRoom(['wss://plex', 'wss://relay'], ['r1'], (r) => (asked.push(r), ask(r)), known);
    expect(asked).toEqual(['wss://relay']);
  });

  it('rien à essayer : rien de trouvé', async () => {
    expect(await findRoom([], ['r1'], () => Promise.resolve({}))).toBeNull();
    expect(await findRoom(['wss://a'], [], () => Promise.resolve({}))).toBeNull();
  });
});
