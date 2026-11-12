// Coque de bureau : affiche le build web dans une fenêtre native et lui
// fournit un lecteur natif (mpv). Lancer `pnpm desktop` à la racine.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { MpvPlayer } = require('./mpv.cjs');
const { setupUpdater } = require('./updater.cjs');

// Empaquetée, l'app embarque le build web dans ses ressources.
const INDEX = app.isPackaged
  ? path.join(process.resourcesPath, 'web', 'index.html')
  : path.join(__dirname, '..', 'web', 'dist', 'index.html');

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
/** Tests automatiques : fenêtres hors de l'écran et son coupé, pour ne pas déranger. */
const HIDDEN = process.argv.includes('--smoke-hidden');

// mpv dessine dans une sous-fenêtre native de la fenêtre principale. Avec la
// composition DirectComposition de Chromium, la page web recouvre cette sous-fenêtre
// (son sans image) ; sans elle, la sous-fenêtre de mpv passe au-dessus.
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-direct-composition');
// Hors écran, Chromium cesserait de dessiner des fenêtres qu'il croit masquées.
if (HIDDEN) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Les tests automatiques passent l'app en mode démo : ils travaillent dans un profil
// temporaire à part, pour ne jamais toucher à la session ni aux réglages de l'utilisateur.
if (arg('smoke') || arg('smoke-native') || process.argv.includes('--smoke-update')) app.setPath('userData', path.join(app.getPath('temp'), 'multiplex-smoke-profile'));

/** Fenêtre principale, lecteur natif et fenêtre de contrôles superposée. */
let main = null;
let player = null;
let overlay = null;
/** Ce que la page principale sait du titre en cours (titres, marqueurs, pistes), pour les contrôles. */
let meta = {};

const preload = path.join(__dirname, 'preload.cjs');
const sendTo = (w, channel, ...args) => w && !w.isDestroyed() && w.webContents.send(channel, ...args);

/**
 * Les contrôles ne peuvent pas être dessinés par la page principale : la vidéo de
 * mpv la recouvre. Ils vivent dans une fenêtre transparente, sans bordure, posée
 * exactement par-dessus, qui affiche la même interface web sur la route « overlay ».
 */
function openOverlay() {
  closeOverlay();
  if (!main || main.isDestroyed()) return;
  const win = new BrowserWindow({
    parent: main,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload },
  });
  overlay = win;
  win.setBounds(main.getContentBounds());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Pendant la lecture, c'est cette fenêtre qui a le clavier : F11 doit y agir aussi.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && main && !main.isDestroyed()) {
      e.preventDefault();
      main.setFullScreen(!main.isFullScreen());
    }
  });
  win.loadFile(INDEX, { hash: '/overlay' });
  win.once('ready-to-show', () => !win.isDestroyed() && (HIDDEN ? win.showInactive() : win.show()));
  win.on('closed', () => {
    if (overlay === win) overlay = null;
  });
}

function closeOverlay() {
  const win = overlay;
  overlay = null;
  if (win && !win.isDestroyed()) win.destroy();
}

function syncOverlay() {
  if (overlay && !overlay.isDestroyed() && main && !main.isDestroyed()) overlay.setBounds(main.getContentBounds());
}

function registerPlayer(win) {
  player = new MpvPlayer(app, win, (type, data) => {
    sendTo(win, 'mpv:event', type, data);
    sendTo(overlay, 'mpv:event', type, data);
    if (type === 'ended' || type === 'error') closeOverlay();
  });
  if (HIDDEN) player.muted = true;
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(ev, syncOverlay);
  win.on('closed', () => {
    closeOverlay();
    void player?.stop();
    player = null;
    main = null;
  });
}

ipcMain.handle('mpv:available', () => !!player?.available());
ipcMain.handle('mpv:play', async (_e, opts) => {
  // L'interface ne peut faire lire que des adresses web, jamais un fichier local ni une option mpv.
  const web = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
  if (!player || !opts || !web(opts.url)) throw new Error('Demande de lecture invalide');
  // En-têtes : uniquement ceux de Plex, sans saut de ligne (pas d'injection d'en-tête).
  const headers = Object.entries(opts.headers && typeof opts.headers === 'object' ? opts.headers : {})
    .filter(([k, v]) => /^X-Plex-[A-Za-z-]{1,40}$/.test(k) && typeof v === 'string' && /^[\x20-\x7E]{1,200}$/.test(v))
    .map(([k, v]) => `${k}: ${v}`);
  meta = {};
  const result = await player.play({
    url: opts.url,
    headers,
    title: String(opts.title ?? '').slice(0, 200),
    start: Number(opts.start) || 0,
    aid: Number.isInteger(opts.aid) ? opts.aid : undefined,
    sid: Number.isInteger(opts.sid) ? opts.sid : undefined,
    subFiles: (Array.isArray(opts.subFiles) ? opts.subFiles : []).filter(web).slice(0, 8),
    passthrough: !!opts.passthrough,
    buffered: !!opts.buffered,
  });
  openOverlay();
  return result;
});
ipcMain.handle('mpv:stop', () => {
  closeOverlay();
  return player?.stop();
});
ipcMain.handle('mpv:command', (_e, name, value) => player?.command(String(name), value));
ipcMain.handle('mpv:info', () => player?.info());

// --- Fenêtre de contrôles ---
ipcMain.handle('overlay:init', () => ({ meta, state: player?.state ?? {} }));
ipcMain.on('overlay:meta', (e, data) => {
  // Seule la page principale décrit le titre en cours.
  if (!main || e.sender !== main.webContents || !data || typeof data !== 'object') return;
  meta = { ...meta, ...data };
  sendTo(overlay, 'overlay:meta', meta);
});
ipcMain.on('overlay:action', (_e, name) => {
  if (name === 'back') {
    // Arrêt demandé par les contrôles : la page principale doit l'apprendre pour
    // enregistrer la position et revenir à la fiche.
    const time = player?.state['time-pos'] ?? 0;
    closeOverlay();
    void player?.stop();
    sendTo(main, 'mpv:event', 'ended', { time, eof: false });
  } else if (name === 'fullscreen') {
    if (main && !main.isDestroyed()) main.setFullScreen(!main.isFullScreen());
  } else if (typeof name === 'string' && /^quality:[a-z0-9]{1,12}$/.test(name)) {
    // Le changement de qualité relance la lecture : c'est la page principale qui sait le faire.
    sendTo(main, 'mpv:event', 'quality', { id: name.slice(8) });
  } else if (name === 'next') {
    // L'enchaînement est décidé par la page principale, qui connaît l'épisode suivant.
    sendTo(main, 'mpv:event', 'next', {});
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 820,
    minWidth: 420,
    minHeight: 320,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    ...(HIDDEN ? { x: -20000, y: -20000, skipTaskbar: true } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  main = win;
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

  // Diagnostic de développement (jamais dans l'app empaquetée) : `--smoke-eval=script.js
  // --smoke-out=rapport.json` exécute un script dans la page et enregistre son résultat.
  const smokeEval = !app.isPackaged && arg('smoke-eval');
  if (smokeEval) {
    win.webContents.once('did-finish-load', async () => {
      let result;
      try {
        result = await win.webContents.executeJavaScript(`(async () => { ${fs.readFileSync(smokeEval, 'utf8')} })()`);
      } catch (e) {
        result = { error: String(e) };
      }
      fs.writeFileSync(arg('smoke-out'), JSON.stringify(result, null, 2));
      app.exit(0);
    });
  }

  // Test de la mise à jour : `--smoke-update --smoke-out=rapport.json` simule une version
  // disponible et suit le bandeau de l'interface jusqu'à « Redémarrer ».
  if (process.argv.includes('--smoke-update')) {
    let loads = 0;
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const banner = () => js("(() => { const b = document.querySelector('.update-banner'); return b ? { text: b.querySelector('span').textContent.trim(), buttons: [...b.querySelectorAll('.btn')].map((x) => x.textContent.trim()) } : null; })()");
    win.webContents.on('did-finish-load', async () => {
      if (++loads === 1) return void (await js("localStorage.setItem('mp.demo','true'); location.reload()"));
      const report = {};
      try {
        await wait(3500);
        report.available = await banner();
        await js("document.querySelector('.update-banner .btn.primary')?.click()");
        await wait(400);
        report.downloading = await banner();
        await wait(1500);
        report.ready = await banner();
        await js("location.hash = '#/settings'");
        await wait(800);
        report.settingsRow = await js("[...document.querySelectorAll('.set-row')].map((r) => r.textContent.trim()).find((x) => /Version/.test(x))");
        await js("document.querySelector('.update-banner .btn.primary')?.click()");
        await wait(500);
        report.afterInstall = await banner();
      } catch (e) {
        report.error = String(e);
      }
      fs.writeFileSync(arg('smoke-out'), JSON.stringify(report, null, 2));
      app.exit(report.error ? 3 : 0);
    });
  }

  // Test du lecteur natif : `--smoke-native=rapport.json` passe en mode démo, lance
  // une lecture par l'interface, pilote les contrôles superposés comme un utilisateur,
  // puis écrit ce que mpv a réellement fait. Avec `--smoke-hidden`, rien n'apparaît à l'écran.
  const smokeNative = arg('smoke-native');
  if (smokeNative) {
    let loads = 0;
    const js = (code) => win.webContents.executeJavaScript(code);
    const ui = (code) => overlay.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const click = (selector) => ui(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    win.webContents.on('did-finish-load', async () => {
      if (++loads === 1) {
        // Un épisode de démonstration : il a un marqueur d'intro et un épisode suivant.
        await js("localStorage.setItem('mp.demo','true'); location.hash = '#/play/243?t=8'; location.reload()");
        return;
      }
      const report = {};
      try {
        await wait(9000 + (Number(arg('smoke-hold')) || 0));
        report.native = await js("!!window.multiplexNative && document.querySelector('.player')?.className");
        report.start = await player.info();
        report.overlay = await ui("({ title: document.querySelector('.player-title')?.textContent, time: document.querySelector('.seek')?.textContent, buttons: [...document.querySelectorAll('.controls .btn')].map((b) => b.textContent.trim() || b.getAttribute('aria-label')), skip: document.querySelector('.skip')?.textContent, bg: getComputedStyle(document.body).backgroundColor })");
        if (arg('smoke-shot')) {
          await ui("document.querySelector('.player')?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))");
          await wait(400);
          fs.writeFileSync(arg('smoke-shot'), (await overlay.webContents.capturePage()).toPNG());
          report.videoShot = await player.send(['screenshot-to-file', arg('smoke-shot').replace(/\.png$/, '-video.jpg'), 'video']);
        }
        // Passer l'intro, par le bouton.
        report.skipClicked = await click('.skip');
        await wait(2500);
        report.afterSkip = (await player.info())['time-pos'];
        // Pause, par le bouton.
        report.pauseClicked = await click('.controls .btn[data-act="toggle"]');
        await wait(800);
        report.paused = player.state.pause;
        report.pausedIcon = await ui("document.querySelector('.controls .btn[data-act=\"toggle\"]')?.getAttribute('aria-label')");
        await click('.controls .btn[data-act="toggle"]');
        // Déplacement, par la barre de progression.
        await ui("(() => { const r = document.querySelector('.seek input'); r.value = 300; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); })()");
        await wait(3500);
        report.afterSeekBar = (await player.info())['time-pos'];
        // Vitesse, par le menu.
        await click('.controls .btn[data-menu="speed"]');
        await wait(300);
        report.speedMenu = await ui("[...document.querySelectorAll('.player-menu button')].map((b) => b.textContent.trim())");
        await ui("[...document.querySelectorAll('.player-menu button')].find((b) => b.textContent.includes('1.5'))?.click()");
        await wait(600);
        report.speed = player.state.speed;
        // Qualité, par le menu : mpv doit repartir au même endroit sur le flux converti.
        await click('.controls .btn[data-menu="quality"]');
        await wait(300);
        report.qualityMenu = await ui("[...document.querySelectorAll('.player-menu button')].map((b) => b.textContent.trim()).length");
        await ui("[...document.querySelectorAll('.player-menu button')].find((b) => b.textContent.includes('720p'))?.click()");
        await wait(7000);
        report.afterQuality = { time: (await player.info())?.['time-pos'], overlay: !!overlay, chip: overlay ? await ui("document.querySelector('.chip')?.textContent") : null, label: overlay ? await ui("document.querySelector('.controls .btn[data-menu=\"quality\"]')?.textContent") : null };
        // Muet, par le bouton.
        await click('.controls .btn[data-act="mute"]');
        await wait(500);
        report.mute = player.state.mute;
        // Épisode suivant, par le bouton.
        report.nextClicked = await click('.controls .btn[data-act="next"]');
        await wait(7000);
        report.afterNext = { hash: await js('location.hash'), overlay: !!overlay, time: (await player.info())?.['time-pos'] };
        // Retour, par le bouton.
        report.backClicked = await click('.player-top .btn');
        await wait(2500);
        report.afterBack = { running: !!player.proc, overlay: !!overlay, hash: await js('location.hash') };
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
  // Mise à jour automatique (inactive pendant les tests, sauf simulation demandée).
  if (process.argv.includes('--smoke-update')) setupUpdater((state) => sendTo(main, 'update:event', state), { simulate: true });
  else if (!arg('smoke') && !arg('smoke-native') && !arg('smoke-eval')) setupUpdater((state) => sendTo(main, 'update:event', state));
  else setupUpdater(() => {}, {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => void player?.stop());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
