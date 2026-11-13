// Mise à jour automatique de l'application de bureau, depuis les versions publiées
// sur GitHub. Par défaut elle est silencieuse : la nouvelle version se télécharge en
// arrière-plan et s'installe à la fermeture de l'app, sans rien demander. Si l'utilisateur
// coupe ce réglage, l'app signale seulement la version, la télécharge sur demande, puis
// propose de redémarrer. L'interface annonce son choix par `update:auto`.
const { app, ipcMain } = require('electron');

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
  let autoUpdater = null;
  if (app.isPackaged) {
    try {
      ({ autoUpdater } = require('electron-updater'));
    } catch {
      autoUpdater = null;
    }
  }
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
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, notes }));
  // Pas de réseau, pas de version publiée : ce n'est pas une panne de l'app, on reste discret.
  autoUpdater.on('error', (e) => set({ status: 'error', message: String(e?.message ?? e).split('\n')[0].slice(0, 160) }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  ipcMain.handle('update:check', check);
  ipcMain.handle('update:download', () => autoUpdater.downloadUpdate().catch(() => {}));
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());
  // Silencieuse : téléchargement sans demander, installation à la fermeture (autoInstallOnAppQuit).
  ipcMain.handle('update:auto', (_e, on) => {
    autoUpdater.autoDownload = !!on;
    if (on && state.status === 'available') autoUpdater.downloadUpdate().catch(() => {});
  });

  setTimeout(check, 8000);
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = { setupUpdater };
