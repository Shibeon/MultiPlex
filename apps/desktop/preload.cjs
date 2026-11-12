// Pont entre l'interface web (isolée) et le lecteur natif. Seules ces
// quelques fonctions sont exposées : la page n'a accès ni à Node ni au système.
const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, map) => (listener) => {
  const handler = (_e, ...args) => listener(...map(args));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('multiplexNative', {
  /** Vrai si mpv est disponible sur cette machine. */
  available: () => ipcRenderer.invoke('mpv:available'),
  play: (opts) => ipcRenderer.invoke('mpv:play', opts),
  stop: () => ipcRenderer.invoke('mpv:stop'),
  command: (name, value) => ipcRenderer.invoke('mpv:command', name, value),
  info: () => ipcRenderer.invoke('mpv:info'),
  /** Sorties audio de la machine : [{ id, label }]. */
  audioDevices: () => ipcRenderer.invoke('audio:devices'),
  platform: process.platform,
  /** « Qui est à l'écran ? » : modèle embarqué, image en pause, photo d'une personne. */
  xray: {
    model: (name) => ipcRenderer.invoke('xray:model', String(name)),
    frame: () => ipcRenderer.invoke('xray:frame'),
    photo: (url) => ipcRenderer.invoke('xray:photo', String(url)),
    /** Lance la reconnaissance dans la fenêtre invisible dédiée : 'who' (image en pause) ou 'warm' (préparation). */
    run: (kind, cast) => ipcRenderer.invoke('xray:run', String(kind), cast),
    /** Abandonne les calculs en cours (reprise de la lecture). */
    cancel: () => ipcRenderer.send('xray:cancel'),
  },
  /** Fenêtre invisible de reconnaissance : reçoit les travaux et rend les résultats. */
  xrayWorker: {
    ready: () => ipcRenderer.send('xray:ready'),
    onJob: subscribe('xray:job', ([id, kind, cast]) => [id, kind, cast]),
    onCancel: subscribe('xray:cancel', () => []),
    result: (id, result) => ipcRenderer.send('xray:result', id, result),
  },
  /** Télécharge le fichier d'un titre (adresse du serveur, en-têtes Plex, nom proposé). */
  download: (url, headers, name) => ipcRenderer.invoke('file:download', String(url), headers, String(name ?? '')),
  /** Montre un fichier téléchargé dans l'explorateur. */
  showFile: (file) => ipcRenderer.send('file:show', String(file)),
  onDownload: subscribe('download:event', ([state]) => [state]),
  /** Met la fenêtre principale en plein écran, ou l'en sort. */
  setFullscreen: (on) => ipcRenderer.send('window:fullscreen', !!on),
  /** Aperçu en image à une position (secondes) : adresse « data: » ou null. */
  thumb: (time) => ipcRenderer.invoke('thumb:get', Number(time) || 0),
  /** Repères d'intro communautaires pour un épisode (IntroDB). */
  segments: (imdb, season, episode) => ipcRenderer.invoke('introdb:segments', imdb, season, episode),
  /** S'abonne aux évènements du lecteur ; renvoie la fonction de désabonnement. */
  on: subscribe('mpv:event', ([type, data]) => [type, data]),

  // --- Fenêtre de contrôles superposée à la vidéo ---
  /** Page principale : décrit le titre en cours (titres, marqueurs, pistes, épisode suivant). */
  setMeta: (meta) => ipcRenderer.send('overlay:meta', meta),
  /** Fenêtre de contrôles : état initial, puis mises à jour. */
  overlayInit: () => ipcRenderer.invoke('overlay:init'),
  onMeta: subscribe('overlay:meta', ([meta]) => [meta]),
  /** Fenêtre de contrôles : retour, plein écran, épisode suivant. */
  action: (name) => ipcRenderer.send('overlay:action', String(name)),

  // --- Mise à jour de l'application ---
  updates: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    on: subscribe('update:event', ([state]) => [state]),
  },
});
