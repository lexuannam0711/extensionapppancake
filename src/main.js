require('dotenv').config();
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { startServer } = require('./server/index');
const telegram = require('./server/telegram');
const extManager = require('./extensionManager');

// Silence the dev-only "allowpopups" security warning (webview needs popups
// for Pancake/Facebook OAuth flows). This warning never shows once packaged.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

let mainWindow;
let server;
let activePort = Number(process.env.PORT || 8787);
let visibleGcTimer = null;

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
  ipcMain.removeHandler('ext:list');
  ipcMain.removeHandler('ext:reload');
  ipcMain.removeHandler('ext:open-folder');

  ipcMain.handle('app:get-env', () => ({
    serverUrl: `http://localhost:${activePort}`,
    pancakeUrl: process.env.PREFERRED_PANCAKE_URL || 'https://pages.fm/'
  }));

  ipcMain.handle('app:open-external', async (_evt, url) => {
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('app:show-message', async (_evt, options) => dialog.showMessageBox(mainWindow, options));

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
  activePort = Number(process.env.PORT || 8787);
  registerIpcHandlers();
  server = await startServer(activePort);

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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true,
      // Allow the renderer to be throttled/frozen when the window is hidden.
      backgroundThrottling: true,
      // Disable the in-memory spellcheck dictionary (saves ~20-40MB).
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  await mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // When the window is minimized, hint the renderer to release memory.
  mainWindow.on('minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:visibility', 'hidden');
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
    mainWindow = null;
  });

  visibleGcTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  telegram.notifyServerDown().catch(() => {});
  if (server) server.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
