const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pancakeDesktop', {
  getEnv: () => ipcRenderer.invoke('app:get-env'),
  getAuthStatus: () => ipcRenderer.invoke('auth:get-status'),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
  logout: () => ipcRenderer.invoke('auth:logout'),
  onAuthStatus: (callback) => ipcRenderer.on('auth:status', (_evt, status) => callback(status)),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  showMessage: (options) => ipcRenderer.invoke('app:show-message', options),
  openDevTools: (webContentsId) => ipcRenderer.invoke('app:open-devtools', { webContentsId }),
  openOrderWindow: (url) => ipcRenderer.invoke('app:open-order-window', { url }),
  setBotActive: (payload) => ipcRenderer.invoke('app:set-bot-active', payload),
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
