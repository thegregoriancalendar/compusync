'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('compusync', {
  bootstrap: () => ipcRenderer.invoke('sync:bootstrap'),
  input: (action) => ipcRenderer.send('sync:input', action),
  command: (name, data) => ipcRenderer.invoke('sync:command', name, data),
  onState: (callback) => subscribe('sync:state', callback),
  onDetails: (callback) => subscribe('sync:details', callback),
  onConnection: (callback) => subscribe('sync:connection', callback),
  onRelease: (callback) => subscribe('sync:release', callback),
});
