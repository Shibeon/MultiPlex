// Pont entre l'interface web (isolée) et le lecteur natif. Seules ces
// quelques fonctions sont exposées : la page n'a accès ni à Node ni au système.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('multiplexNative', {
  /** Vrai si mpv est disponible sur cette machine. */
  available: () => ipcRenderer.invoke('mpv:available'),
  play: (opts) => ipcRenderer.invoke('mpv:play', opts),
  stop: () => ipcRenderer.invoke('mpv:stop'),
  command: (name, value) => ipcRenderer.invoke('mpv:command', name, value),
  info: () => ipcRenderer.invoke('mpv:info'),
  /** S'abonne aux évènements du lecteur ; renvoie la fonction de désabonnement. */
  on: (listener) => {
    const handler = (_e, type, data) => listener(type, data);
    ipcRenderer.on('mpv:event', handler);
    return () => ipcRenderer.removeListener('mpv:event', handler);
  },
});
