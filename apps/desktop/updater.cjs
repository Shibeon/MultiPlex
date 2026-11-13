// Mise à jour automatique de l'application de bureau, depuis les versions publiées
// sur GitHub. Par défaut elle est silencieuse : la nouvelle version se télécharge en
// arrière-plan et s'installe sans rien demander — sous Windows au lancement suivant
// (installée à la fermeture, elle remplaçait le programme pendant quelques secondes et le
// raccourci de la barre des tâches affichait une erreur), ailleurs à la fermeture. Si l'utilisateur
// coupe ce réglage, l'app signale seulement la version, la télécharge sur demande, puis
// propose de redémarrer. L'interface annonce son choix par `update:auto`.
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/** Sous Windows, une mise à jour silencieuse attend le lancement suivant (voir plus haut). */
const AT_LAUNCH = process.platform === 'win32';
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
    // Silencieuse sous Windows : notée pour le prochain lancement, plus rien à la fermeture.
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

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  ipcMain.handle('update:check', check);
  ipcMain.handle('update:download', () => autoUpdater.downloadUpdate().catch(() => {}));
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());
  // Silencieuse : téléchargement sans demander, installation à la fermeture (autoInstallOnAppQuit).
  ipcMain.handle('update:auto', (_e, on) => {
    auto = !!on;
    autoUpdater.autoDownload = auto;
    // Windows : installée au prochain lancement, pas à la fermeture (raccourci cassé pendant l'installation).
    autoUpdater.autoInstallOnAppQuit = !(auto && AT_LAUNCH);
    // Mise à jour silencieuse coupée : plus d'installation au lancement non plus.
    if (!auto) fs.rmSync(pendingFile(), { force: true });
    if (on && state.status === 'available') autoUpdater.downloadUpdate().catch(() => {});
  });

  setTimeout(check, 8000);
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = { setupUpdater, installPendingAtLaunch };
