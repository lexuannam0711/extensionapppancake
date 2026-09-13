const fs = require('fs');
const path = require('path');
const { session } = require('electron');

// Root folder that acts like Chrome's extension store: each sub-folder is one
// unpacked extension (must contain manifest.json).
const EXT_ROOT = path.resolve(__dirname, '..', 'extensions');
// All webviews share one persistent inbox/session.
const PARTITION = 'persist:pancake';

// In-memory status table, keyed by folder name.
const statuses = new Map();

function ensureRoot() {
  try { fs.mkdirSync(EXT_ROOT, { recursive: true }); } catch (_) {}
}

function readManifest(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function listExtensionDirs() {
  ensureRoot();
  try {
    return fs.readdirSync(EXT_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => fs.existsSync(path.join(EXT_ROOT, name, 'manifest.json')));
  } catch (_) {
    return [];
  }
}

async function loadOne(folderName) {
  const dir = path.join(EXT_ROOT, folderName);
  const manifest = readManifest(dir);
  const base = {
    folder: folderName,
    path: dir,
    name: folderName,
    version: '',
    manifestVersion: null,
    loaded: false,
    error: null
  };
  if (!manifest) {
    const status = { ...base, error: 'Không đọc được manifest.json' };
    statuses.set(folderName, status);
    return status;
  }
  base.name = manifest.short_name || (typeof manifest.name === 'string' && !manifest.name.startsWith('__MSG') ? manifest.name : folderName);
  base.version = manifest.version || '';
  base.manifestVersion = manifest.manifest_version || null;

  try {
    const ses = session.fromPartition(PARTITION);
    const loaded = await ses.loadExtension(dir, { allowFileAccess: true });
    const status = {
      ...base,
      name: loaded.name || base.name,
      version: loaded.version || base.version,
      id: loaded.id,
      loaded: true,
      error: null
    };
    statuses.set(folderName, status);
    console.log('[ext] Loaded:', status.name, status.version, `(mv${status.manifestVersion})`);
    return status;
  } catch (error) {
    const status = { ...base, error: error.message || String(error) };
    statuses.set(folderName, status);
    console.error('[ext] Failed to load', folderName, ':', status.error);
    return status;
  }
}

// Load every extension folder found under extensions/. Best-effort.
async function loadAll() {
  ensureRoot();
  const dirs = listExtensionDirs();
  const results = [];
  for (const folder of dirs) {
    results.push(await loadOne(folder));
  }
  return results;
}

// Unload (best-effort) then reload a single extension by folder name.
async function reloadOne(folderName) {
  try {
    const ses = session.fromPartition(PARTITION);
    const existing = statuses.get(folderName);
    if (existing && existing.id && typeof ses.removeExtension === 'function') {
      try { ses.removeExtension(existing.id); } catch (_) {}
    }
  } catch (_) {}
  return loadOne(folderName);
}

function getStatuses() {
  // Re-sync the list with folders on disk (so newly added folders appear).
  for (const folder of listExtensionDirs()) {
    if (!statuses.has(folder)) {
      const manifest = readManifest(path.join(EXT_ROOT, folder));
      statuses.set(folder, {
        folder,
        path: path.join(EXT_ROOT, folder),
        name: (manifest && manifest.short_name) || folder,
        version: (manifest && manifest.version) || '',
        manifestVersion: (manifest && manifest.manifest_version) || null,
        loaded: false,
        error: 'Chưa load (bấm Reload hoặc khởi động lại app)'
      });
    }
  }
  return Array.from(statuses.values());
}

module.exports = {
  EXT_ROOT,
  PARTITION,
  loadAll,
  loadOne,
  reloadOne,
  getStatuses,
  listExtensionDirs
};
