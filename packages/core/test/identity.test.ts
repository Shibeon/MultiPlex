import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlexServer, describeClient, identityHeaders, identityParams, type ClientInfo } from '../src';

/**
 * Identité du client : le serveur compose la fiche « Lecteur » de son tableau de bord (produit,
 * plateforme, appareil, nom) à partir des X-Plex-* de chaque requête. Faux PMS : il valide ce que
 * nous envoyons, pas l'affichage d'un vrai serveur.
 */
const client: ClientInfo = {
  clientId: 'cid',
  product: 'MultiPlex',
  version: '9.8.7',
  platform: 'Android',
  platformVersion: '14',
  device: 'Pixel 7',
  model: 'Pixel 7',
  deviceName: 'MultiPlex (Android)',
};
const TOKEN = 'secret-token';
const log: { path: string; q: URLSearchParams; headers: Record<string, unknown> }[] = [];
const movie = {
  ratingKey: '10',
  type: 'movie',
  title: 'Film',
  duration: 6000000,
  Media: [{ id: 1, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', Part: [{ id: 77, key: '/library/parts/77/1/file.mp4', container: 'mp4', Stream: [] }] }],
};
const routes: Record<string, () => unknown> = {
  '/library/sections': () => ({ Directory: [] }),
  '/video/:/transcode/universal/decision': () => ({ generalDecisionCode: 1000, Metadata: [{ Media: [{ Part: [{ Stream: [{ streamType: 1, decision: 'transcode' }] }] }] }] }),
};

let http: Server;
let srv: PlexServer;
let base = '';
beforeAll(async () => {
  http = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    log.push({ path: url.pathname, q: url.searchParams, headers: req.headers });
    const route = routes[url.pathname];
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ MediaContainer: route ? route() : {} }));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  srv = new PlexServer('id', 'Test', base, TOKEN, client);
});
afterAll(() => new Promise((r) => http.close(r)));
const last = () => log[log.length - 1];
const pick = (q: URLSearchParams, keys: string[]) => Object.fromEntries(keys.map((k) => [k, q.get(k)]));
const FULL = ['X-Plex-Client-Identifier', 'X-Plex-Product', 'X-Plex-Version', 'X-Plex-Platform', 'X-Plex-Platform-Version', 'X-Plex-Device', 'X-Plex-Model', 'X-Plex-Device-Name'];

describe('identité envoyée au serveur', () => {
  it('chaque requête porte l’identité complète, en paramètres (pas de pré-requête CORS)', async () => {
    await srv.libraries();
    expect(pick(last().q, FULL)).toEqual({
      'X-Plex-Client-Identifier': 'cid',
      'X-Plex-Product': 'MultiPlex',
      'X-Plex-Version': '9.8.7',
      'X-Plex-Platform': 'Android',
      'X-Plex-Platform-Version': '14',
      'X-Plex-Device': 'Pixel 7',
      'X-Plex-Model': 'Pixel 7',
      'X-Plex-Device-Name': 'MultiPlex (Android)',
    });
    expect(last().q.get('X-Plex-Token')).toBe(TOKEN);
    // Champ inconnu : rien d'envoyé plutôt qu'une valeur vide.
    expect(last().q.has('X-Plex-Device-Vendor')).toBe(false);
    expect(Object.keys(last().headers).filter((h) => h.startsWith('x-plex'))).toEqual([]);
  });

  it('progression de lecture et fichier lu directement : sous notre nom', async () => {
    await srv.timeline({ ratingKey: '10', state: 'playing', timeMs: 1, durationMs: 2, session: 's1' });
    expect(pick(last().q, ['X-Plex-Device-Name', 'X-Plex-Product', 'X-Plex-Platform', 'X-Plex-Session-Identifier'])).toEqual({
      'X-Plex-Device-Name': 'MultiPlex (Android)',
      'X-Plex-Product': 'MultiPlex',
      'X-Plex-Platform': 'Android',
      'X-Plex-Session-Identifier': 's1',
    });
    const plan = await srv.playback(movie, { quality: 'original', canPlay: () => true, forceTranscode: false });
    expect(plan.mode).toBe('direct');
    expect(pick(new URL(plan.url).searchParams, FULL)).toEqual(pick(last().q, FULL));
    // Lecteur natif / téléchargement : en-têtes, jeton compris, et l'adresse reste nue.
    const file = srv.fileRequest('/library/parts/77/1/file.mkv');
    expect(file.url).toBe(`${base}/library/parts/77/1/file.mkv`);
    expect(file.headers).toEqual({ ...identityParams(client), 'X-Plex-Token': TOKEN });
  });

  it('un paramètre de l’appelant l’emporte ; jeton et identifiant restent les nôtres', async () => {
    await srv.related('10', 'en');
    expect(last().q.get('X-Plex-Language')).toBe('en');
    // Conversion : plateforme / appareil du profil choisi par transcodeParams, sans indices
    // supplémentaires (version du système, modèle) ; le nom lisible part quand même.
    const plan = await srv.playback(movie, { quality: '4000', canPlay: () => true });
    for (const q of [last().q, new URL(plan.url).searchParams]) {
      expect(pick(q, ['X-Plex-Platform', 'X-Plex-Device', 'X-Plex-Version', 'X-Plex-Client-Identifier', 'X-Plex-Device-Name'])).toEqual({
        'X-Plex-Platform': 'MultiPlex',
        'X-Plex-Device': 'Windows',
        'X-Plex-Version': '9.8.7',
        'X-Plex-Client-Identifier': 'cid',
        'X-Plex-Device-Name': 'MultiPlex (Android)',
      });
      expect([q.has('X-Plex-Platform-Version'), q.has('X-Plex-Model')]).toEqual([false, false]);
      expect(q.getAll('X-Plex-Platform')).toHaveLength(1);
    }
    await srv.stopTranscode(plan.session);
    expect(last().q.get('X-Plex-Device-Name')).toBe('MultiPlex (Android)');
  });

  it('images : jeton et identifiant seulement (adresse stable d’une version à l’autre, pour le cache)', () => {
    const q = new URL(srv.image('/library/metadata/10/thumb/1', 320, 480)).searchParams;
    expect([q.get('X-Plex-Token'), q.get('X-Plex-Client-Identifier'), q.has('X-Plex-Version'), q.has('X-Plex-Device-Name')]).toEqual([TOKEN, 'cid', false, false]);
    const thumb = new URL(srv.previewThumbUrl(77, 1000)).searchParams;
    expect([thumb.get('X-Plex-Token'), thumb.has('X-Plex-Version')]).toEqual([TOKEN, false]);
  });

  it('plex.tv reçoit la même identité, en en-têtes', () => {
    expect(identityHeaders(client, 't')).toEqual({ ...identityParams(client), 'X-Plex-Token': 't' });
    expect(identityHeaders(client)['X-Plex-Platform-Version']).toBe('14');
  });
});

const UA = {
  chromeWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  electronMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) MultiPlex/0.1.33 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  webview: 'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A.240205.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36',
  shield: 'Mozilla/5.0 (Linux; Android 11; SHIELD Android TV Build/RQ1A.210105.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Safari/537.36',
  reduced: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  webos: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36 WebAppManager',
  tizen: 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36',
};

describe('describeClient', () => {
  const v = '1.2.3';
  it('bureau : le système réel, d’après Electron', () => {
    expect(describeClient({ app: 'desktop', version: v, userAgent: UA.chromeWin, nativeOs: 'win32', nativeOsVersion: '10.0.22631' })).toEqual({
      product: 'MultiPlex',
      version: v,
      platform: 'Windows',
      platformVersion: '10.0.22631',
      device: 'Windows',
      deviceName: 'MultiPlex (Windows)',
    });
    expect(describeClient({ app: 'desktop', version: v, userAgent: UA.electronMac, nativeOs: 'darwin' })).toMatchObject({ platform: 'macOS', deviceName: 'MultiPlex (macOS)' });
    expect(describeClient({ app: 'desktop', version: v, userAgent: '', nativeOs: 'linux' })).toMatchObject({ platform: 'Linux', deviceName: 'MultiPlex (Linux)' });
  });

  it('Android : version du système, modèle, Android TV', () => {
    expect(describeClient({ app: 'android', version: v, userAgent: UA.webview })).toEqual({
      product: 'MultiPlex',
      version: v,
      platform: 'Android',
      platformVersion: '14',
      device: 'Pixel 7',
      model: 'Pixel 7',
      deviceName: 'MultiPlex (Android)',
    });
    expect(describeClient({ app: 'android', version: v, userAgent: UA.shield, androidTv: true })).toMatchObject({
      platform: 'Android',
      platformVersion: '11',
      model: 'SHIELD Android TV',
      deviceName: 'MultiPlex (Android TV)',
    });
    // Modèle masqué par Chrome (« K ») : rien d'inventé.
    expect(describeClient({ app: 'android', version: v, userAgent: UA.reduced, androidTv: true })).toMatchObject({ device: 'Android TV', model: undefined });
  });

  it('navigateur : le navigateur comme plateforme, le système comme appareil', () => {
    expect(describeClient({ app: 'web', version: v, userAgent: UA.chromeWin })).toMatchObject({ platform: 'Chrome', platformVersion: '131', device: 'Windows', deviceName: 'MultiPlex (Chrome)' });
    expect(describeClient({ app: 'web', version: v, userAgent: UA.safariIos })).toMatchObject({ platform: 'Safari', platformVersion: '17.5', device: 'iOS', deviceName: 'MultiPlex (Safari)' });
    expect(describeClient({ app: 'web', version: v, userAgent: UA.firefoxLinux })).toMatchObject({ platform: 'Firefox', device: 'Linux', deviceName: 'MultiPlex (Firefox)' });
  });

  it('téléviseurs : webOS et Tizen', () => {
    expect(describeClient({ app: 'tv', version: v, userAgent: UA.webos })).toMatchObject({ platform: 'webOS', vendor: 'LG', deviceName: 'MultiPlex (LG TV)' });
    expect(describeClient({ app: 'tv', version: v, userAgent: UA.tizen })).toMatchObject({ platform: 'Tizen', platformVersion: '6.0', vendor: 'Samsung', deviceName: 'MultiPlex (Samsung TV)' });
  });

  it('les valeurs restent sûres pour un en-tête', () => {
    const c = describeClient({ app: 'desktop', version: v, userAgent: '', nativeOs: 'linux', nativeOsVersion: '6.1\r\nX-Evil: 1' });
    expect(c.platformVersion).toBe('6.1X-Evil: 1');
    expect(Object.values(c).every((x) => x === undefined || /^[\x20-\x7E]*$/.test(x))).toBe(true);
  });
});

describe('version de l’application', () => {
  it('l’app web lit la sienne dans versions.json, jamais un numéro écrit en dur', () => {
    const store = readFileSync(new URL('../../../apps/web/src/store.ts', import.meta.url), 'utf8');
    const platform = readFileSync(new URL('../../../apps/web/src/platform.ts', import.meta.url), 'utf8');
    expect(store).not.toMatch(/version:\s*['"]\d/);
    expect(store).toMatch(/version:\s*VERSION/);
    expect(platform).toMatch(/import versions from '..\/..\/..\/versions\.json'/);
    expect(platform).toMatch(/versions as Record<string, string>\)\[platform\]/);
  });
});
