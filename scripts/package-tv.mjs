// Prépare les dossiers d'application TV à partir du build web :
//   dist-platforms/tizen  → Samsung (à empaqueter en .wgt avec Tizen Studio : `tizen package -t wgt`)
//   dist-platforms/webos  → LG (à empaqueter en .ipk avec `ares-package dist-platforms/webos`)
// Usage : pnpm build && node scripts/package-tv.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'apps', 'web', 'dist');
const out = join(root, 'dist-platforms');
// Numéro de la version TV (versions.json), distinct de ceux du bureau, du web et d'Android.
const { tv: version } = JSON.parse(readFileSync(join(root, 'versions.json'), 'utf8'));

if (!existsSync(join(web, 'index.html'))) {
  console.error('Build web introuvable : lancez `pnpm build` avant.');
  process.exit(1);
}

// --- Icône PNG (les TV n'acceptent pas le SVG) : même dessin que icon.svg. ---
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function icon(size) {
  const chevron = (dx) => [[150, 120], [220, 120], [330, 256], [220, 392], [150, 392], [260, 256]].map(([x, y]) => [x + dx, y]);
  const shapes = [
    { poly: chevron(112), rgb: [0x6f, 0x51, 0x11] },
    { poly: chevron(0), rgb: [0xe5, 0xa0, 0x0d] },
  ];
  const bg = [0x0f, 0x11, 0x15];
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const S = 3; // suréchantillonnage pour lisser les bords
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const px = ((x + (sx + 0.5) / S) * 512) / size;
          const py = ((y + (sy + 0.5) / S) * 512) / size;
          let c = bg;
          for (const s of shapes) if (inside(s.poly, px, py)) c = s.rgb;
          for (let i = 0; i < 3; i++) acc[i] += c[i];
        }
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let i = 0; i < 3; i++) raw[o + i] = Math.round(acc[i] / (S * S));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function stage(name) {
  const dir = join(out, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(web, dir, { recursive: true });
  // Pas de service worker dans un paquet TV : l'app est déjà locale.
  rmSync(join(dir, 'sw.js'), { force: true });
  return dir;
}

// --- Samsung Tizen ---
const tizen = stage('tizen');
writeFileSync(join(tizen, 'icon.png'), icon(512));
writeFileSync(
  join(tizen, 'config.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets" id="https://github.com/multiplex-app/multiplex" version="${version}" viewmodes="maximized">
  <tizen:application id="MltPlx0001.MultiPlex" package="MltPlx0001" required_version="5.5"/>
  <name>MultiPlex</name>
  <description>Client Plex communautaire</description>
  <content src="index.html"/>
  <icon src="icon.png"/>
  <feature name="http://tizen.org/feature/screen.size.all"/>
  <access origin="*" subdomains="true"/>
  <tizen:privilege name="http://tizen.org/privilege/internet"/>
  <tizen:privilege name="http://tizen.org/privilege/tv.inputdevice"/>
  <tizen:profile name="tv-samsung"/>
  <tizen:setting screen-orientation="landscape" context-menu="disable" background-support="disable" encryption="disable" install-location="auto" hwkey-event="enable"/>
  <tizen:content-security-policy>default-src * 'self' data: blob: 'unsafe-inline'</tizen:content-security-policy>
</widget>
`,
);

// --- LG webOS ---
const webos = stage('webos');
writeFileSync(join(webos, 'icon.png'), icon(80));
writeFileSync(join(webos, 'largeIcon.png'), icon(130));
writeFileSync(
  join(webos, 'appinfo.json'),
  JSON.stringify(
    {
      id: 'app.multiplex.client',
      version: version.split('.').slice(0, 3).join('.'),
      vendor: 'MultiPlex contributors',
      type: 'web',
      main: 'index.html',
      title: 'MultiPlex',
      icon: 'icon.png',
      largeIcon: 'largeIcon.png',
      bgColor: '#0f1115',
      iconColor: '#0f1115',
      disableBackHistoryAPI: true,
      resolution: '1920x1080',
      requiredACG: [],
    },
    null,
    2,
  ) + '\n',
);

console.log(`Dossiers prêts :\n  ${tizen}\n  ${webos}`);
