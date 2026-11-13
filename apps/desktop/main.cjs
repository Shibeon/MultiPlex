// Coque de bureau : affiche le build web dans une fenêtre native et lui
// fournit un lecteur natif (mpv). Lancer `pnpm desktop` à la racine.
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { MpvPlayer, listAudioDevices, findMpv } = require('./mpv.cjs');
const { OfflineLibrary } = require('./offline.cjs');
const { discover: castDiscover, CastSession } = require('./cast.cjs');
const { Thumbnailer } = require('./thumbs.cjs');
const { setupUpdater } = require('./updater.cjs');
const { RefreshMatcher } = require('./display.cjs');

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
// --smoke-fresh : profil vierge à chaque lancement (premier démarrage, sans serveur).
if (process.argv.includes('--smoke-fresh')) {
  const fresh = path.join(app.getPath('temp'), 'multiplex-smoke-fresh');
  fs.rmSync(fresh, { recursive: true, force: true });
  app.setPath('userData', fresh);
} else if (process.argv.includes('--smoke-isolated') || arg('smoke') || arg('smoke-native') || arg('smoke-passthrough') ||arg('smoke-update-check') || process.argv.includes('--smoke-update')) app.setPath('userData', path.join(app.getPath('temp'), 'multiplex-smoke-profile'));

/** Fenêtre principale, lecteur natif et fenêtre de contrôles superposée. */
let main = null;
let player = null;
let overlay = null;
/** Ce que la page principale sait du titre en cours (titres, marqueurs, pistes), pour les contrôles. */
let meta = {};
/** Accord de la fréquence de l'écran à la vidéo, et si la lecture en cours le demande. */
let matcher = null;
/** Aperçus en image pour la barre de lecture (second mpv invisible). */
const thumbs = new Thumbnailer(app, findMpv);
ipcMain.handle('thumb:get', (_e, time) => thumbs.get(time));
let matchOn = false;
let focusTimer = null;
/** Plein écran demandé pendant la lecture : on en sort quand elle se termine (sauf enchaînement). */
let fsByPlayback = false;
let fsTimer = null;
function togglePlaybackFullscreen() {
  if (!main || main.isDestroyed()) return;
  fsByPlayback = !main.isFullScreen();
  main.setFullScreen(fsByPlayback);
}
function playbackOver() {
  clearTimeout(fsTimer);
  // Un épisode suivant peut démarrer dans la foulée : on attend un instant avant de rendre la fenêtre.
  fsTimer = setTimeout(() => {
    if (fsByPlayback && main && !main.isDestroyed() && main.isFullScreen()) main.setFullScreen(false);
    fsByPlayback = false;
  }, 1500);
}
/** L'application est-elle au premier plan ? (La fenêtre de contrôles en fait partie.) */
function syncFocus() {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    const alive = (w) => w && !w.isDestroyed();
    matcher?.setFocused(HIDDEN || (alive(main) && main.isFocused()) || (alive(overlay) && overlay.isFocused()));
  }, 400);
}

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
      togglePlaybackFullscreen();
    }
  });
  win.loadFile(INDEX, { hash: '/overlay' });
  win.once('ready-to-show', () => !win.isDestroyed() && (HIDDEN ? win.showInactive() : win.show()));
  win.on('closed', () => {
    if (overlay === win) overlay = null;
  });
  win.on('focus', syncFocus);
  win.on('blur', syncFocus);
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
    if (type === 'ended' || type === 'error') {
      playbackOver();
      thumbs.stop();
      closeOverlay();
      matcher?.release();
    } else if (type === 'state' && data.name === 'container-fps' && typeof data.value === 'number' && matchOn) {
      matcher?.want(data.value);
    }
  });
  if (HIDDEN) player.muted = true;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  matcher = new RefreshMatcher({
    hwnd: () => {
      const h = win.getNativeWindowHandle();
      return h.length === 8 ? h.readBigUInt64LE(0).toString() : h.readUInt32LE(0).toString();
    },
    // Tests hors écran : on demande seulement à Windows si le mode serait accepté.
    test: HIDDEN,
    // L'écran reste noir une seconde ou deux en changeant de fréquence : la vidéo attend.
    around: async (change) => {
      const playing = !!player?.proc && player.state.pause === false;
      if (playing) await player.command('pause', true);
      try {
        await change();
      } finally {
        if (playing) {
          await wait(HIDDEN ? 0 : 1800);
          await player?.command('pause', false);
        }
      }
    },
  });
  win.on('focus', syncFocus);
  win.on('blur', syncFocus);
  win.on('minimize', syncFocus);
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) win.on(ev, syncOverlay);
  win.on('closed', () => {
    closeOverlay();
    matcher?.restoreSync();
    void player?.stop();
    player = null;
    main = null;
  });
}

ipcMain.handle('mpv:available', () => !!player?.available());

// --- « Qui est à l'écran ? » : reconnaissance de visages, calculée dans la fenêtre de contrôles ---
// L'application ne fait que fournir la matière : le modèle (embarqué), l'image en pause et
// les photos de la distribution. Rien n'est envoyé ailleurs.
const XRAY_MODELS = new Set(['ssd_mobilenetv1_model-weights_manifest.json', 'ssd_mobilenetv1_model.bin', 'face_landmark_68_model-weights_manifest.json', 'face_landmark_68_model.bin', 'face_recognition_model-weights_manifest.json', 'face_recognition_model.bin']);
const XRAY_DIR = app.isPackaged ? path.join(process.resourcesPath, 'xray') : path.join(__dirname, '..', 'web', 'node_modules', '@vladmandic', 'face-api', 'model');
ipcMain.handle('xray:model', (_e, name) => {
  if (!XRAY_MODELS.has(String(name))) return null;
  try {
    return fs.readFileSync(path.join(XRAY_DIR, String(name)));
  } catch {
    return null;
  }
});
ipcMain.handle('xray:frame', () => player?.frame() ?? null);
ipcMain.handle('xray:photo', async (_e, url) => {
  // Uniquement les serveurs d'images des fiches (Plex, TMDB), jamais une adresse quelconque.
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !['metadata-static.plex.tv', 'image.tmdb.org'].includes(u.hostname)) return null;
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > 4 * 1024 * 1024 ? null : `data:${type.split(';')[0]};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
});

// La reconnaissance tourne dans une fenêtre invisible à part, avec son propre processus :
// son calcul (jusqu'à plusieurs secondes d'un bloc au premier usage) ne peut plus figer
// les contrôles du lecteur. Elle est fermée avec la fenêtre principale.
let xrayWin = null;
let xrayReady = null;
let xrayJob = 0;
const xrayJobs = new Map();
function xrayWorker() {
  if (xrayWin && !xrayWin.isDestroyed()) return xrayReady;
  if (!main || main.isDestroyed()) return Promise.reject(new Error('pas de fenêtre'));
  const win = new BrowserWindow({
    parent: main,
    show: false,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload, backgroundThrottling: false },
  });
  xrayWin = win;
  xrayReady = new Promise((resolve) => {
    const ready = (e) => {
      if (e.sender !== win.webContents) return;
      ipcMain.removeListener('xray:ready', ready);
      resolve();
    };
    ipcMain.on('xray:ready', ready);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', () => !win.isDestroyed() && win.destroy());
  win.on('closed', () => {
    if (xrayWin === win) xrayWin = null;
    for (const done of xrayJobs.values()) done(null);
    xrayJobs.clear();
  });
  win.loadFile(INDEX, { hash: '/xray-worker' });
  return xrayReady;
}
ipcMain.handle('xray:run', async (_e, kind, cast) => {
  if (!['who', 'warm'].includes(kind) || !Array.isArray(cast)) return null;
  const clean = cast.slice(0, 60).map((p) => ({ key: typeof p?.key === 'string' ? p.key : undefined, name: String(p?.name ?? ''), thumb: typeof p?.thumb === 'string' ? p.thumb : undefined }));
  try {
    await xrayWorker();
  } catch {
    return null;
  }
  const id = ++xrayJob;
  return new Promise((resolve) => {
    xrayJobs.set(id, resolve);
    sendTo(xrayWin, 'xray:job', id, kind, clean);
  });
});
ipcMain.on('xray:result', (e, id, result) => {
  if (!xrayWin || e.sender !== xrayWin.webContents) return;
  const done = xrayJobs.get(id);
  xrayJobs.delete(id);
  done?.(result ?? null);
});
ipcMain.on('xray:cancel', () => sendTo(xrayWin, 'xray:cancel'));

// --- Télécharger le fichier d'un titre (menu « Télécharger ») ---
// Le fichier d'origine, tel qu'il est sur le serveur ; Windows demande où l'enregistrer.
// Le jeton voyage en en-tête. Chaque téléchargement est suivi (progression, débit) et
// annulable depuis la page ; la progression globale s'affiche aussi sur l'icône de la barre des tâches.
const pendingDownloads = new Map(); // adresse → { id, name }
const downloads = new Map(); // id → DownloadItem
let downloadSeq = 0;
let downloadsWired = false;
function taskbarProgress() {
  if (!main || main.isDestroyed()) return;
  let got = 0;
  let total = 0;
  for (const item of downloads.values()) {
    if (item.getState() !== 'progressing') continue;
    got += item.getReceivedBytes();
    total += item.getTotalBytes();
  }
  main.setProgressBar(downloads.size ? (total ? got / total : 2) : -1);
}
function wireDownloads(win) {
  if (downloadsWired) return;
  downloadsWired = true;
  win.webContents.session.on('will-download', (_e, item) => {
    const known = pendingDownloads.get(item.getURL());
    pendingDownloads.delete(item.getURL());
    const id = known?.id ?? ++downloadSeq;
    const name = known?.name ?? item.getFilename();
    const send = (state, extra = {}) => sendTo(main, 'download:event', { id, state, name, title: known?.title, offline: !!known?.offlineId, offlineId: known?.offlineId, received: item.getReceivedBytes(), total: item.getTotalBytes(), ...extra });
    // Hors ligne : le fichier va directement dans la bibliothèque, sans fenêtre « Enregistrer sous ».
    if (known?.savePath) item.setSavePath(known.savePath);
    else if (HIDDEN && arg('smoke-download-dir')) item.setSavePath(path.join(arg('smoke-download-dir'), name));
    else item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), name) });
    item.offlineId = known?.offlineId;
    downloads.set(id, item);
    // Pause et reprise ne déclenchent pas toujours « updated » : la page est prévenue directement.
    item.notify = () => send(item.isPaused() ? 'paused' : 'progressing');
    // « waiting » tant que l'emplacement n'est pas choisi ; ensuite la progression, au plus deux fois par seconde.
    send('waiting');
    let last = 0;
    let lastBytes = 0;
    item.on('updated', (_ev, state) => {
      const now = Date.now();
      if (now - last < 500 && state === 'progressing') return;
      const bytes = item.getReceivedBytes();
      const rate = last ? ((bytes - lastBytes) * 1000) / (now - last) : 0;
      last = now;
      lastBytes = bytes;
      send(state === 'interrupted' ? 'stalled' : item.isPaused() ? 'paused' : 'progressing', { rate: Math.max(0, Math.round(rate)), path: item.getSavePath() || undefined });
      taskbarProgress();
      // Hors ligne : un fichier qui ne peut pas reprendre seul passe en échec (bouton « Réessayer »).
      if (state === 'interrupted' && item.offlineId && !item.canResume()) {
        offlineLib().update(item.offlineId, { state: 'failed' });
        sendTo(main, 'offline:changed');
      }
    });
    item.once('done', (_ev, state) => {
      downloads.delete(id);
      taskbarProgress();
      if (item.offlineId) {
        const lib = offlineLib();
        if (state === 'completed') lib.update(item.offlineId, { state: 'ready', size: item.getTotalBytes() || item.getReceivedBytes() });
        else if (state === 'cancelled') lib.remove(item.offlineId);
        else lib.update(item.offlineId, { state: 'failed' });
        sendTo(main, 'offline:changed');
      }
      send(state, { path: state === 'completed' ? item.getSavePath() : undefined });
    });
  });
}
ipcMain.handle('file:download', (_e, url, headers, name) => {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return 0;
  }
  // Uniquement le fichier d'un titre du serveur, jamais une adresse quelconque.
  if (!['http:', 'https:'].includes(u.protocol) || !u.pathname.startsWith('/library/parts/') || !main) return 0;
  u.searchParams.set('download', '1');
  const clean = {};
  for (const [k, v] of Object.entries(headers ?? {})) if (/^X-Plex-[A-Za-z-]+$/.test(k)) clean[k] = String(v);
  wireDownloads(main);
  const id = ++downloadSeq;
  pendingDownloads.set(u.toString(), { id, name: String(name || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || path.basename(u.pathname) });
  main.webContents.downloadURL(u.toString(), { headers: clean });
  return id;
});
ipcMain.on('file:downloadAction', (_e, id, action) => {
  const item = downloads.get(Number(id));
  if (!item) return;
  if (action === 'cancel') item.cancel();
  else if (action === 'pause') {
    item.pause();
    item.notify?.();
  } else if (action === 'resume' && item.canResume()) {
    item.resume();
    item.notify?.();
  }
});
ipcMain.on('file:show', (_e, file) => {
  if (typeof file === 'string' && path.isAbsolute(file) && fs.existsSync(file)) shell.showItemInFolder(file);
});

// Repères d'intro communautaires (IntroDB). La page ne peut pas interroger ce service
// elle-même (il refuse les navigateurs) ; seuls un identifiant IMDb et un numéro
// d'épisode partent, rien du compte ni du serveur.
ipcMain.handle('introdb:segments', async (_e, imdb, season, episode) => {
  if (!/^tt\d{5,10}$/.test(String(imdb)) || !Number.isInteger(season) || !Number.isInteger(episode) || season < 0 || season > 200 || episode < 0 || episode > 5000) return null;
  try {
    const res = await fetch(`https://api.introdb.app/segments?imdb_id=${imdb}&season=${season}&episode=${episode}`, { signal: AbortSignal.timeout(6000), headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const j = await res.json();
    const pick = (s) => (s && typeof s === 'object' ? { start_sec: Number(s.start_sec), end_sec: Number(s.end_sec) } : null);
    return { intro: pick(j.intro), outro: pick(j.outro) };
  } catch {
    return null;
  }
});

/** Sorties audio connues ; relues à chaque demande de l'interface, et si une sortie choisie manque. */
let audioDevices = [];
const refreshAudioDevices = async () => (audioDevices = await listAudioDevices(app));
ipcMain.handle('audio:devices', refreshAudioDevices);
/** La sortie demandée si elle existe encore ; sinon rien (sortie du système), plutôt qu'une lecture muette. */
async function knownAudioDevice(id) {
  if (typeof id !== 'string' || !id) return undefined;
  if (!audioDevices.some((d) => d.id === id)) await refreshAudioDevices();
  return audioDevices.some((d) => d.id === id) ? id : undefined;
}
ipcMain.handle('mpv:play', async (_e, opts) => {
  // L'interface ne peut faire lire que des adresses web, jamais un fichier local ni une option mpv.
  const web = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);
  if (!player || !opts || !web(opts.url)) throw new Error('Demande de lecture invalide');
  // En-têtes : uniquement ceux de Plex, sans saut de ligne (pas d'injection d'en-tête).
  const headers = Object.entries(opts.headers && typeof opts.headers === 'object' ? opts.headers : {})
    .filter(([k, v]) => /^X-Plex-[A-Za-z-]{1,40}$/.test(k) && typeof v === 'string' && /^[\x20-\x7E]{1,200}$/.test(v))
    .map(([k, v]) => `${k}: ${v}`);
  return startPlayback(opts.url, headers, (Array.isArray(opts.subFiles) ? opts.subFiles : []).filter(web).slice(0, 8), opts);
});

async function startPlayback(url, headers, subFiles, opts) {
  meta = {};
  clearTimeout(fsTimer);
  matchOn = !!opts.matchRefresh || (HIDDEN && !!arg('smoke-native'));
  if (HIDDEN && arg('smoke-native')) opts.seekPreview = true;
  if (!matchOn) matcher?.release();
  const result = await player.play({
    url,
    headers,
    title: String(opts.title ?? '').slice(0, 200),
    start: Number(opts.start) || 0,
    aid: Number.isInteger(opts.aid) ? opts.aid : undefined,
    sid: Number.isInteger(opts.sid) ? opts.sid : undefined,
    subFiles,
    passthrough: !!opts.passthrough,
    audioDevice: await knownAudioDevice(opts.audioDevice),
    buffered: !!opts.buffered,
  });
  // Aperçus : seulement pour le fichier d'origine (un flux converti ne se parcourt pas librement).
  if (opts.seekPreview && !opts.buffered) void thumbs.start(url, headers);
  else thumbs.stop();
  openOverlay();
  return result;
}

// --- Bibliothèque hors ligne ---
let offline = null;
const offlineLib = () => (offline ??= new OfflineLibrary(app, HIDDEN ? arg('smoke-offline-dir') : undefined));
const serverUrl = (u, origin) => {
  try {
    const x = new URL(String(u));
    return ['http:', 'https:'].includes(x.protocol) && (!origin || x.origin === origin) ? x : null;
  } catch {
    return null;
  }
};
ipcMain.handle('offline:info', () => offlineLib().info());
ipcMain.handle('offline:chooseDir', async () => {
  const r = await dialog.showOpenDialog(main, { properties: ['openDirectory', 'createDirectory'], defaultPath: offlineLib().dir });
  if (r.canceled || !r.filePaths[0]) return { ok: false };
  try {
    offlineLib().setDir(r.filePaths[0]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
});
ipcMain.handle('offline:add', async (_e, p) => {
  const file = serverUrl(p?.url);
  if (!file || !file.pathname.startsWith('/library/parts/') || !main) return { ok: false };
  const headers = {};
  for (const [k, v] of Object.entries(p.headers ?? {})) if (/^X-Plex-[A-Za-z-]+$/.test(k) && /^[\x20-\x7E]{1,200}$/.test(String(v))) headers[k] = String(v);
  const lib = offlineLib();
  const existing = lib.get(lib.idOf(p));
  if (existing && (existing.state === 'ready' || existing.state === 'downloading')) return { ok: true, id: existing.id, already: true };
  let entry;
  try {
    entry = lib.prepare(p);
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
  // Affiche, fond, sous-titres externes : uniquement depuis le même serveur que le fichier.
  const extras = [];
  for (const img of (Array.isArray(p.images) ? p.images : []).slice(0, 2)) {
    const u = serverUrl(img?.url, file.origin);
    if (u && (img.kind === 'poster' || img.kind === 'art')) extras.push(lib.fetchExtra(entry, u, headers, `${img.kind}.jpg`).then((name) => name && (entry[img.kind] = name)));
  }
  (Array.isArray(p.subs) ? p.subs : []).slice(0, 8).forEach((s, i) => {
    const u = serverUrl(s?.url, file.origin);
    const ext = /^[a-z0-9]{2,5}$/i.test(String(s?.ext)) ? s.ext : 'srt';
    if (u) extras.push(lib.fetchExtra(entry, u, headers, `${entry.file.replace(/\.[^.]+$/, '')}.${i + 1}.${ext}`).then((name) => name && entry.subs.push({ file: name, label: String(s.label ?? '').slice(0, 120), index: i })));
  });
  await Promise.all(extras);
  entry.subs.sort((a, b) => a.index - b.index);
  lib.save();
  file.searchParams.set('download', '1');
  wireDownloads(main);
  const id = ++downloadSeq;
  pendingDownloads.set(file.toString(), { id, name: entry.file, title: [entry.title, entry.sub].filter(Boolean).join(' — '), offlineId: entry.id, savePath: path.join(lib.dir, entry.folder, entry.file) });
  main.webContents.downloadURL(file.toString(), { headers });
  sendTo(main, 'offline:changed');
  return { ok: true, id: entry.id };
});
ipcMain.handle('offline:remove', (_e, id) => {
  for (const item of downloads.values()) if (item.offlineId === id) item.cancel();
  offlineLib().remove(String(id));
  sendTo(main, 'offline:changed');
  return true;
});
ipcMain.on('offline:progress', (_e, id, viewOffset, watched) => {
  const e = offlineLib().get(String(id));
  if (!e) return;
  offlineLib().update(e.id, { viewOffset: Math.max(0, Number(viewOffset) || 0), watched: !!watched, dirty: true });
});
ipcMain.on('offline:synced', (_e, ids) => {
  const lib = offlineLib();
  for (const id of Array.isArray(ids) ? ids : []) if (lib.get(String(id))) lib.get(String(id)).dirty = false;
  lib.save();
});
ipcMain.handle('offline:play', async (_e, id, opts) => {
  const p = offlineLib().playable(String(id));
  if (!player || !p) throw new Error('Fichier hors ligne introuvable');
  return startPlayback(p.file, [], p.subFiles, { ...(opts && typeof opts === 'object' ? opts : {}), buffered: false });
});

// --- Envoi vers un téléviseur (Google Cast) ---
// La page choisit un appareil parmi ceux trouvés ici ; elle ne fournit jamais d'adresse.
let castDevices = [];
let cast = null;
ipcMain.handle('cast:scan', async () => {
  castDevices = await castDiscover(2500);
  // Tests : un récepteur factice local, jamais un vrai appareil.
  const fake = HIDDEN && arg('smoke-cast-device');
  if (fake) castDevices.unshift({ id: 'smoke', name: 'Récepteur de test', model: 'test', host: '127.0.0.1', port: Number(fake) || 8009 });
  return castDevices.map(({ id, name, model }) => ({ id, name, model }));
});
ipcMain.handle('cast:start', async (_e, deviceId, media) => {
  const device = castDevices.find((d) => d.id === String(deviceId));
  const url = serverUrl(media?.url);
  if (!device || !url) return { ok: false, error: 'invalid' };
  const image = media.image ? serverUrl(media.image, url.origin) : null;
  const previous = cast;
  cast = null;
  await previous?.stop();
  const s = new CastSession(device);
  cast = s;
  s.on('status', (st) => cast === s && sendTo(main, 'cast:status', { ...st, device: device.name }));
  s.on('closed', (reason) => {
    if (cast !== s) return;
    cast = null;
    sendTo(main, 'cast:status', { state: 'closed', reason, device: device.name });
  });
  try {
    await s.connect();
    await s.load({
      url: url.toString(),
      contentType: media.contentType === 'video/mp4' ? 'video/mp4' : 'application/x-mpegURL',
      title: String(media.title ?? '').slice(0, 200),
      sub: String(media.sub ?? '').slice(0, 200),
      kind: media.kind === 'episode' ? 'episode' : 'movie',
      image: image?.toString(),
      start: Math.max(0, Number(media.start) || 0),
      duration: Math.max(0, Number(media.duration) || 0),
    });
    return { ok: true };
  } catch (e) {
    s.close('error');
    return { ok: false, error: String(e?.message ?? e) };
  }
});
ipcMain.on('cast:control', (_e, action, value) => cast?.control(String(action), value));
ipcMain.handle('cast:stop', async () => {
  await cast?.stop();
  return true;
});
ipcMain.handle('mpv:stop', () => {
  playbackOver();
  thumbs.stop();
  closeOverlay();
  matcher?.release();
  return player?.stop();
});
ipcMain.handle('mpv:command', async (_e, name, value) => {
  if (name === 'audioDevice') {
    // Changement de sortie audio en cours de lecture : une sortie connue, ou celle du système.
    const id = value ? await knownAudioDevice(value) : 'auto';
    if (!id || !player) return undefined;
    // La page principale retient ce choix pour les lectures suivantes.
    sendTo(main, 'mpv:event', 'audioDevice', { id: id === 'auto' ? '' : id });
    return player.send(['set_property', 'audio-device', id]);
  }
  return player?.command(String(name), value);
});
ipcMain.handle('mpv:info', () => player?.info());

// --- Fenêtre de contrôles ---
ipcMain.handle('overlay:init', () => ({ meta, state: player?.state ?? {} }));
ipcMain.on('overlay:meta', (e, data) => {
  // Seule la page principale décrit le titre en cours.
  if (!main || e.sender !== main.webContents || !data || typeof data !== 'object') return;
  meta = { ...meta, ...data };
  sendTo(overlay, 'overlay:meta', meta);
});
ipcMain.on('window:fullscreen', (e, on) => {
  if (main && !main.isDestroyed() && e.sender === main.webContents && !HIDDEN) main.setFullScreen(!!on);
});
ipcMain.on('overlay:action', (_e, name) => {
  const person = typeof name === 'string' && /^person:[0-9a-f]{16,40}$/i.test(name) ? name.slice(7) : '';
  if (name === 'back' || name === 'cast' || person) {
    // Arrêt demandé par les contrôles : la page principale doit l'apprendre pour
    // enregistrer la position et revenir à la fiche.
    const time = player?.state['time-pos'] ?? 0;
    closeOverlay();
    playbackOver();
    thumbs.stop();
    matcher?.release();
    void player?.stop();
    sendTo(main, 'mpv:event', 'ended', { time, eof: false, cast: name === 'cast', goto: person ? `/person/${person}` : undefined });
  } else if (name === 'fullscreen') {
    togglePlaybackFullscreen();
  } else if (typeof name === 'string' && /^quality:[a-z0-9]{1,12}$/.test(name)) {
    // Le changement de qualité relance la lecture : c'est la page principale qui sait le faire.
    sendTo(main, 'mpv:event', 'quality', { id: name.slice(8) });
  } else if (name === 'prev') {
    sendTo(main, 'mpv:event', 'prev', {});
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
  // L'application s'ouvre en grand ; les tests, eux, restent hors écran.
  if (!HIDDEN) win.maximize();
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
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
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
      // Second script facultatif, exécuté dans la fenêtre de contrôles du lecteur.
      if (arg('smoke-overlay-js') && overlay) {
        try {
          result = { main: result, overlay: await overlay.webContents.executeJavaScript(`(async () => { ${fs.readFileSync(arg('smoke-overlay-js'), 'utf8')} })()`) };
        } catch (e) {
          result = { main: result, overlayError: String(e) };
        }
        if (arg('smoke-shot')) fs.writeFileSync(arg('smoke-shot').replace(/.png$/, '-overlay.png'), (await overlay.webContents.capturePage()).toPNG());
        await player?.stop();
      }
      fs.writeFileSync(arg('smoke-out'), JSON.stringify(result, null, 2));
      if (arg('smoke-shot')) fs.writeFileSync(arg('smoke-shot'), (await win.webContents.capturePage()).toPNG());
      app.exit(0);
    });
  }

  // Diagnostic de développement : `--smoke-passthrough=rapport.json --smoke-file=essai.mkv`
  // lit un fichier local avec la transmission audio brute et note si la lecture avance.
  const smokePass = !app.isPackaged && arg('smoke-passthrough');
  if (smokePass) {
    win.webContents.once('did-finish-load', async () => {
      const report = { notices: [] };
      const forward = player.emit;
      player.emit = (type, data) => (type === 'notice' && report.notices.push(data.code), forward(type, data));
      try {
        await player.play({ url: arg('smoke-file'), title: 'essai', passthrough: true, audioDevice: await knownAudioDevice(arg('smoke-audio')) });
        await new Promise((r) => setTimeout(r, 7000));
        report.ao = await player.send(['get_property', 'current-ao']);
        report.stage = player.stage;
        report.out = await player.send(['get_property', 'audio-out-params']);
        report.spdif = await player.send(['get_property', 'audio-spdif']);
        report.exclusive = await player.send(['get_property', 'audio-exclusive']);
        report.device = await player.send(['get_property', 'audio-device']);
        report.info = await player.info();
      } catch (e) {
        report.error = String(e);
      }
      fs.writeFileSync(smokePass, JSON.stringify(report, null, 2));
      await player.stop();
      app.exit(report.error ? 3 : 0);
    });
  }

  // Vérification réelle : `--smoke-update-check=rapport.json` interroge la vraie source de
  // mises à jour et enregistre la réponse (version proposée ou non). Rien n'est téléchargé.
  const updateCheck = arg('smoke-update-check');
  if (updateCheck) {
    const states = [];
    ipcMain.on('smoke:update-state', () => {});
    win.webContents.once('did-finish-load', async () => {
      const read = () => win.webContents.executeJavaScript('window.multiplexNative.updates.state()');
      await win.webContents.executeJavaScript('window.multiplexNative.updates.check()').catch(() => {});
      let last = null;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        last = await read().catch(() => null);
        if (last && !states.includes(last.status)) states.push(last.status);
        if (last && ['available', 'none', 'error'].includes(last.status)) break;
      }
      fs.writeFileSync(updateCheck, JSON.stringify({ states, last }, null, 2));
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
      // Le bandeau n'existe que si la mise à jour silencieuse est coupée : c'est ce parcours qu'on teste.
      if (++loads === 1) return void (await js("localStorage.setItem('mp.demo','true'); localStorage.setItem('mp.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('mp.settings') || '{}'), autoUpdate: false })); location.reload()"));
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
        // `--smoke-couch` : le même parcours, lecteur en mode TV (profil d'essai uniquement).
        if (process.argv.includes('--smoke-couch')) await js("localStorage.setItem('mp.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('mp.settings') || '{}'), couch: true }))");
        await js("localStorage.setItem('mp.demo','true'); location.hash = '#/play/243?t=8'; location.reload()");
        return;
      }
      const report = {};
      try {
        await wait(9000 + (Number(arg('smoke-hold')) || 0));
        report.native = await js("!!window.multiplexNative && document.querySelector('.player')?.className");
        report.start = await player.info();
        report.audioChip = await ui("document.querySelector('.chip[data-audio-out]')?.textContent.trim()");
        report.overlay = await ui("({ title: document.querySelector('.player-title')?.textContent, time: document.querySelector('.seek')?.textContent, buttons: [...document.querySelectorAll('.controls .btn')].map((b) => b.textContent.trim() || b.getAttribute('aria-label')), skip: document.querySelector('.skip')?.textContent, bg: getComputedStyle(document.body).backgroundColor })");
        if (arg('smoke-shot')) {
          await ui("document.querySelector('.player')?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))");
          await wait(400);
          fs.writeFileSync(arg('smoke-shot'), (await overlay.webContents.capturePage()).toPNG());
          report.videoShot = await player.send(['screenshot-to-file', arg('smoke-shot').replace(/\.png$/, '-video.jpg'), 'video']);
        }
        // Mode TV : pilotage aux flèches, comme avec une télécommande.
        if (process.argv.includes('--smoke-couch')) {
          const key = async (keyCode) => {
            overlay.webContents.sendInputEvent({ type: 'keyDown', keyCode });
            overlay.webContents.sendInputEvent({ type: 'keyUp', keyCode });
            await wait(250);
            return ui("document.activeElement?.dataset?.act || document.activeElement?.dataset?.menu || document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName");
          };
          const before = (await player.info())['time-pos'];
          await key('Right');
          const afterRight = (await player.info())['time-pos'];
          report.couch = {
            layout: await ui("({ couch: document.querySelector('.player')?.classList.contains('couch-player'), clock: document.querySelector('.couch-clock')?.textContent, play: Math.round(document.querySelector('[data-act=\"toggle\"]').getBoundingClientRect().width), title: getComputedStyle(document.querySelector('.player-title strong')).fontSize })"),
            rightSeeks: Math.round(afterRight - before),
            focus: [await key('Up'), await key('Right'), await key('Right'), await key('Left'), await key('Left'), await key('Down'), await key('Up'), await key('Up')],
          };
          if (arg('smoke-shot')) fs.writeFileSync(arg('smoke-shot').replace(/\.png$/, '-couch.png'), (await overlay.webContents.capturePage()).toPNG());
          await ui('document.activeElement?.blur()');
        }
        // Passer l'intro, par le bouton.
        report.skipClicked = await click('.skip');
        await wait(2500);
        report.afterSkip = (await player.info())['time-pos'];
        // Pause, par le bouton.
        report.pauseClicked = await click('.controls .btn[data-act="toggle"]');
        await wait(800);
        report.paused = player.state.pause;
        report.pauseCast = await ui("document.querySelectorAll('.pause-cast-card').length");
        report.pausedIcon = await ui("document.querySelector('.controls .btn[data-act=\"toggle\"]')?.getAttribute('aria-label')");
        await click('.controls .btn[data-act="toggle"]');
        // Déplacement, par la barre de progression.
        await ui("(() => { const r = document.querySelector('.seek input'); r.value = 300; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); })()");
        await wait(3500);
        report.afterSeekBar = (await player.info())['time-pos'];
        // Aperçus de la barre de lecture.
        report.thumbs = await ui("(async () => { const a = await window.multiplexNative.thumb(120); const b = await window.multiplexNative.thumb(400); return [a, b].map((x) => (x ? x.slice(0, 22) + '… ' + x.length : null)); })()");
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
        // Sortie audio, par le menu.
        await click('.controls .btn[data-menu="output"]');
        await wait(400);
        report.outputMenu = await ui("[...document.querySelectorAll('.player-menu button')].map((b) => b.textContent.trim())");
        await ui("[...document.querySelectorAll('.player-menu button')][1]?.click()");
        await wait(1500);
        report.output = { device: player.state['audio-device'], ao: await player.send(['get_property', 'current-ao']), time: (await player.info())?.['time-pos'], saved: await js("JSON.parse(localStorage.getItem('mp.settings') || '{}').audioDevice") };
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
        report.refresh = matcher?.log;
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
  else if (arg('smoke-update-check') || (!arg('smoke') && !arg('smoke-native') && !arg('smoke-eval'))) setupUpdater((state) => sendTo(main, 'update:event', state));
  else setupUpdater(() => {}, {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  thumbs.stop();
  matcher?.restoreSync();
  void player?.stop();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
