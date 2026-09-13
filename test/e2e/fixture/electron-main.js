'use strict';

const { app, BrowserWindow, session } = require('electron');

const fixtureOrigin = process.env.PDB_E2E_ORIGIN;
const userDataDir = process.env.PDB_E2E_USER_DATA_DIR;
const hostPath = process.env.PDB_E2E_HOST_PATH || '/host';

if (!fixtureOrigin || !userDataDir) {
  throw new Error('PDB_E2E_ORIGIN and PDB_E2E_USER_DATA_DIR are required');
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.setPath('userData', userDataDir);

function installNetworkIsolation(targetSession) {
  targetSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      let allowed = false;
      try {
        allowed = new URL(details.url).origin === fixtureOrigin;
      } catch (_) {}
      callback({ cancel: !allowed });
    }
  );
}

app.whenReady().then(async () => {
  installNetworkIsolation(session.defaultSession);
  installNetworkIsolation(session.fromPartition('persist:pancake-e2e'));

  const window = new BrowserWindow({
    show: true,
    width: 1000,
    height: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false
    }
  });

  await window.loadURL(`${fixtureOrigin}${hostPath}`);
});

app.on('window-all-closed', () => app.quit());
