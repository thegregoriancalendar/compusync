'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('compusync', {
  bootstrap: () => ipcRenderer.invoke('sync:bootstrap'),
  command: (name, data) => ipcRenderer.invoke('sync:command', name, data),
  onDetails: (callback) => subscribe('sync:details', callback),
  onHandoffOverlay: (callback) => subscribe('sync:handoff-overlay', callback),
});
