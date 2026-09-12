'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('compusync', {
  bootstrap: () => ipcRenderer.invoke('sync:bootstrap'),
  // Input remains a narrow, data-only channel. Main validates the sender and
  // every action type before it can reach the authoritative session reducer.
  input: (action) => ipcRenderer.send('sync:input', action),
  command: (name, data) => ipcRenderer.invoke('sync:command', name, data),
  onState: (callback) => subscribe('sync:state', callback),
  onDetails: (callback) => subscribe('sync:details', callback),
  onConnection: (callback) => subscribe('sync:connection', callback),
  onRelease: (callback) => subscribe('sync:release', callback),
  onHandoffBusy: (callback) => subscribe('sync:handoff-busy', callback),
  desktop: {
    bootstrap: () => ipcRenderer.invoke('desktop:bootstrap'),
    list: (workspacePath = '') => ipcRenderer.invoke('desktop:command', 'list', { path: workspacePath }),
    importPicker: (target = '') => ipcRenderer.invoke('desktop:command', 'import-picker', { target }),
    importDroppedFiles: (files, target = '') => ipcRenderer.invoke('desktop:command', 'import-paths', {
      target,
      paths: Array.from(files || [], (file) => webUtils.getPathForFile(file)).filter(Boolean),
    }),
    mkdir: (parent, name) => ipcRenderer.invoke('desktop:command', 'mkdir', { parent, name }),
    rename: (workspacePath, name) => ipcRenderer.invoke('desktop:command', 'rename', { path: workspacePath, name }),
    delete: (workspacePath) => ipcRenderer.invoke('desktop:command', 'delete', { path: workspacePath }),
    launchTextEditor: (workspacePath) => ipcRenderer.invoke('desktop:command', 'program-launch', { path: workspacePath, kind: 'text-editor' }),
    programInput: (programId, input) => ipcRenderer.invoke('desktop:command', 'program-input', { programId, input }),
    closeProgram: (programId) => ipcRenderer.invoke('desktop:command', 'program-close', { programId }),
    onState: (callback) => subscribe('desktop:state', callback),
    onFrame: (callback) => subscribe('desktop:frame', callback),
    onTransfer: (callback) => subscribe('desktop:transfer', callback),
  },
});
