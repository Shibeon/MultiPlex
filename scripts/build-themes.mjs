// Rassemble les thèmes de la communauté (themes/*.json) en un seul fichier
// embarqué par l'application. Lancé automatiquement avant `dev`, `build` et
// `typecheck` du paquet web. Échoue si un thème est mal formé, pour qu'une
// contribution invalide soit repérée avant d'arriver dans l'app.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'themes');
const target = join(root, 'apps', 'web', 'src', 'gallery', 'themes.json');

const REQUIRED = ['--bg', '--surface', '--surface-2', '--text', '--muted', '--accent'];
const ALLOWED = [...REQUIRED, '--on-accent', '--backdrop-opacity'];
const COLOR = /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s/]{1,40}\))$/;

const themes = [];
const errors = [];
for (const file of readdirSync(source).filter((f) => f.endsWith('.json')).sort()) {
  const fail = (msg) => errors.push(`${file} : ${msg}`);
  let theme;
  try {
    theme = JSON.parse(readFileSync(join(source, file), 'utf8'));
  } catch (e) {
    fail(`JSON invalide (${e.message})`);
    continue;
  }
  if (theme.id !== file.replace(/\.json$/, '')) fail(`« id » doit valoir le nom du fichier (${file.replace(/\.json$/, '')})`);
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(theme.id ?? '')) fail('« id » : minuscules, chiffres et tirets, 2 à 40 caractères');
  if (typeof theme.name !== 'string' || !theme.name.trim()) fail('« name » manquant');
  if (!theme.vars || typeof theme.vars !== 'object') fail('« vars » manquant');
  else {
    for (const key of REQUIRED) if (!theme.vars[key]) fail(`couleur ${key} manquante`);
    for (const [key, value] of Object.entries(theme.vars)) {
      if (!ALLOWED.includes(key)) fail(`variable inconnue ${key}`);
      else if (key !== '--backdrop-opacity' && !COLOR.test(String(value))) fail(`${key} : couleur attendue (#rrggbb, rgb(), hsl()), reçu « ${value} »`);
    }
  }
  if (theme.image !== undefined) {
    // L'illustration est un fichier voisin (themes/<id>.webp|jpg|png), incorporé au thème
    // sous forme de données : aucune adresse en ligne n'est admise.
    const m = /^([a-z0-9-]+)\.(webp|jpg|jpeg|png)$/.exec(String(theme.image));
    const path = m && join(source, theme.image);
    if (!m || m[1] !== theme.id) fail(`« image » doit être un fichier voisin nommé ${theme.id}.webp, .jpg ou .png`);
    else if (!existsSync(path)) fail(`image introuvable : ${theme.image}`);
    else {
      const data = readFileSync(path);
      if (data.length > 200 * 1024) fail(`image trop lourde (${Math.round(data.length / 1024)} Ko, 200 Ko au plus)`);
      if (typeof theme.imageCredit !== 'string' || !theme.imageCredit.trim()) fail('« imageCredit » obligatoire avec une image (auteur et licence)');
      const mime = m[2] === 'webp' ? 'image/webp' : m[2] === 'png' ? 'image/png' : 'image/jpeg';
      theme.image = `data:${mime};base64,${data.toString('base64')}`;
    }
  }
  if (theme.effect !== undefined && !['aura', 'cadre'].includes(theme.effect)) fail(`« effect » inconnu : ${theme.effect} (aura, cadre)`);
  if (themes.some((t) => t.id === theme.id)) fail(`identifiant en double : ${theme.id}`);
  themes.push(theme);
}

if (errors.length) {
  console.error(`Thèmes invalides :\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
themes.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(themes) + '\n');
console.log(`${themes.length} thèmes → ${target}`);
