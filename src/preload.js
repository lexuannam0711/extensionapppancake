const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pancakeDesktop', {
  getEnv: () => ipcRenderer.invoke('app:get-env'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  showMessage: (options) => ipcRenderer.invoke('app:show-message', options),
  // Receive window visibility hints (minimize/restore) so the renderer can
  // pause polling and release memory when the app is not visible.
  onVisibilityChange: (callback) => {
    ipcRenderer.on('app:visibility', (_evt, state) => callback(state));
  },
  // Extension management (Chrome-like store).
  listExtensions: () => ipcRenderer.invoke('ext:list'),
  reloadExtensions: (folderName) => ipcRenderer.invoke('ext:reload', folderName),
  openExtensionsFolder: () => ipcRenderer.invoke('ext:open-folder')
});
