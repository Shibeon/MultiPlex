// Mise à jour à chaud de l'app de bureau (voir apps/desktop/boot.cjs).
//
//   node scripts/hot-bundle.mjs
//
// À lancer dans apps/desktop/.. avant electron-builder, après `pnpm build` (build web) :
//  1. écrit apps/desktop/base.json : la clé de la « base » (Electron, dépendances, mpv,
//     configuration d'empaquetage…), embarquée dans l'app installée ;
//  2. fabrique apps/desktop/hot-out/MultiPlex-hot-<version>-<os>.asar : le code de l'app
//     (fichiers .cjs) et l'interface web, sans node_modules ni Electron ni mpv ;
//  3. écrit apps/desktop/hot-out/hot-<os>.json : version, étiquette, clé de base, empreinte.
//
// Une app installée télécharge le paquet seulement si sa propre clé est identique : tout
// changement de la base passe par la mise à jour complète.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps', 'desktop');
const web = join(root, 'apps', 'web', 'dist');
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
const version = pkg.version;

if (!existsSync(join(web, 'index.html'))) {
  console.error('Build web introuvable : lancez `pnpm build` avant.');
  process.exit(1);
}

const req = createRequire(join(desktop, 'package.json'));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const fileHash = (f) => (existsSync(f) ? sha(readFileSync(f)) : 'absent');

/** Dépendances de production de la coque, versions exactes, récursivement. */
function deps(name, from, seen = new Map()) {
  let file;
  try {
    file = createRequire(from).resolve(`${name}/package.json`);
  } catch {
    seen.set(name, 'introuvable');
    return seen;
  }
  const p = JSON.parse(readFileSync(file, 'utf8'));
  const id = `${name}@${p.version}`;
  if (seen.has(id)) return seen;
  seen.set(id, true);
  for (const d of Object.keys(p.dependencies ?? {})) deps(d, file, seen);
  return seen;
}
const tree = new Map();
for (const d of Object.keys(pkg.dependencies ?? {})) deps(d, join(desktop, 'package.json'), tree);

// Ce qui ne voyage pas dans le paquet à chaud : s'il change, il faut une installation complète.
const { publish, releaseInfo, files, ...buildConfig } = pkg.build;
const base = {
  os,
  arch: process.arch,
  electron: JSON.parse(readFileSync(req.resolve('electron/package.json'), 'utf8')).version,
  deps: [...tree.keys()].sort(),
  build: buildConfig,
  unpacked: (pkg.build.asarUnpack ?? []).map((f) => [f, fileHash(join(desktop, f))]),
  mpv: fileHash(join(desktop, 'vendor', 'mpv', 'VERSION')),
  faceApi: (() => {
    try {
      return JSON.parse(readFileSync(createRequire(join(root, 'apps', 'web', 'package.json')).resolve('@vladmandic/face-api/package.json'), 'utf8')).version;
    } catch {
      return 'absent';
    }
  })(),
};
const key = sha(JSON.stringify(base));
writeFileSync(join(desktop, 'base.json'), JSON.stringify({ key, version }, null, 2));

// Paquet : les fichiers de la coque (sauf node_modules et la clé de base) + l'interface web.
const stage = join(desktop, 'hot-out', 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of files) {
  if (f.startsWith('node_modules') || f === 'base.json' || f === 'boot.cjs') continue;
  cpSync(join(desktop, f), join(stage, f));
}
cpSync(web, join(stage, 'web'), { recursive: true });

// @electron/asar vient avec electron-builder (même outil que pour l'archive de l'app).
const builderReq = createRequire(req.resolve('electron-builder'));
const asar = createRequire(builderReq.resolve('app-builder-lib')).resolve('@electron/asar');
const { createPackage } = await import(pathToFileURL(asar).href).then((m) => m.default ?? m);
const file = `MultiPlex-hot-${version}-${os}.asar`;
const out = join(desktop, 'hot-out', file);
await createPackage(stage, out);
rmSync(stage, { recursive: true, force: true });

const data = readFileSync(out);
const notesFile = join(desktop, 'release-notes.txt');
writeFileSync(
  join(desktop, 'hot-out', `hot-${os}.json`),
  JSON.stringify({
    version,
    tag: `v${version}`,
    base: key,
    file,
    size: data.length,
    sha512: createHash('sha512').update(data).digest('base64'),
    notes: existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : '',
  }),
);
console.log(`Paquet à chaud ${file} (${(data.length / 1e6).toFixed(1)} Mo), base ${key.slice(0, 12)}.`);
