const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yomuDesktop', {
  revealImage: (url) => ipcRenderer.invoke('yomu:reveal-image', url),
  trashImage: (url) => ipcRenderer.invoke('yomu:trash-image', url),
});
