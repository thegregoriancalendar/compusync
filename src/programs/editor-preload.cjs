'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('compusyncEditor', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('compusync-program:bootstrap'),
  save: (text) => ipcRenderer.invoke('compusync-program:save', { text }),
}));
