require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, webContents, safeStorage } = require('electron');
const { configureStorePaths } = require('./server/store');
const { createModernUpdater } = require('./update/modern-updater');
const { createElectronUpdaterBridge } = require('./update/electronUpdaterBridge');
const telegram = require('./server/telegram');
const extManager = require('./extensionManager');
const { createAutomationActivity } = require('./automationActivity');
const { isAllowedGuestNavigation, resolveGuestNavigation } = require('./guestSecurity');
const { resolvePreferredPancakeUrl } = require('./renderer/pancakeUrlPolicy');
const { isDevToolsEnabled, withDevToolsPreference } = require('./devtoolsPolicy');
const { createControlPlaneClient } = require('./control-plane/client');

// Silence the dev-only "allowpopups" security warning (webview needs popups
// for Pancake/Facebook OAuth flows). This warning never shows once packaged.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

let mainWindow;
let server;
let updater = null;
let periodicUpdateTimer = null;
let controlPlaneClient = null;
let controlPlaneInitialization = Promise.resolve();
const localApiToken = crypto.randomBytes(32).toString('base64url');
function readTrustedUpdateKey() {
  try { return fs.readFileSync(path.join(__dirname, 'update', 'trusted-public-key.pem'), 'utf8'); } catch (_) { return ''; }
}
let activePort = Number(process.env.PORT || 8787);
let visibleGcTimer = null;
let automationActivity = null;
const orderWindows = new Set();
const devToolsEnabled = isDevToolsEnabled();

function publishControlPlaneStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('auth:status', controlPlaneClient?.getStatus() || { configured: false, status: 'not_configured' });
}

function hasActiveAutomation() {
  return Boolean(automationActivity?.isActive());
}

function setAutomationThrottling(active) {
  for (const contents of webContents.getAllWebContents()) {
    const belongsToMainWindow = contents === mainWindow?.webContents
      || contents.hostWebContents === mainWindow?.webContents;
    if (!belongsToMainWindow) continue;
    try { contents.setBackgroundThrottling(!active); } catch (_) {}
  }
}

function resetAutomationActivity() {
  automationActivity?.reset();
  setAutomationThrottling(false);
}

// ---------------------------------------------------------------------------
// RAM optimization (safe, behavior-preserving)
// These switches reduce Chromium memory footprint and allow background tabs
// (the Pancake webview + control panel) to be throttled when not visible.
// ---------------------------------------------------------------------------
// Cap the V8 heap so a long-running session cannot grow unbounded.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384 --expose-gc');
// Let Chromium aggressively throttle/freeze background renderers.
app.commandLine.appendSwitch('enable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-features', 'BackForwardCache');
// Release memory more eagerly when the app is idle / in the background.
app.commandLine.appendSwitch('enable-aggressive-domstorage-flushing');

// Keep the on-disk/in-memory media + disk cache big enough that Pancake does
// not constantly re-fetch images/voice clips during a session.
app.commandLine.appendSwitch('disk-cache-size', String(96 * 1024 * 1024)); // 96MB
app.commandLine.appendSwitch('media-cache-size', String(48 * 1024 * 1024)); // 48MB

// Ensure only a single instance runs (a second instance would double RAM).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// ---------------------------------------------------------------------------
// Extension loading (delegated to extensionManager).
// extensions/ acts like a Chrome extension store: each sub-folder is one
// unpacked extension. They load into the webview's "persist:pancake" session.
// ---------------------------------------------------------------------------
async function loadExtensions() {
  try {
    const results = await extManager.loadAll();
    const ok = results.filter((r) => r.loaded).length;
    console.log(`[ext] Loaded ${ok}/${results.length} extension(s)`);
  } catch (error) {
    console.error('[ext] loadAll failed:', error.message);
  }
}

function registerIpcHandlers() {
  ipcMain.removeHandler('app:get-env');
  ipcMain.removeHandler('app:open-external');
  ipcMain.removeHandler('app:show-message');
  ipcMain.removeHandler('app:open-devtools');
  ipcMain.removeHandler('app:open-order-window');
  ipcMain.removeHandler('app:set-bot-active');
  ipcMain.removeHandler('auth:get-status');
  ipcMain.removeHandler('auth:login');
  ipcMain.removeHandler('auth:logout');
  ipcMain.removeHandler('ext:list');
  ipcMain.removeHandler('ext:reload');
  ipcMain.removeHandler('ext:open-folder');
  ipcMain.removeHandler('updater:get-state');
  ipcMain.removeHandler('updater:check');
  ipcMain.removeHandler('updater:quit-and-install');

  ipcMain.handle('app:get-env', () => ({
    serverUrl: `http://localhost:${activePort}`,
    pancakeUrl: resolvePreferredPancakeUrl(process.env.PREFERRED_PANCAKE_URL),
    apiToken: localApiToken,
    authConfigured: Boolean(controlPlaneClient?.getStatus().configured)
  }));

  ipcMain.handle('auth:get-status', () => controlPlaneClient?.getStatus() || { configured: false, status: 'not_configured' });

  ipcMain.handle('auth:login', async (_evt, payload = {}) => {
    if (!controlPlaneClient) throw new Error('Control plane is not configured');
    await controlPlaneInitialization;
    const result = await controlPlaneClient.login({ email: payload.email, password: payload.password });
    publishControlPlaneStatus();
    return result;
  });

  ipcMain.handle('auth:logout', async () => {
    const result = controlPlaneClient ? await controlPlaneClient.logout() : { configured: false, status: 'not_configured' };
    publishControlPlaneStatus();
    return result;
  });

  ipcMain.handle('app:open-external', async (_evt, url) => {
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('app:show-message', async (_evt, options) => dialog.showMessageBox(mainWindow, options));

  ipcMain.handle('app:open-devtools', (_evt, payload = {}) => {
    const requestedId = Number(payload.webContentsId);
    const target = Number.isInteger(requestedId) && requestedId > 0
      ? webContents.fromId(requestedId)
      : mainWindow?.webContents;
    const ownedByMainWindow = target === mainWindow?.webContents
      || target?.hostWebContents === mainWindow?.webContents;
    if (!target || target.isDestroyed?.() || !ownedByMainWindow) {
      throw new Error('Developer Tools target không hợp lệ');
    }
    target.openDevTools({ mode: 'detach', activate: true });
    return { ok: true, webContentsId: target.id };
  });

  ipcMain.handle('app:open-order-window', async (_evt, payload = {}) => {
    const rawUrl = String(payload.url || '').trim();
    const { classifyPancakeUrl } = require('./renderer/pancakeUrlPolicy');
    if (!isAllowedGuestNavigation(rawUrl) || classifyPancakeUrl(rawUrl) !== 'app') {
      throw new Error('URL đơn hàng không hợp lệ');
    }
    const orderWindow = new BrowserWindow({
      width: 1200,
      height: 820,
      title: 'Đơn hàng Pancake',
      webPreferences: {
        partition: 'persist:pancake',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        devTools: devToolsEnabled
      }
    });
    orderWindows.add(orderWindow);
    orderWindow.on('closed', () => orderWindows.delete(orderWindow));
    orderWindow.webContents.setWindowOpenHandler(({ url }) => ({
      action: isAllowedGuestNavigation(url) ? 'allow' : 'deny'
    }));
    orderWindow.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedGuestNavigation(url)) event.preventDefault();
    });
    orderWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    orderWindow.webContents.session.setPermissionCheckHandler(() => false);
    await orderWindow.loadURL(rawUrl);
    return { ok: true, webContentsId: orderWindow.webContents.id };
  });

  ipcMain.handle('app:set-bot-active', async (evt, payload = {}) => {
    const accepted = automationActivity?.update(
      evt.sender.id,
      payload.tabId,
      payload.active
    ) || false;
    const active = hasActiveAutomation();
    try {
      if (accepted && mainWindow && !mainWindow.isDestroyed()) setAutomationThrottling(active);
    } catch (_) {}
    return { accepted, active };
  });

  // --- Extension management IPC ---
  ipcMain.handle('ext:list', () => extManager.getStatuses());
  ipcMain.handle('ext:reload', async (_evt, folderName) => {
    if (folderName) return [await extManager.reloadOne(folderName)];
    return extManager.loadAll();
  });
  ipcMain.handle('ext:open-folder', async () => {
    await shell.openPath(extManager.EXT_ROOT);
    return extManager.EXT_ROOT;
  });
}

async function createWindow() {
  require('dotenv').config({ path: path.join(app.getPath('appData'), 'PancakeDesktopAIShortcutBot', '.env'), override: false });
  configureStorePaths({
    dataRoot: path.join(app.getPath('appData'), 'PancakeDesktopAIShortcutBot', 'data'),
    uploadsRoot: path.join(app.getPath('appData'), 'PancakeDesktopAIShortcutBot', 'uploads'),
    legacyRoot: path.resolve(__dirname, '../server/data')
  });
  const { startServer } = require('./server/index');
  controlPlaneClient = createControlPlaneClient({
    controlPlaneUrl: process.env.CONTROL_PLANE_URL,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    safeStorage,
    userDataPath: app.getPath('userData'),
    channel: 'modern',
    appVersion: app.getVersion(),
    os: process.platform,
    getMetadata: () => ({
      botActive: hasActiveAutomation(),
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      uptimeSeconds: Math.floor(process.uptime())
    })
  });
  activePort = Number(process.env.PORT || 8787);
  registerIpcHandlers();
  server = await startServer(activePort, { authToken: localApiToken });

  // Load extensions into the same session the webview uses
  // (partition "persist:pancake"). Best-effort: failure must not block startup.
  await loadExtensions();

  mainWindow = new BrowserWindow({
    width: 1450,
    height: 920,
    minWidth: 1150,
    minHeight: 740,
    title: 'Pancake Desktop AI Shortcut Bot v3',
    backgroundColor: '#f6fbf8',
    // Defer showing until content is ready to avoid a blank, memory-holding paint.
    show: false,
    webPreferences: withDevToolsPreference({
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
      // Start in RAM-saving mode; renderer disables throttling while bot automation is active.
      backgroundThrottling: true,
      // Disable the in-memory spellcheck dictionary (saves ~20-40MB).
      spellcheck: false
    }, devToolsEnabled)
  });
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (params.partition !== 'persist:pancake') {
      event.preventDefault();
      return;
    }
    if (params.src && !isAllowedGuestNavigation(params.src)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    Object.assign(webPreferences, withDevToolsPreference({
      ...webPreferences,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }, devToolsEnabled));
  });
  automationActivity = createAutomationActivity(mainWindow.webContents.id);
  mainWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) resetAutomationActivity();
  });
  mainWindow.webContents.on('render-process-gone', resetAutomationActivity);
  mainWindow.webContents.on('destroyed', resetAutomationActivity);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  controlPlaneInitialization = controlPlaneClient.initialize().then(() => {
    controlPlaneClient.startHeartbeat(60000, publishControlPlaneStatus);
    publishControlPlaneStatus();
  });

  updater = createElectronUpdaterBridge({
    getWindow: () => mainWindow,
    controlPlaneClient
  });
  if (app.isPackaged || process.env.CHECK_UPDATE_ON_START === 'true') {
    updater.checkForUpdates().catch((err) => {
      console.error('[updater] startup check failed:', err.message);
    });
  }
  periodicUpdateTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || hasActiveAutomation()) return;
    updater.checkForUpdates().catch((err) => {
      console.error('[updater] periodic check failed:', err.message);
    });
  }, 4 * 60 * 60 * 1000);
  periodicUpdateTimer.unref?.();

  // When the window is minimized, hint the renderer to release memory.
  mainWindow.on('minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:visibility', 'hidden');
      if (hasActiveAutomation()) return;
      // Level 2: ask Chromium to free as much memory as possible for all
      // frames (including the Pancake <webview>) while the app is hidden.
      try {
        mainWindow.webContents.forEachFrame((frame) => {
          frame.executeJavaScript('window.gc && window.gc();').catch(() => {});
        });
      } catch (_) {}
      // Drop image/scripts caches held by Chromium for this session.
      try { mainWindow.webContents.session.clearCache(); } catch (_) {}
    }
  });
  mainWindow.on('restore', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:visibility', 'visible');
    }
  });

  mainWindow.on('closed', () => {
    if (visibleGcTimer) { clearInterval(visibleGcTimer); visibleGcTimer = null; }
    if (periodicUpdateTimer) { clearInterval(periodicUpdateTimer); periodicUpdateTimer = null; }
    resetAutomationActivity();
    automationActivity = null;
    mainWindow = null;
  });

  visibleGcTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || hasActiveAutomation()) return;
    try {
      mainWindow.webContents.forEachFrame((frame) => {
        frame.executeJavaScript('window.gc && window.gc();').catch(() => {});
      });
    } catch (_) {}
  }, 10 * 60 * 1000);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    const policy = resolveGuestNavigation(url);
    if (policy.action === 'same-webview') {
      Promise.resolve(contents.loadURL(url)).catch((error) => {
        console.error(`[guest-auth] same-webview navigation failed: ${error.message}`);
      });
    }
    return { action: policy.action === 'deny' || policy.action === 'same-webview' ? 'deny' : 'allow' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!isAllowedGuestNavigation(url)) event.preventDefault();
  });
  contents.on('did-create-window', (window) => {
    if (!window?.webContents) return;
    window.webContents.setWindowOpenHandler(({ url }) => ({
      action: resolveGuestNavigation(url).action === 'deny' ? 'deny' : 'allow'
    }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedGuestNavigation(url)) event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    if (!window.isDestroyed()) window.show();
  });
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
});

app.whenReady().then(createWindow);

app.on('before-quit', () => {
  controlPlaneClient?.dispose();
  if (updater?.installOnQuit) { updater.installOnQuit(); }
});

app.on('window-all-closed', () => {
  telegram.notifyServerDown().catch(() => {});
  if (server) server.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
