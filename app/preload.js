'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('appWindow', {
  platform: process.platform,
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  close: () => ipcRenderer.invoke('window:close'),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: theme => ipcRenderer.invoke('window:set-theme', theme),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onState: handler => ipcRenderer.on('window:state', (_e, state) => handler(state)),
  onUpdateState: handler => {
    ipcRenderer.invoke('update:get-state').then(handler);
    return ipcRenderer.on('update:state', (_e, state) => handler(state));
  },
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getPathForFile: file => {
    try { return webUtils.getPathForFile(file); } catch { return file?.path || ''; }
  },
  downloadDependency: payload => ipcRenderer.invoke('dependency:download', payload),
  onDependencyProgress: handler => ipcRenderer.on('dependency:progress', (_e, state) => handler(state))
});
