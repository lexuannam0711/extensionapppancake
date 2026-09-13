const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');

// Mock autoUpdater before loading bridge
const mockAutoUpdater = new EventEmitter();
mockAutoUpdater.autoDownload = false;
mockAutoUpdater.allowPrerelease = false;
mockAutoUpdater.autoInstallOnAppQuit = true;
mockAutoUpdater.downloadUpdate = () => { mockAutoUpdater.downloadCalled = true; };
mockAutoUpdater.checkForUpdates = async () => ({ updateInfo: { version: '3.1.0' } });
mockAutoUpdater.quitAndInstall = (isSilent, isForceRunAfter) => {
  mockAutoUpdater.quitCalled = true;
  mockAutoUpdater.quitArgs = { isSilent, isForceRunAfter };
};

// Intercept require for electron-updater
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'electron-updater') {
    return { autoUpdater: mockAutoUpdater };
  }
  return origRequire.apply(this, arguments);
};

const { createElectronUpdaterBridge } = require('../src/update/electronUpdaterBridge');

function resetMockAutoUpdater() {
  mockAutoUpdater.removeAllListeners();
  mockAutoUpdater.downloadCalled = false;
  mockAutoUpdater.quitCalled = false;
}

test.beforeEach(() => resetMockAutoUpdater());

// Restore require
Module.prototype.require = origRequire;

test('electronUpdaterBridge initial state is idle', () => {
  const bridge = createElectronUpdaterBridge();
  assert.equal(bridge.getState().status, 'idle');
  assert.equal(bridge.getState().error, null);
});

test('electronUpdaterBridge handles checking-for-update', () => {
  const sent = [];
  const bridge = createElectronUpdaterBridge({
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: (ch, d) => sent.push({ ch, d }) } })
  });
  mockAutoUpdater.emit('checking-for-update');
  assert.equal(bridge.getState().status, 'checking');
  assert.ok(sent.some((e) => e.ch === 'updater:state' && e.d.status === 'checking'));
});

test('electronUpdaterBridge handles download progress and update-downloaded', () => {
  const sent = [];
  const bridge = createElectronUpdaterBridge({
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: (ch, d) => sent.push({ ch, d }) } })
  });

  mockAutoUpdater.emit('download-progress', { percent: 45.5, bytesPerSecond: 1024 });
  assert.equal(bridge.getState().status, 'downloading');
  assert.equal(bridge.getState().progress.percent, 45.5);

  mockAutoUpdater.emit('update-downloaded', { version: '3.1.0' });
  assert.equal(bridge.getState().status, 'downloaded');
  assert.equal(bridge.getState().info.version, '3.1.0');
});

test('electronUpdaterBridge quitAndInstall delegates to autoUpdater', () => {
  mockAutoUpdater.quitCalled = false;
  const bridge = createElectronUpdaterBridge();
  const ok = bridge.quitAndInstall();
  assert.equal(ok, true);
  assert.equal(mockAutoUpdater.quitCalled, true);
});

test('electronUpdaterBridge blocks update if device is revoked on VPS', () => {
  const sent = [];
  const mockClient = {
    getStatus: () => ({ status: 'revoked' }),
    setUpdateStatus: () => {}
  };
  mockAutoUpdater.downloadCalled = false;

  const bridge = createElectronUpdaterBridge({
    getWindow: () => ({ isDestroyed: () => false, webContents: { send: (ch, d) => sent.push({ ch, d }) } }),
    controlPlaneClient: mockClient
  });

  mockAutoUpdater.emit('update-available', { version: '3.1.0' });
  assert.equal(bridge.getState().status, 'error');
  assert.match(bridge.getState().error, /blocked/i);
  assert.equal(mockAutoUpdater.downloadCalled, false);
});
