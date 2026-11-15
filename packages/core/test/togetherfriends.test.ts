// Séances visibles par les amis, côté application : quel jeton part (jamais celui du compte),
// recherche du relais, et remise de la clé par l'hôte (ECDH éphémère).
import { describe, expect, it } from 'vitest';
import { deriveSession, findRelay, grantRequestKeys, isFriendsAnswer, openGrant, sealGrant, serverCredential } from '../src';

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
      'wss://a.exemple.fr': { multiplex: 'relay', found: [], friends: true },
      'wss://b.exemple.fr': { multiplex: 'relay', found: [] },
    };
    const known = new Map<string, boolean>();
    const ask = (r: string) => Promise.resolve(answers[r]);
    expect(await findRelay(Object.keys(answers), ask, known)).toEqual({ relay: 'wss://a.exemple.fr', friends: true });
    expect(known.get('wss://a.exemple.fr/multiplex-relay')).toBeUndefined();
    expect(await findRelay(['wss://b.exemple.fr'], ask)).toEqual({ relay: 'wss://b.exemple.fr', friends: false });
    expect(await findRelay(['wss://nope.exemple.fr'], () => Promise.resolve({ hello: 1 }))).toBeNull();
  });

  it('réponse de liste reconnue', () => {
    expect(isFriendsAnswer({ multiplex: 'relay', server: 'abc', ticket: 't', ttl: 120, sessions: [] })).toBe(true);
    expect(isFriendsAnswer({ multiplex: 'relay', found: [] })).toBe(false);
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
