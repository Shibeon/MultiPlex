// Séances visibles par les amis, côté application : quel jeton part (jamais celui du compte),
// recherche du relais, et remise de la clé par l'hôte (ECDH éphémère).
import { describe, expect, it } from 'vitest';
import { deriveSession, findRelay, friendAllowList, friendsForAnnounce, grantRequestKeys, hostYields, isFriendsAnswer, MAX_FRIEND_ALLOW, openGrant, parsePlexFriends, RelayBackoff, sealGrant, serverCredential } from '../src';

describe('jeton présenté au relais', () => {
  it('le jeton propre au serveur, jamais celui du compte', () => {
    expect(serverCredential({ accessToken: 'srv-token' }, 'account-token')).toBe('srv-token');
    expect(serverCredential({ accessToken: 'account-token' }, 'account-token')).toBeNull();
    expect(serverCredential({ accessToken: '' }, 'account-token')).toBeNull();
  });
});

describe('recherche du relais d’un serveur', () => {
  it('rend le mieux classé qui répond comme un relais, et dit s’il liste les séances', async () => {
    const answers: Record<string, unknown> = {
      'wss://a.exemple.fr/multiplex-relay': Promise.reject(new Error('404')),
      'wss://a.exemple.fr': { multiplex: 'relay', found: [], friends: true, friendsOnly: true },
      'wss://b.exemple.fr': { multiplex: 'relay', found: [] },
    };
    const known = new Map<string, boolean>();
    const ask = (r: string) => Promise.resolve(answers[r]);
    expect(await findRelay(Object.keys(answers), ask, { known })).toEqual({ relay: 'wss://a.exemple.fr', friends: true, server: undefined });
    expect(known.get('wss://a.exemple.fr/multiplex-relay')).toBeUndefined();
    expect(await findRelay(['wss://b.exemple.fr'], ask)).toEqual({ relay: 'wss://b.exemple.fr', friends: false, server: undefined });
    expect(await findRelay(['wss://nope.exemple.fr'], () => Promise.resolve({ hello: 1 }))).toBeNull();
  });

  it('réponse de liste reconnue', () => {
    expect(isFriendsAnswer({ multiplex: 'relay', server: 'abc', ticket: 't', ttl: 120, sessions: [] })).toBe(true);
    expect(isFriendsAnswer({ multiplex: 'relay', found: [] })).toBe(false);
  });
});

describe('liste d’amis jointe à l’annonce', () => {
  // Réponse de plex.tv à GET /api/users/ (XML, éléments User comme les lit python-plexapi).
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer friendlyName="myPlex" identifier="com.plexapp.plugins.myplex" size="4">
  <User id="2001" title="Camille" username="camille" email="camille@exemple.fr" thumb="https://plex.tv/users/a/avatar" home="0">
    <Server id="7" serverId="9" machineIdentifier="srv-1" name="nas" lastSeenAt="1" numLibraries="2" allLibraries="0" owned="1" pending="0"/>
  </User>
  <User id="2004" title="L&#233;a &amp; co" username="" thumb="" home="1"/>
  <User id="abc" title="Illisible"/>
  <User id="2001" title="Camille (doublon)"/>
</MediaContainer>`;

  it('lit les amis de plex.tv : numéro de compte, nom, pseudo, avatar', () => {
    expect(parsePlexFriends(xml)).toEqual([
      { id: '2001', name: 'Camille', username: 'camille', thumb: 'https://plex.tv/users/a/avatar' },
      { id: '2004', name: 'Léa & co', username: undefined, thumb: undefined },
      { id: '2001', name: 'Camille (doublon)', username: undefined, thumb: undefined },
    ]);
    expect(parsePlexFriends('<MediaContainer size="0"/>')).toEqual([]);
    expect(parsePlexFriends('pas du XML')).toEqual([]);
  });

  it('seulement les numéros de compte, sans doublon ni soi-même, bornés', () => {
    expect(friendAllowList(parsePlexFriends(xml))).toEqual(['2001', '2004']);
    expect(friendAllowList(parsePlexFriends(xml), 2004)).toEqual(['2001']);
    expect(friendAllowList(parsePlexFriends(xml), '2001')).toEqual(['2004']);
    expect(friendAllowList([{ id: '0' }, { id: '-3' }, { id: '12.5' }, { id: '0042' }])).toEqual(['42']);
    expect(friendAllowList([])).toEqual([]);
    const many = Array.from({ length: MAX_FRIEND_ALLOW + 50 }, (_, i) => ({ id: String(i + 1) }));
    expect(friendAllowList(many)).toHaveLength(MAX_FRIEND_ALLOW);
  });

  it('plex.tv muet au rafraîchissement : aucune liste périmée, l’annonce est libérée', () => {
    expect(friendsForAnnounce(null, { ids: '2001,2004', at: 5 }, 5)).toBeNull();
  });

  it('liste renvoyée quand elle change ou vient d’être relue, pas à chaque rafraîchissement', () => {
    const sent = { ids: '2001', at: 10 };
    expect(friendsForAnnounce(['2001'], sent, 10)).toEqual({ sent });
    expect(friendsForAnnounce(['2001'], sent, 20)).toEqual({ friends: ['2001'], sent: { ids: '2001', at: 20 } });
    expect(friendsForAnnounce([], sent, 10)).toEqual({ friends: [], sent: { ids: '', at: 10 } });
  });

  it('un ami retiré de plex.tv disparaît de la liste suivante', () => {
    const before = friendAllowList(parsePlexFriends(xml));
    const after = friendAllowList(parsePlexFriends(xml.replace(/<User id="2004"[^>]*\/>/, '')));
    expect(before).toContain('2004');
    expect(after).toEqual(['2001']);
  });
});

describe('remise de la clé à un ami autorisé', () => {
  it('l’ami seul l’ouvre, et en tire la salle listée et la clé de la séance', async () => {
    const host = await deriveSession('K7Q29XFD', 'server-1', 1000);
    const req = await grantRequestKeys();
    const sealed = await sealGrant(req.pub, { secret: 'K7Q29XFD', server: 'server-1', state: { time: 61, playing: true, c: 3, by: 'h' } });
    const got = await openGrant(req.priv, req.pub, sealed.pub, sealed.box);
    expect(got.state).toEqual({ time: 61, playing: true, c: 3, by: 'h' });
    const friend = await deriveSession(got.secret, got.server, 1000);
    expect(friend.room).toBe(host.room);
    // Un autre (le relais, par exemple, qui substituerait sa clé) ne l'ouvre pas.
    const other = await grantRequestKeys();
    await expect(openGrant(other.priv, other.pub, sealed.pub, sealed.box)).rejects.toThrow();
    // Une remise abîmée est refusée.
    const bad = sealed.box.slice(0, -4) + (sealed.box.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await expect(openGrant(req.priv, req.pub, sealed.pub, bad)).rejects.toThrow();
  });
});

describe('relais d’un serveur : identifiant comparé avant tout jeton, échecs mis de côté', () => {
  it('écarte un relais qui ne sait pas lister ou dont le Plex n’est pas ce serveur', async () => {
    const answers: Record<string, unknown> = {
      'wss://a.exemple.fr': { multiplex: 'relay', found: [], friends: true, server: 'autre-serveur' },
      'wss://b.exemple.fr': { multiplex: 'relay', found: [], friends: false },
      // Relais plus ancien : il liste les séances à tout utilisateur du serveur. Écarté.
      'wss://old.exemple.fr': { multiplex: 'relay', found: [], friends: true, server: 'srv-1' },
      'wss://c.exemple.fr': { multiplex: 'relay', found: [], friends: true, friendsOnly: true, server: 'srv-1' },
    };
    const ask = (r: string) => Promise.resolve(answers[r]);
    expect(await findRelay(Object.keys(answers), ask, { server: 'srv-1' })).toEqual({ relay: 'wss://c.exemple.fr', friends: true, server: 'srv-1' });
    expect(await findRelay(['wss://a.exemple.fr', 'wss://b.exemple.fr', 'wss://old.exemple.fr'], ask, { server: 'srv-1' })).toBeNull();
    expect(await findRelay(['wss://old.exemple.fr'], ask)).toEqual({ relay: 'wss://old.exemple.fr', friends: false, server: 'srv-1' });
  });

  it('un relais injoignable ou inutile n’est pas redemandé avant la fin de son délai, qui s’allonge', async () => {
    let t = 0;
    const backoff = new RelayBackoff(() => t, 60_000, 3_600_000);
    let asked = 0;
    const ask = () => {
      asked++;
      return Promise.reject(new Error('injoignable'));
    };
    expect(await findRelay(['wss://x.exemple.fr'], ask, { backoff })).toBeNull();
    expect(await findRelay(['wss://x.exemple.fr'], ask, { backoff })).toBeNull();
    expect(asked).toBe(1);
    t += 60_001;
    expect(await findRelay(['wss://x.exemple.fr'], ask, { backoff })).toBeNull();
    expect(asked).toBe(2);
    t += 60_001; // le délai a doublé : pas encore
    expect(await findRelay(['wss://x.exemple.fr'], ask, { backoff })).toBeNull();
    expect(asked).toBe(2);
    t += 60_001;
    const ok = () => Promise.resolve({ multiplex: 'relay', found: [], friends: true, friendsOnly: true, server: 's' });
    expect(await findRelay(['wss://x.exemple.fr'], ok, { backoff, server: 's' })).toEqual({ relay: 'wss://x.exemple.fr', friends: true, server: 's' });
    expect(backoff.blocked('wss://x.exemple.fr')).toBe(false);
  });
});

describe('preuve d’hôte présentée au relais', () => {
  it('tirée du secret et du serveur, stable, distincte de la salle', async () => {
    const a = await deriveSession('K7Q29XFD', 'server-1', 1000);
    const b = await deriveSession('k7q2-9xfd', 'server-1', 1000);
    const c = await deriveSession('K7Q29XFD', 'server-2', 1000);
    expect(a.owner).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(b.owner).toBe(a.owner);
    expect(c.owner).not.toBe(a.owner);
    expect(a.owner).not.toBe(a.room);
  });
});

describe('deux hôtes après une coupure', () => {
  it('un seul reste hôte : la prise de main la plus récente (puis l’identifiant) l’emporte', () => {
    const back = { hc: 0, id: 'a-original' };
    const took = { hc: 7, id: 'b-relayed' };
    expect(hostYields(back, took)).toBe(true);
    expect(hostYields(took, back)).toBe(false);
    const x = { hc: 3, id: 'x' };
    const y = { hc: 3, id: 'y' };
    expect(hostYields(x, y) !== hostYields(y, x)).toBe(true);
  });
});
