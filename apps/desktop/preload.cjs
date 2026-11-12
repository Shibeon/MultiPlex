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
});
