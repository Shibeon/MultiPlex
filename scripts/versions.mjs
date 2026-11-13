// Numéros de version par plateforme (versions.json) et journal des nouveautés
// (apps/web/src/changelog.json, chaque entrée indiquant les plateformes concernées).
//
//   node scripts/versions.mjs bump <plateformes…|all> [--set 1.2.3]
//       Monte le numéro des plateformes données (dernier chiffre +1, ou --set) et
//       ajoute en tête du journal une entrée à remplir, en français et en anglais.
//   node scripts/versions.mjs check
//       Vérifie que tout concorde (utilisé par le build) : chaque numéro a son entrée
//       remplie dans le journal, et l'application de bureau porte le bon numéro.
//   node scripts/versions.mjs get <plateforme>
//       Affiche le numéro d'une plateforme.
//   node scripts/versions.mjs notes <plateforme> <fichier>
//       Écrit les nouveautés de la version en cours de cette plateforme, à joindre à sa
//       publication (pour le bureau : le format que lit la mise à jour automatique).
//
// Publication : envoyer sur `main` un numéro pas encore publié suffit (voir le workflow).
import { readFileSync, writeFileSync } from 'node:fs';

export const PLATFORMS = ['desktop', 'web', 'android', 'tv'];
const NAMES = { desktop: 'Bureau (Windows, macOS, Linux)', web: 'Web', android: 'Android et Android TV', tv: 'TV (LG webOS, Samsung Tizen)' };

const root = new URL('..', import.meta.url);
const file = (p) => new URL(p, root);
const readJson = (p) => JSON.parse(readFileSync(file(p), 'utf8'));
const writeJson = (p, v) => writeFileSync(file(p), JSON.stringify(v, null, 2) + '\n');

export const versions = () => readJson('versions.json');
export const changelog = () => readJson('apps/web/src/changelog.json');
/** Entrées du journal d'une plateforme, la plus récente d'abord, avec son numéro. */
export const logOf = (platform) =>
  changelog()
    .filter((e) => e.versions?.[platform])
    .map((e) => ({ version: e.versions[platform], fr: e.fr, en: e.en }));

const parse = (v) => v.split('.').map((n) => Number(n) || 0);
const valid = (v) => /^\d+\.\d+\.\d+$/.test(v);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function check() {
  const v = versions();
  const errors = [];
  for (const p of PLATFORMS) {
    if (!valid(v[p] ?? '')) errors.push(`versions.json : numéro de « ${p} » absent ou invalide (${v[p]}).`);
    const log = logOf(p);
    if (log[0]?.version !== v[p]) errors.push(`Journal des nouveautés : pas d'entrée pour ${p} ${v[p]} en tête (dernière : ${log[0]?.version ?? 'aucune'}). Ajoutez-la (node scripts/versions.mjs bump ${p}).`);
    else if (!log[0].fr.length || !log[0].en.length || [...log[0].fr, ...log[0].en].some((l) => !l.trim()))
      errors.push(`Journal des nouveautés : l'entrée ${p} ${v[p]} est à remplir (lignes en français et en anglais).`);
  }
  const desktop = readJson('apps/desktop/package.json').version;
  if (desktop !== v.desktop) errors.push(`apps/desktop/package.json est en ${desktop}, versions.json dit ${v.desktop}.`);
  if (errors.length) fail(errors.join('\n'));
  console.log(PLATFORMS.map((p) => `${p} ${v[p]}`).join(' · '));
}

function bump(args) {
  const setAt = args.indexOf('--set');
  const set = setAt >= 0 ? args[setAt + 1] : null;
  if (set !== null && !valid(set ?? '')) fail('--set attend un numéro comme 1.2.3');
  const asked = args.filter((a, i) => !(setAt >= 0 && (i === setAt || i === setAt + 1)));
  const list = asked.includes('all') ? PLATFORMS : asked;
  if (!list.length || list.some((p) => !PLATFORMS.includes(p))) fail(`Plateformes : ${PLATFORMS.join(', ')} ou all`);
  const v = versions();
  const entry = { versions: {}, fr: [], en: [] };
  for (const p of list) {
    const [a, b, c] = parse(v[p]);
    v[p] = set ?? `${a}.${b}.${c + 1}`;
    entry.versions[p] = v[p];
  }
  writeJson('versions.json', v);
  if (list.includes('desktop')) {
    const pkg = readJson('apps/desktop/package.json');
    pkg.version = v.desktop;
    writeJson('apps/desktop/package.json', pkg);
  }
  // Une seule entrée pour toutes les plateformes montées ensemble : les mêmes nouveautés.
  const log = changelog();
  writeJson('apps/web/src/changelog.json', [entry, ...log]);
  console.log(`${list.map((p) => `${p} ${v[p]}`).join(', ')}.\nÀ remplir : les lignes « fr » et « en » de la première entrée de apps/web/src/changelog.json.`);
}

function notes(platform, out) {
  if (!PLATFORMS.includes(platform) || !out) fail('Usage : notes <plateforme> <fichier>');
  const log = logOf(platform);
  const v = versions()[platform];
  if (log[0]?.version !== v) fail(`Pas d'entrée ${platform} ${v} en tête du journal des nouveautés.`);
  let text;
  if (platform === 'desktop') {
    // Lu par l'application installée. Les versions 0.1.6 et antérieures coupent les notes à
    // 6 000 caractères (un JSON tronqué s'affichait tel quel) : l'historique est raccourci.
    const LIMIT = 5800;
    let n = Math.min(12, log.length);
    text = JSON.stringify({ fr: log[0].fr, en: log[0].en, log: log.slice(0, n) });
    while (text.length > LIMIT && n > 0) {
      n -= 1;
      text = JSON.stringify(n ? { fr: log[0].fr, en: log[0].en, log: log.slice(0, n) } : { fr: log[0].fr, en: log[0].en });
    }
  } else {
    text = `**${NAMES[platform]} ${v}**\n\n${log[0].fr.map((l) => `- ${l}`).join('\n')}\n\n---\n\n${log[0].en.map((l) => `- ${l}`).join('\n')}\n`;
  }
  writeFileSync(out, text);
  console.log(`Nouveautés ${platform} ${v} : ${log[0].fr.length} lignes → ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('versions.mjs')) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'check') check();
  else if (cmd === 'bump') bump(args);
  else if (cmd === 'get') {
    const v = versions()[args[0]];
    if (!v) fail(`Plateformes : ${PLATFORMS.join(', ')}`);
    console.log(v);
  } else if (cmd === 'notes') notes(args[0], args[1]);
  else fail('Commandes : check, bump <plateformes…|all> [--set x.y.z], get <plateforme>, notes <plateforme> <fichier>');
}
