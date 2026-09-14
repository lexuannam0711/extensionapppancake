const { autoUpdater } = require('electron-updater');

function createElectronUpdaterBridge({
  getWindow,
  controlPlaneClient = null,
  autoDownload = false,
  allowPrerelease = false,
  autoInstallOnAppQuit = true
} = {}) {
  let state = {
    status: 'idle',
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

  const onChecking = () => {
    setState({ status: 'checking', error: null });
    controlPlaneClient?.setUpdateStatus('checking');
  };

  const onAvailable = async (info) => {
    setState({ status: 'available', info, error: null });
    controlPlaneClient?.setUpdateStatus('available');
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
    try { await autoUpdater.downloadUpdate(); } catch (_) {}
  };

  const onNotAvailable = (info) => {
    setState({ status: 'not-available', info, error: null });
    controlPlaneClient?.setUpdateStatus('current');
    sendToWindow('updater:not-available', info);
  };

  const onProgress = (progress) => {
    setState({ status: 'downloading', progress });
    sendToWindow('updater:progress', progress);
  };

  const onDownloaded = (info) => {
    setState({ status: 'downloaded', info });
    controlPlaneClient?.setUpdateStatus('downloaded');
    sendToWindow('updater:downloaded', info);
  };

  const onError = (error) => {
    const raw = error?.message || String(error || 'Unknown update error');
    // If GitHub has no public release yet or feed parsing returns XML error,
    // treat it as quiet not-available so operator screen is not polluted.
    if (/cannot parse releases feed|no published versions|unable to find latest version|latest release artifacts/i.test(raw)) {
      setState({ status: 'not-available', info: null, error: null });
      controlPlaneClient?.setUpdateStatus('current');
      sendToWindow('updater:not-available', null);
      return;
    }
    const errorMsg = raw.split('\n')[0].replace(/\s{2,}/g, ' ').slice(0, 160);
    setState({ status: 'error', error: errorMsg });
    controlPlaneClient?.setUpdateStatus('error', errorMsg);
    sendToWindow('updater:error', { message: errorMsg });
  };

  autoUpdater.on('checking-for-update', onChecking);
  autoUpdater.on('update-available', onAvailable);
  autoUpdater.on('update-not-available', onNotAvailable);
  autoUpdater.on('download-progress', onProgress);
  autoUpdater.on('update-downloaded', onDownloaded);
  autoUpdater.on('error', onError);

  function dispose() {
    autoUpdater.removeListener('checking-for-update', onChecking);
    autoUpdater.removeListener('update-available', onAvailable);
    autoUpdater.removeListener('update-not-available', onNotAvailable);
    autoUpdater.removeListener('download-progress', onProgress);
    autoUpdater.removeListener('update-downloaded', onDownloaded);
    autoUpdater.removeListener('error', onError);
  }

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
    dispose,
    autoUpdater
  });
}

module.exports = { createElectronUpdaterBridge };
