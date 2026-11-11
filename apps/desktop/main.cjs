// Coque de bureau : affiche le build web dans une fenêtre native.
// Lancer `pnpm desktop` à la racine (compile le web puis démarre Electron).
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

// Empaquetée, l'app embarque le build web dans ses ressources.
const INDEX = app.isPackaged
  ? path.join(process.resourcesPath, 'web', 'index.html')
  : path.join(__dirname, '..', 'web', 'dist', 'index.html');

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 820,
    minWidth: 420,
    minHeight: 320,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });

  // Les liens externes (connexion Plex) s'ouvrent dans le navigateur du système,
  // jamais dans une fenêtre de l'application.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
  });

  win.loadFile(INDEX);

  // Test de fumée : `electron . --smoke=capture.png` charge l'app, enregistre
  // une capture et quitte avec un code d'erreur si le chargement a échoué.
  const smoke = process.argv.find((a) => a.startsWith('--smoke='));
  if (smoke) {
    win.webContents.on('did-fail-load', () => app.exit(1));
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        const ok = await win.webContents.executeJavaScript("!!document.querySelector('.gate, .shell')");
        const image = await win.webContents.capturePage();
        require('node:fs').writeFileSync(smoke.slice(8), image.toPNG());
        app.exit(ok ? 0 : 2);
      }, 2500);
    });
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
