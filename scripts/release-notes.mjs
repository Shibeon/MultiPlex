// Écrit les nouveautés de la version en cours (apps/web/src/changelog.json) dans
// apps/desktop/release-notes.txt : electron-builder les joint à la version publiée,
// et l'application installée les affiche en proposant la mise à jour.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const version = JSON.parse(readFileSync(new URL('apps/desktop/package.json', root), 'utf8')).version;
const log = JSON.parse(readFileSync(new URL('apps/web/src/changelog.json', root), 'utf8'));
if (log[0]?.version !== version) {
  console.error(`Le journal des nouveautés commence à la version ${log[0]?.version}, l'application est en ${version} : ajoutez l'entrée manquante à apps/web/src/changelog.json.`);
  process.exit(1);
}
// Les versions 0.1.6 et antérieures coupent les notes à 6 000 caractères (un JSON tronqué
// s'affichait tel quel) : l'historique joint est raccourci jusqu'à tenir dans cette limite.
const LIMIT = 5800;
let n = Math.min(12, log.length);
let text = JSON.stringify({ fr: log[0].fr, en: log[0].en, log: log.slice(0, n) });
while (text.length > LIMIT && n > 0) {
  n -= 1;
  text = JSON.stringify(n ? { fr: log[0].fr, en: log[0].en, log: log.slice(0, n) } : { fr: log[0].fr, en: log[0].en });
}
writeFileSync(new URL('apps/desktop/release-notes.txt', root), text);
console.log(`Nouveautés de la version ${version} : ${log[0].fr.length} lignes.`);
