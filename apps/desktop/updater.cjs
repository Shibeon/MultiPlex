// Mise à jour automatique de l'application de bureau, depuis les versions publiées
// sur GitHub. D'abord « à chaud » quand c'est possible (seul le code de l'app change : il se
// télécharge pendant que l'app tourne et « Redémarrer » relance dessus, voir boot.cjs) ;
// sinon mise à jour complète. Par défaut elle est silencieuse : la nouvelle version se télécharge en
// arrière-plan, puis l'app propose de redémarrer : l'installation est alors silencieuse et
// MultiPlex se relance. Sans redémarrage, elle s'installe au lancement suivant (installée à
// la fermeture, elle remplaçait le programme pendant quelques secondes et un raccourci lancé
// à ce moment-là affichait une erreur), sur Windows, macOS et Linux. Si l'utilisateur
// coupe ce réglage, l'app signale seulement la version, la télécharge sur demande, puis
// propose de redémarrer. L'interface annonce son choix par `update:auto`.
const { app, ipcMain, BrowserWindow, net } = require('electron');
const fs = require('node:fs');
const ofs = require('original-fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Une mise à jour silencieuse attend le lancement suivant (voir plus haut), sur tous les systèmes. */
const AT_LAUNCH = true;
/** Version téléchargée, à installer au prochain lancement. */
const pendingFile = () => path.join(app.getPath('userData'), 'pending-update.json');

const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).split('.').map((n) => Number(n) || 0));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

function loadUpdater() {
  if (!app.isPackaged) return null;
  try {
    return require('electron-updater').autoUpdater;
  } catch {
    return null;
  }
}

/** Petite fenêtre « Mise à jour… » le temps de l'installation au lancement. */
function splash() {
  const fr = app.getLocale().toLowerCase().startsWith('fr');
  const win = new BrowserWindow({ width: 360, height: 140, frame: false, resizable: false, center: true, show: false, backgroundColor: '#0e0f12', skipTaskbar: false, title: 'MultiPlex', webPreferences: { sandbox: true, javascript: false } });
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-content:center;gap:10px;background:#0e0f12;color:#f4f1ea;font:15px system-ui,sans-serif;text-align:center"><b style="font-size:20px">MultiPlex</b><span style="opacity:.75">${fr ? 'Installation de la mise à jour…' : 'Installing update…'}</span></body>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.once('ready-to-show', () => win.show());
  return win;
}

/**
 * Au lancement : une mise à jour téléchargée attend ? On l'installe maintenant (en silence,
 * puis MultiPlex se relance tout seul). Rend vrai si l'installation est partie : l'app ne doit
 * alors pas ouvrir sa fenêtre. Hors ligne ou en cas d'échec, on lance normalement.
 */
async function installPendingAtLaunch() {
  if (!AT_LAUNCH) return false;
  let pending;
  try {
    pending = JSON.parse(fs.readFileSync(pendingFile(), 'utf8'));
  } catch {
    return false;
  }
  const autoUpdater = loadUpdater();
  if (!autoUpdater || !pending?.version || !newer(pending.version, app.getVersion())) {
    fs.rmSync(pendingFile(), { force: true });
    return false;
  }
  const win = splash();
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  const ok = await new Promise((resolve) => {
    const done = (v) => {
      clearTimeout(timer);
      autoUpdater.removeListener('update-downloaded', onReady);
      autoUpdater.removeListener('update-not-available', onNone);
      autoUpdater.removeListener('error', onError);
      resolve(v);
    };
    // Le fichier déjà téléchargé est réutilisé : pas de second téléchargement.
    const onReady = () => done(true);
    const onNone = () => (fs.rmSync(pendingFile(), { force: true }), done(false));
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), 90_000);
    autoUpdater.on('update-downloaded', onReady);
    autoUpdater.on('update-not-available', onNone);
    autoUpdater.on('error', onError);
    autoUpdater.checkForUpdates().catch(() => done(false));
  });
  if (!ok) {
    // Fermée juste après l'ouverture de la fenêtre principale : sinon, plus aucune fenêtre, l'app quitterait.
    setTimeout(() => !win.isDestroyed() && win.destroy(), 800);
    return false;
  }
  fs.rmSync(pendingFile(), { force: true });
  // Silencieuse, puis relance de MultiPlex dans la nouvelle version.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
}

// --- Mise à jour à chaud (voir boot.cjs) -------------------------------------------------
// Chaque version publie, par système, un paquet du code de l'app (`MultiPlex-hot-<v>-<os>.asar`)
// et sa fiche (`hot-<os>.json` : version, base, empreinte). Si la base installée est la même
// (Electron, dépendances, mpv), on télécharge ce paquet pendant que l'app tourne ; au
// redémarrage, boot.cjs le lance. Sinon, mise à jour complète par electron-updater.
const HOT_OS = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
const hotDir = () => path.join(app.getPath('userData'), 'hot');
/**
 * Dépôt des versions. L'app installée n'a plus la section `build` de package.json
 * (electron-builder la retire) : on lit app-update.yml, livré à côté de l'archive, celui
 * qu'utilise electron-updater. package.json ne sert qu'en secours (paquet à chaud, développement).
 */
const publishTarget = () => {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const field = (k) => yml.match(new RegExp(`^${k}:\\s*['"]?([\\w.-]+)['"]?\\s*$`, 'm'))?.[1];
    if (field('owner') && field('repo')) return { owner: field('owner'), repo: field('repo') };
  } catch {
    /* pas d'app-update.yml : développement */
  }
  try {
    const p = require('./package.json').build.publish[0];
    return p.owner && p.repo ? p : null;
  } catch {
    return null;
  }
};
/** Clé de la base installée (lue dans l'archive d'origine, pas dans le code à chaud). */
function baseKey() {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.resourcesPath, 'app.asar', 'base.json'), 'utf8')).key || '';
  } catch {
    return '';
  }
}
async function hotManifest() {
  const pub = publishTarget();
  if (!pub || !HOT_OS) return null;
  const res = await net.fetch(`https://github.com/${pub.owner}/${pub.repo}/releases/latest/download/hot-${HOT_OS}.json`, { cache: 'no-store' });
  if (!res.ok) return null;
  const m = await res.json();
  const ok = m && typeof m.version === 'string' && typeof m.tag === 'string' && typeof m.base === 'string' && typeof m.sha512 === 'string' && /^[\w.-]+\.asar$/.test(m.file ?? '');
  return ok ? m : null;
}
/** Téléchargement vérifié (empreinte SHA-512), puis désignation pour le prochain démarrage. */
async function downloadHot(m, progress) {
  const pub = publishTarget();
  const dir = hotDir();
  ofs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, 'download.part');
  const res = await net.fetch(`https://github.com/${pub.owner}/${pub.repo}/releases/download/${encodeURIComponent(m.tag)}/${m.file}`, { cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || m.size || 0;
  const hash = crypto.createHash('sha512');
  const out = ofs.createWriteStream(part);
  let got = 0;
  let shown = -1;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      got += value.length;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      const pct = total ? Math.min(99, Math.floor((got / total) * 100)) : 0;
      if (pct !== shown) progress((shown = pct));
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (hash.digest('base64') !== m.sha512) {
    ofs.rmSync(part, { force: true });
    throw new Error('empreinte du paquet incorrecte');
  }
  const name = path.basename(m.file);
  ofs.renameSync(part, path.join(dir, name));
  ofs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify({ version: m.version, file: name, base: m.base, tries: 0 }));
  // Anciens paquets : supprimés (sauf celui qui tourne, verrouillé sous Windows : au prochain coup).
  const running = global.multiplexHot ? path.basename(global.multiplexHot.file) : '';
  for (const f of ofs.readdirSync(dir)) if (f.endsWith('.asar') && f !== name && f !== running) ofs.rmSync(path.join(dir, f), { force: true });
}
/** Code à chaud bien démarré (fenêtre chargée) : il n'est plus considéré comme suspect. */
function hotBooted() {
  if (!global.multiplexHot) return;
  const marker = path.join(hotDir(), 'current.json');
  try {
    const cur = JSON.parse(ofs.readFileSync(marker, 'utf8'));
    if (cur.version === global.multiplexHot.version && cur.tries) ofs.writeFileSync(marker, JSON.stringify({ ...cur, tries: 0 }));
    // Paquets précédents : plus utilisés (celui d'avant le redémarrage n'est plus verrouillé).
    for (const f of ofs.readdirSync(hotDir())) if (f.endsWith('.asar') && f !== cur.file) ofs.rmSync(path.join(hotDir(), f), { force: true });
  } catch {
    /* rien à noter */
  }
}

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * `send(état)` transmet l'état à l'interface. États : idle, checking, available,
 * downloading, ready, none, error — avec `version`, `percent` ou `message` selon le cas.
 */
function setupUpdater(send, { simulate = false } = {}) {
  let state = { status: 'idle', current: app.getVersion() };
  const set = (patch) => {
    state = { current: app.getVersion(), ...patch };
    send(state);
  };
  ipcMain.handle('update:state', () => state);

  // Test automatique : une mise à jour fictive, pour vérifier l'interface sans rien publier.
  if (simulate) {
    const notes = JSON.stringify({ fr: ['Une nouveauté de démonstration.'], en: ['A demo novelty.'] });
    ipcMain.handle('update:check', () => set({ status: 'available', version: '9.9.9', notes }));
    ipcMain.handle('update:download', async () => {
      for (const percent of [10, 45, 80, 100]) {
        set({ status: 'downloading', version: '9.9.9', percent });
        await new Promise((r) => setTimeout(r, 250));
      }
      set({ status: 'ready', version: '9.9.9' });
    });
    ipcMain.handle('update:install', () => set({ status: 'idle', installed: true }));
    ipcMain.handle('update:auto', () => undefined);
    setTimeout(() => set({ status: 'available', version: '9.9.9', notes }), 1500);
    return;
  }

  // Hors application installée (développement), ou sans adresse de publication
  // configurée, il n'y a rien à mettre à jour : les commandes répondent « aucune ».
  const autoUpdater = loadUpdater();
  if (!autoUpdater) {
    ipcMain.handle('update:check', () => set({ status: 'none' }));
    ipcMain.handle('update:download', () => undefined);
    ipcMain.handle('update:install', () => undefined);
    ipcMain.handle('update:auto', () => undefined);
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  // Les nouveautés de la version proposée voyagent avec elle (texte, sans mise en forme).
  let notes = '';
  // GitHub les rend en HTML : on retire les balises et les entités. La limite est large (les
  // notes reprennent l'historique des versions récentes) : un JSON tronqué serait illisible.
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" };
  const notesOf = (info) =>
    typeof info.releaseNotes === 'string'
      ? info.releaseNotes
          .replace(/<[^>]*>/g, '')
          .replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e) => entities[e])
          .trim()
          .slice(0, 100_000)
      : '';
  autoUpdater.on('update-available', (info) => set({ status: 'available', version: info.version, notes: (notes = notesOf(info)) }));
  autoUpdater.on('update-not-available', () => set({ status: 'none' }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', version: state.version, notes, percent: Math.round(p.percent) }));
  let auto = false;
  autoUpdater.on('update-downloaded', (info) => {
    // Silencieuse : notée pour le prochain lancement, plus rien à la fermeture.
    const atLaunch = auto && AT_LAUNCH;
    if (atLaunch) {
      try {
        fs.writeFileSync(pendingFile(), JSON.stringify({ version: info.version }));
      } catch {
        /* pas d'écriture possible : installation à la fermeture, comme avant */
      }
    }
    set({ status: 'ready', version: info.version, notes, when: atLaunch ? 'launch' : 'quit' });
  });
  // Pas de réseau, pas de version publiée : ce n'est pas une panne de l'app, on reste discret.
  autoUpdater.on('error', (e) => set({ status: 'error', message: String(e?.message ?? e).split('\n')[0].slice(0, 160) }));

  // Mise à jour à chaud : proposée (réglage coupé), puis prête une fois téléchargée.
  let hotOffer = null;
  let hotReady = '';
  let busy = false;
  const fetchHot = async (m) => {
    if (busy) return;
    busy = true;
    const hotNotes = typeof m.notes === 'string' ? m.notes : '';
    try {
      set({ status: 'downloading', version: m.version, notes: hotNotes, percent: 0 });
      await downloadHot(m, (percent) => set({ status: 'downloading', version: m.version, notes: hotNotes, percent }));
      hotOffer = null;
      hotReady = m.version;
      set({ status: 'ready', version: m.version, notes: hotNotes, when: 'restart' });
    } catch (e) {
      set({ status: 'error', message: String(e?.message ?? e).slice(0, 160) });
    } finally {
      busy = false;
    }
  };
  /** Vrai si une mise à jour à chaud prend le relais (proposée, en cours ou prête). */
  const tryHot = async () => {
    const key = baseKey();
    if (!key) return false;
    let m = null;
    try {
      m = await hotManifest();
    } catch {
      return false;
    }
    if (!m || m.base !== key || !newer(m.version, app.getVersion())) return false;
    // Ce paquet a déjà planté deux fois au démarrage (boot.cjs) : mise à jour complète à la place.
    try {
      const cur = JSON.parse(ofs.readFileSync(path.join(hotDir(), 'current.json'), 'utf8'));
      if (cur.version === m.version && (cur.tries ?? 0) >= 2) return false;
    } catch {
      /* pas de paquet en place */
    }
    if (hotReady === m.version) return true;
    if (auto) void fetchHot(m);
    else {
      hotOffer = m;
      set({ status: 'available', version: m.version, notes: typeof m.notes === 'string' ? m.notes : '' });
    }
    return true;
  };
  const check = async () => {
    if (busy || state.status === 'downloading') return;
    if (await tryHot()) return;
    autoUpdater.checkForUpdates().catch(() => {});
  };
  ipcMain.handle('update:check', check);
  ipcMain.handle('update:download', () => (hotOffer ? fetchHot(hotOffer) : autoUpdater.downloadUpdate().catch(() => {})));
  // « Redémarrer » : à chaud, simple relance (le nouveau code est déjà en place) ; sinon
  // installation silencieuse (sans assistant), puis MultiPlex se relance.
  ipcMain.handle('update:install', () => {
    if (hotReady) {
      app.relaunch();
      app.quit();
      return;
    }
    fs.rmSync(pendingFile(), { force: true });
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });
  // Silencieuse : téléchargement sans demander, installation à la fermeture (autoInstallOnAppQuit).
  ipcMain.handle('update:auto', (_e, on) => {
    auto = !!on;
    autoUpdater.autoDownload = auto;
    // Installée au prochain lancement, pas à la fermeture (raccourci cassé pendant l'installation).
    autoUpdater.autoInstallOnAppQuit = !(auto && AT_LAUNCH);
    // Mise à jour silencieuse coupée : plus d'installation au lancement non plus.
    if (!auto) fs.rmSync(pendingFile(), { force: true });
    if (on && state.status === 'available') {
      if (hotOffer) void fetchHot(hotOffer);
      else autoUpdater.downloadUpdate().catch(() => {});
    }
  });

  setTimeout(check, 8000);
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = { setupUpdater, installPendingAtLaunch, hotBooted };
