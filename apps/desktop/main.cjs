// Coque de bureau : affiche le build web dans une fenêtre native et lui
// fournit un lecteur natif (mpv). Lancer `pnpm desktop` à la racine.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { MpvPlayer } = require('./mpv.cjs');

// Empaquetée, l'app embarque le build web dans ses ressources.
const INDEX = app.isPackaged
  ? path.join(process.resourcesPath, 'web', 'index.html')
  : path.join(__dirname, '..', 'web', 'dist', 'index.html');

// mpv dessine dans une sous-fenêtre native de la fenêtre principale. Avec la
// composition DirectComposition de Chromium, la page web recouvre cette sous-fenêtre
// (son sans image) ; sans elle, la sous-fenêtre de mpv passe au-dessus.
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-direct-composition');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

/** Lecteur natif de la fenêtre principale. */
let player = null;

function registerPlayer(win) {
  player = new MpvPlayer(app, win, (type, data) => {
    if (!win.isDestroyed()) win.webContents.send('mpv:event', type, data);
  });
  win.on('closed', () => {
    void player?.stop();
    player = null;
  });
}

ipcMain.handle('mpv:available', () => !!player?.available());
ipcMain.handle('mpv:play', (_e, opts) => {
  // L'interface ne peut faire lire que des adresses web, jamais un fichier local ni une option mpv.
  const web = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
  if (!player || !opts || !web(opts.url)) throw new Error('Demande de lecture invalide');
  // En-têtes : uniquement ceux de Plex, sans saut de ligne (pas d'injection d'en-tête).
  const headers = Object.entries(opts.headers && typeof opts.headers === 'object' ? opts.headers : {})
    .filter(([k, v]) => /^X-Plex-[A-Za-z-]{1,40}$/.test(k) && typeof v === 'string' && /^[\x20-\x7E]{1,200}$/.test(v))
    .map(([k, v]) => `${k}: ${v}`);
  return player.play({
    url: opts.url,
    headers,
    title: String(opts.title ?? '').slice(0, 200),
    start: Number(opts.start) || 0,
    aid: Number.isInteger(opts.aid) ? opts.aid : undefined,
    sid: Number.isInteger(opts.sid) ? opts.sid : undefined,
    subFiles: (Array.isArray(opts.subFiles) ? opts.subFiles : []).filter(web).slice(0, 8),
    passthrough: !!opts.passthrough,
  });
});
ipcMain.handle('mpv:stop', () => player?.stop());
ipcMain.handle('mpv:command', (_e, name, value) => player?.command(String(name), value));
ipcMain.handle('mpv:info', () => player?.info());

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 820,
    minWidth: 420,
    minHeight: 320,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  registerPlayer(win);

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

  // Test de fumée : `--smoke=capture.png` charge l'app, enregistre une capture
  // et quitte avec un code d'erreur si le chargement a échoué.
  const smoke = arg('smoke');
  if (smoke) {
    win.webContents.on('did-fail-load', () => app.exit(1));
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        const ok = await win.webContents.executeJavaScript("!!document.querySelector('.gate, .shell')");
        const image = await win.webContents.capturePage();
        fs.writeFileSync(smoke, image.toPNG());
        app.exit(ok ? 0 : 2);
      }, 2500);
    });
  }

  // Test du lecteur natif : `--smoke-native=rapport.json` passe en mode démo,
  // lance une lecture par l'interface, puis écrit ce que mpv décode réellement.
  const smokeNative = arg('smoke-native');
  if (smokeNative) {
    let loads = 0;
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    win.webContents.on('did-finish-load', async () => {
      if (++loads === 1) {
        await js("localStorage.setItem('mp.demo','true'); location.hash = '#/play/1?t=20'; location.reload()");
        return;
      }
      const report = { steps: [] };
      try {
        await wait(9000 + (Number(arg('smoke-hold')) || 0));
        report.native = await js("!!window.multiplexNative && document.querySelector('.player')?.className");
        report.start = await player.info();
        // La souris, relayée par la page, doit être vue par mpv.
        report.mouse = await player.send(['get_property', 'mouse-pos']);
        if (arg('smoke-shot')) report.shot = await player.send(['screenshot-to-file', arg('smoke-shot'), 'window']);
        await player.command('seekBy', 30);
        await wait(3000);
        report.afterSeek = (await player.info())['time-pos'];
        await player.command('pause', true);
        await wait(700);
        report.paused = player.state.pause;
        report.uiPaused = await js("document.querySelector('.native-state')?.textContent");
        await player.command('pause', false);
        await player.command('key', 'ESC');
        await wait(2500);
        report.afterQuit = { running: !!player.proc, hash: await js('location.hash') };
      } catch (e) {
        report.error = String(e);
      }
      fs.writeFileSync(smokeNative, JSON.stringify(report, null, 2));
      app.exit(report.error ? 3 : 0);
    });
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => void player?.stop());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
