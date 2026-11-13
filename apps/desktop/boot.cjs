// Point d'entrée de l'app de bureau : choisit le code à lancer.
//
// Mise à jour « à chaud » : la plupart des versions ne changent que le code de l'app (ce
// dossier et l'interface web), pas Electron ni mpv. Ce code se télécharge pendant que MultiPlex
// est ouvert, dans le dossier de l'utilisateur (updater.cjs), et « Redémarrer » relance
// simplement l'app, qui part d'ici sur la nouvelle version — rien à installer.
//
// Le code à chaud n'est lancé que s'il a été construit pour cette base exacte (même Electron,
// mêmes dépendances, même mpv : `base.json`, écrit à la compilation) et s'il est plus récent
// que la version installée. S'il plante deux fois au démarrage, on revient au code installé.
const { app } = require('electron');
const path = require('node:path');
// original-fs : le dossier des mises à jour, où un .asar doit rester un simple fichier ;
// node:fs : ce qui est dans l'archive de l'app (base.json).
const fs = require('original-fs');
const asarFs = require('node:fs');

const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).split('.').map((n) => Number(n) || 0));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/** Clé de compatibilité de la base installée (absente en développement). */
function baseKey() {
  try {
    return JSON.parse(asarFs.readFileSync(path.join(__dirname, 'base.json'), 'utf8')).key || '';
  } catch {
    return '';
  }
}

function pickHot() {
  if (!app.isPackaged || process.argv.includes('--no-hot') || process.argv.some((a) => a.startsWith('--smoke'))) return null;
  const dir = path.join(app.getPath('userData'), 'hot');
  const marker = path.join(dir, 'current.json');
  let cur;
  try {
    cur = JSON.parse(fs.readFileSync(marker, 'utf8'));
  } catch {
    return null;
  }
  const key = baseKey();
  const file = typeof cur?.file === 'string' ? path.join(dir, path.basename(cur.file)) : '';
  // Base mise à jour depuis (installation complète), ou code prévu pour une autre base : on l'oublie.
  if (!key || cur.base !== key || !newer(cur.version, app.getVersion()) || !file || !fs.existsSync(file)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  // Deux démarrages ratés de suite (voir hotBooted dans updater.cjs) : on reste sur la base.
  if ((cur.tries ?? 0) >= 2) return null;
  try {
    fs.writeFileSync(marker, JSON.stringify({ ...cur, tries: (cur.tries ?? 0) + 1 }));
  } catch {
    return null;
  }
  return { file, version: String(cur.version) };
}

const hot = pickHot();
if (hot) {
  // Les dépendances (electron-updater…) restent celles de la base : la clé garantit qu'elles n'ont pas changé.
  process.env.NODE_PATH = [path.join(__dirname, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  require('node:module')._initPaths();
  global.multiplexHot = { version: hot.version, base: app.getVersion(), file: hot.file };
  // Toute l'app (et electron-updater) voit le numéro de la version réellement lancée.
  app.getVersion = () => hot.version;
  require(path.join(hot.file, 'main.cjs'));
} else {
  require('./main.cjs');
}
