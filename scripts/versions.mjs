// Numéros de version par plateforme (versions.json) et journal des nouveautés
// (apps/web/src/changelog.json, chaque entrée indiquant les plateformes concernées).
//
//   node scripts/versions.mjs bump <plateformes…|all> [--set 1.2.3] [--tv | --touch]
//       Monte le numéro des plateformes données (dernier chiffre +1, ou --set) et
//       ajoute en tête du journal une entrée à remplir, en français et en anglais.
//       Ne monter QUE les plateformes que les changements concernent : chacune ne propose
//       une mise à jour que si son numéro change.
//       --tv / --touch : l'entrée ne concerne que les téléviseurs (Android TV compris) ou
//       que les écrans tactiles et ordinateurs. Android TV et téléphones partagent le même
//       APK, donc le même numéro : c'est ce champ « devices » qui trie leurs nouveautés.
//       Plusieurs entrées peuvent porter le même numéro (une commune, une --tv, une --touch).
//   node scripts/versions.mjs check
//       Vérifie que tout concorde (utilisé par le build) : chaque numéro a son entrée
//       remplie dans le journal, et l'application de bureau porte le bon numéro.
//   node scripts/versions.mjs get <plateforme>
//       Affiche le numéro d'une plateforme.
//   node scripts/versions.mjs notes <plateforme> <fichier> [--md]   (--md : texte lisible pour GitHub)
//   node scripts/versions.mjs body <version> <fichier> < notes.json  (ancienne page JSON → lisible)
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
/** Une entrée concerne-t-elle ce type d'appareil (« tv », « touch », ou null : tous) ? */
export const forDevice = (entry, device) => !entry.devices || !device || entry.devices === device;
/** Appareil des plateformes qui n'en ont qu'un : le bureau n'est jamais une télé, la TV toujours. */
const DEVICE = { desktop: 'touch', web: 'touch', tv: 'tv', android: null };
/**
 * Entrées du journal d'une plateforme, la plus récente d'abord, avec son numéro. Les entrées
 * d'un même numéro sont fusionnées ; `device` garde seulement celles de ce type d'appareil
 * (par défaut celui de la plateforme ; Android en a deux, il les garde donc toutes).
 */
export const logOf = (platform, device = DEVICE[platform]) => {
  const out = [];
  for (const e of changelog()) {
    const version = e.versions?.[platform];
    if (!version || !forDevice(e, device)) continue;
    // Toutes les entrées Android ensemble (page de la version) : on dit pour qui est chaque ligne.
    const label = { tv: { fr: 'Android TV', en: 'Android TV' }, touch: { fr: 'téléphone, tablette', en: 'phone, tablet' } }[e.devices];
    const tag = (lang) => (l) => (device || !label ? l : `(${label[lang]}) ${l}`);
    const last = out[out.length - 1];
    if (last?.version === version) {
      last.fr.push(...e.fr.map(tag('fr')));
      last.en.push(...e.en.map(tag('en')));
    } else out.push({ version, fr: e.fr.map(tag('fr')), en: e.en.map(tag('en')) });
  }
  return out;
};

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
    const log = logOf(p, null);
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
  const devices = args.includes('--tv') ? 'tv' : args.includes('--touch') ? 'touch' : null;
  const asked = args.filter((a, i) => !(setAt >= 0 && (i === setAt || i === setAt + 1)) && a !== '--tv' && a !== '--touch');
  const list = asked.includes('all') ? PLATFORMS : asked;
  if (!list.length || list.some((p) => !PLATFORMS.includes(p))) fail(`Plateformes : ${PLATFORMS.join(', ')} ou all`);
  const v = versions();
  const entry = devices ? { versions: {}, devices, fr: [], en: [] } : { versions: {}, fr: [], en: [] };
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

// Texte lisible pour la page de la version sur GitHub (titre, liste française, puis anglaise).
function markdown(platform, v, entry) {
  const list = (lines) => (lines ?? []).map((l) => `- ${l}`).join('\n');
  return `**${NAMES[platform]} ${v}**\n\n${list(entry.fr)}\n\n---\n\n${list(entry.en)}\n`;
}

// Anciennes pages de version dont le texte est le JSON destiné à l'application :
// lit ce JSON sur l'entrée standard et écrit sa version lisible (rien si ce n'est pas du JSON).
function bodyFromJson(v, out) {
  if (!v || !out) fail('Usage : body <version> <fichier> < notes.json');
  let data;
  try {
    data = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(data?.fr)) return;
  writeFileSync(out, markdown('desktop', v, data));
  console.log(`Page ${v} convertie → ${out}`);
}

function notes(platform, out, md) {
  if (!PLATFORMS.includes(platform) || !out) fail('Usage : notes <plateforme> <fichier> [--md]');
  const log = logOf(platform);
  const v = versions()[platform];
  // Rien pour ce type d'appareil dans cette version : pas de notes (la publication les veut
  // pourtant non vides, d'où une ligne générique).
  if (log[0]?.version !== v && logOf(platform, null)[0]?.version === v) log.unshift({ version: v, fr: ['Corrections mineures.'], en: ['Minor fixes.'] });
  if (log[0]?.version !== v) fail(`Pas d'entrée ${platform} ${v} en tête du journal des nouveautés.`);
  let text;
  if (platform === 'desktop' && !md) {
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
    text = markdown(platform, v, log[0]);
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
  } else if (cmd === 'notes') notes(args[0], args[1], args.includes('--md'));
  else if (cmd === 'body') bodyFromJson(args[0], args[1]);
  else fail('Commandes : check, bump <plateformes…|all> [--set x.y.z], get <plateforme>, notes <plateforme> <fichier> [--md], body <version> <fichier>');
}
