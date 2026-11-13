// Télécharge mpv pour Windows dans apps/desktop/vendor/mpv (non versionné).
// mpv est le lecteur natif de l'application de bureau : il lit le fichier
// d'origine sans passer par la conversion du serveur.
//
// Source : builds de shinchiro, ceux que référence mpv.io pour Windows.
// mpv est distribué sous GPL v2+ ; il est lancé comme programme séparé.
// Usage : node scripts/fetch-mpv.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('Hors Windows : installez mpv avec le gestionnaire de paquets du système, il sera trouvé dans le PATH.');
  process.exit(0);
}

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'vendor', 'mpv');
if (existsSync(join(dest, 'mpv.exe')) && !process.argv.includes('--force')) {
  console.log(`mpv déjà présent : ${dest} (--force pour le remplacer)`);
  process.exit(0);
}

// Version figée : mpv fait partie de la « base » de l'app (voir scripts/hot-bundle.mjs). La
// changer impose une mise à jour complète ; la garder permet les mises à jour à chaud.
// Pour passer à un mpv plus récent : changer MPV_TAG (une publication de shinchiro).
const MPV_TAG = '20261111';
const api = `https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/tags/${MPV_TAG}`;
const get = async (url) => {
  const r = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  return r.ok ? r.json() : null;
};
let release = await get(api);
if (!release?.assets) {
  // Publication retirée : la plus récente, mais la base change (prochaine mise à jour complète).
  console.warn(`::warning::mpv ${MPV_TAG} introuvable : dernière version utilisée (la mise à jour suivante sera complète, pas à chaud).`);
  release = await get('https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest');
}
// Build x86-64 de base : tourne sur tous les processeurs 64 bits (la variante « v3 » exige AVX2).
const asset = release.assets?.find((a) => /^mpv-x86_64-\d{8}-git-.*\.7z$/.test(a.name));
if (!asset) throw new Error(`Archive mpv introuvable dans la publication ${MPV_TAG}`);

console.log(`Téléchargement de ${asset.name} (${(asset.size / 1e6).toFixed(0)} Mo)…`);
const res = await fetch(asset.browser_download_url);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const data = Buffer.from(await res.arrayBuffer());
if (data.length !== asset.size) throw new Error('Téléchargement incomplet');

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
const archive = join(dest, asset.name);
writeFileSync(archive, data);
// Le tar de Windows (bsdtar) sait lire le format 7z.
execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', dest], { stdio: 'inherit' });
rmSync(archive);
writeFileSync(join(dest, 'VERSION'), `${release.tag_name}\n${asset.name}\n`);
if (!existsSync(join(dest, 'mpv.exe'))) throw new Error('mpv.exe absent après extraction');
console.log(`mpv ${release.tag_name} installé dans ${dest}`);
