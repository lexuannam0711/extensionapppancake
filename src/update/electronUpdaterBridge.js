const { autoUpdater } = require('electron-updater');

function createElectronUpdaterBridge({
  getWindow,
  controlPlaneClient = null,
  autoDownload = false,
  allowPrerelease = false,
  autoInstallOnAppQuit = true
} = {}) {
  let state = {
    status: 'idle', // 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'
    info: null,
    progress: null,
    error: null
  };

  function sendToWindow(channel, data) {
    try {
      const win = getWindow?.();
      if (win && !win.isDestroyed?.()) {
        win.webContents.send(channel, data);
      }
    } catch (_) {}
  }

  function setState(patch) {
    state = { ...state, ...patch };
    sendToWindow('updater:state', state);
    return state;
  }

  autoUpdater.autoDownload = autoDownload;
  autoUpdater.allowPrerelease = allowPrerelease;
  autoUpdater.autoInstallOnAppQuit = autoInstallOnAppQuit;

  autoUpdater.on('checking-for-update', () => {
    setState({ status: 'checking', error: null });
    controlPlaneClient?.setUpdateStatus('checking');
  });

  autoUpdater.on('update-available', async (info) => {
    setState({ status: 'available', info, error: null });
    controlPlaneClient?.setUpdateStatus('available');
    // ponytail: VPS kill-switch. If controlPlaneClient has isVersionBlocked,
    // check before downloading. Upgrade to command-based block when Sprint 2 ships.
    try {
      const blocked = controlPlaneClient?.getStatus?.()?.status === 'disabled'
        || controlPlaneClient?.getStatus?.()?.status === 'revoked';
      if (blocked) {
        setState({ status: 'error', error: 'Update blocked by admin' });
        sendToWindow('updater:error', { message: 'Bản cập nhật bị quản trị viên chặn.' });
        return;
      }
    } catch (_) {}
    sendToWindow('updater:available', info);
    // Auto download after VPS check passes
    try { autoUpdater.downloadUpdate(); } catch (_) {}
  });

  autoUpdater.on('update-not-available', (info) => {
    setState({ status: 'not-available', info, error: null });
    controlPlaneClient?.setUpdateStatus('current');
    sendToWindow('updater:not-available', info);
  });

  autoUpdater.on('download-progress', (progress) => {
    setState({ status: 'downloading', progress });
    sendToWindow('updater:progress', progress);
  });

  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'downloaded', info });
    controlPlaneClient?.setUpdateStatus('downloaded');
    sendToWindow('updater:downloaded', info);
  });

  autoUpdater.on('error', (error) => {
    const errorMsg = error?.message || String(error || 'Unknown update error');
    setState({ status: 'error', error: errorMsg });
    controlPlaneClient?.setUpdateStatus('error', errorMsg);
    sendToWindow('updater:error', { message: errorMsg });
  });

  async function checkForUpdates() {
    try {
      return await autoUpdater.checkForUpdates();
    } catch (err) {
      const errorMsg = err?.message || String(err);
      setState({ status: 'error', error: errorMsg });
      return null;
    }
  }

  function quitAndInstall() {
    try {
      autoUpdater.quitAndInstall(false, true);
      return true;
    } catch (_) {
      return false;
    }
  }

  function getState() {
    return { ...state };
  }

  return Object.freeze({
    checkForUpdates,
    quitAndInstall,
    getState,
    autoUpdater
  });
}

module.exports = { createElectronUpdaterBridge };
