import type { ClientInfo } from './types';

/**
 * Identité du client telle que Plex la lit. Le serveur compose la fiche « Lecteur » d'une session
 * (`Player` de /status/sessions : title, product, platform, device, model, version) à partir de ces
 * champs, qu'il reçoit en en-têtes ou, comme ici, en paramètres d'adresse : la documentation du
 * PMS (developer.plex.tv/pms, « Headers ») précise que tout en-tête X-Plex- peut aussi passer
 * dans la query string. Sans eux, le tableau de bord du serveur affiche « — » et une icône vide.
 *
 * Seuls les champs connus partent : un champ vide n'est pas envoyé.
 */
export function identityParams(c: ClientInfo): Record<string, string> {
  const all: [string, string | undefined][] = [
    ['X-Plex-Client-Identifier', c.clientId],
    ['X-Plex-Product', c.product],
    ['X-Plex-Version', c.version],
    ['X-Plex-Platform', c.platform],
    ['X-Plex-Platform-Version', c.platformVersion],
    ['X-Plex-Device', c.device],
    ['X-Plex-Model', c.model],
    ['X-Plex-Device-Vendor', c.vendor],
    ['X-Plex-Device-Name', c.deviceName],
  ];
  const out: Record<string, string> = {};
  for (const [k, v] of all) if (v) out[k] = v;
  return out;
}

/** Application MultiPlex qui tourne : chacune a son numéro de version (versions.json). */
export type ClientApp = 'desktop' | 'web' | 'android' | 'tv';

export interface ClientEnv {
  app: ClientApp;
  /** Numéro de version de cette application. */
  version: string;
  userAgent: string;
  /** Application de bureau : `process.platform` (win32, darwin, linux). */
  nativeOs?: string;
  /** Application de bureau : version du système (`process.getSystemVersion()`). */
  nativeOsVersion?: string;
  /** Android sans écran tactile (Android TV, Fire TV). */
  androidTv?: boolean;
}

/** Texte sûr pour un en-tête HTTP (ASCII imprimable, court). */
const clean = (s: string | undefined, max = 60): string | undefined => {
  const v = s?.replace(/[^\x20-\x7E]/g, '').trim().slice(0, max);
  return v || undefined;
};

const DESKTOP_OS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** Système d'après l'agent utilisateur du navigateur. */
export function osFromUserAgent(ua: string): string | undefined {
  if (/Web0S|webOS/i.test(ua)) return 'webOS';
  if (/Tizen/i.test(ua)) return 'Tizen';
  if (/Windows/.test(ua)) return 'Windows';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/CrOS/.test(ua)) return 'Chrome OS';
  if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return undefined;
}

/** Navigateur et numéro de version majeur d'après l'agent utilisateur. */
export function browserFromUserAgent(ua: string): { name: string; version?: string } {
  const rules: [RegExp, string][] = [
    [/(?:Firefox|FxiOS)\/(\d+)/, 'Firefox'],
    [/(?:Edg|EdgiOS|EdgA)\/(\d+)/, 'Microsoft Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/(?:Chrome|CriOS)\/(\d+)/, 'Chrome'],
    [/Version\/(\d+(?:\.\d+)?).*Safari\//, 'Safari'],
    [/Safari\//, 'Safari'],
  ];
  for (const [re, name] of rules) {
    const m = re.exec(ua);
    if (m) return { name, version: m[1] };
  }
  return { name: 'Chrome' };
}

/**
 * Modèle d'un appareil Android d'après l'agent utilisateur (« Pixel 7 », « SHIELD Android TV »).
 * Chrome réduit ce champ à « K » depuis Android 10 : il n'apprend alors rien, on l'ignore.
 */
export function androidModel(ua: string): string | undefined {
  const m = /Android [^;)]*;\s*([^;)]+?)(?:\s+Build\/[^;)]*)?\s*[;)]/.exec(ua);
  const model = m?.[1]?.trim();
  return model && model !== 'K' && !/^wv$/.test(model) ? clean(model) : undefined;
}

/**
 * Identité de cette application auprès de Plex (sans l'identifiant, propre à l'installation).
 * `platform` est le système ou l'environnement réel (Windows, macOS, Linux, Android, webOS,
 * Tizen) ; dans un navigateur, comme pour Plex Web, c'est le navigateur, et `device` le système.
 * `deviceName` est le nom lisible que montrent le tableau de bord du serveur et la liste des
 * appareils du compte : « MultiPlex (Windows) », « MultiPlex (Android TV) », « MultiPlex (Chrome) ».
 */
export function describeClient(env: ClientEnv): Omit<ClientInfo, 'clientId'> {
  const ua = env.userAgent ?? '';
  const base = { product: 'MultiPlex', version: env.version };
  const named = (label: string) => `MultiPlex (${label})`;

  if (env.app === 'desktop') {
    const os = DESKTOP_OS[env.nativeOs ?? ''] ?? osFromUserAgent(ua) ?? 'Desktop';
    return { ...base, platform: os, platformVersion: clean(env.nativeOsVersion), device: os, deviceName: named(os) };
  }

  if (env.app === 'android') {
    const model = androidModel(ua);
    return {
      ...base,
      platform: 'Android',
      platformVersion: clean(/Android (\d+(?:\.\d+)*)/.exec(ua)?.[1]),
      device: model ?? (env.androidTv ? 'Android TV' : 'Android'),
      model,
      deviceName: named(env.androidTv ? 'Android TV' : 'Android'),
    };
  }

  const os = osFromUserAgent(ua);
  if (os === 'webOS') return { ...base, platform: 'webOS', device: 'LG webOS TV', model: 'LG webOS TV', vendor: 'LG', deviceName: named('LG TV') };
  if (os === 'Tizen')
    return {
      ...base,
      platform: 'Tizen',
      platformVersion: clean(/Tizen (\d+(?:\.\d+)*)/.exec(ua)?.[1]),
      device: 'Samsung Smart TV',
      model: 'Samsung Smart TV',
      vendor: 'Samsung',
      deviceName: named('Samsung TV'),
    };

  // Navigateur (ou téléviseur non reconnu) : la plateforme est le navigateur, comme pour Plex Web.
  const browser = browserFromUserAgent(ua);
  return { ...base, platform: browser.name, platformVersion: browser.version, device: os ?? 'Web', deviceName: named(browser.name) };
}
