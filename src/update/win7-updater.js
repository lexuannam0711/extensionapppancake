const fs = require('fs/promises');
const https = require('https');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { dialog, app } = require('electron');
const { parseManifest, canonicalManifestPayload, compareVersions } = require('./manifest');
const { sha256Buffer, verifyEd25519 } = require('./integrity');
const { assertSafeArchiveEntry } = require('./pathSafety');
const { applyDirectoryUpdate } = require('./rollback');

const PRESERVED_INSTALL_PATHS = Object.freeze(['.env', 'server/data', 'uploads', 'logs', 'shortcuts', 'runtime-data']);

function assertAllowedUrl(value, allowedHosts) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error('Update URL must use HTTPS');
  const hosts = allowedHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean);
  if (hosts.length && !hosts.includes(parsed.hostname.toLowerCase())) throw new Error('Update URL host is not allowed');
  return parsed;
}

function createNodeFetch({ allowedHosts = [] } = {}) {
  function request(url, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (redirects > 5) return reject(new Error('Too many update redirects'));
      let parsed;
      try { parsed = assertAllowedUrl(url, allowedHosts); } catch (error) { return reject(error); }
      const clientRequest = https.get(parsed, (response) => {
        const location = response.headers.location;
        if (response.statusCode >= 300 && response.statusCode < 400 && location) {
          response.resume();
          try { assertAllowedUrl(new URL(location, parsed).toString(), allowedHosts); } catch (error) { return reject(error); }
          return request(new URL(location, parsed).toString(), redirects + 1).then(resolve, reject);
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode || 0,
            url: parsed.toString(),
            headers: { get: (name) => response.headers[String(name).toLowerCase()] || null },
            arrayBuffer: async () => body,
            json: async () => JSON.parse(body.toString('utf8'))
          });
        });
      });
      clientRequest.on('error', reject);
    });
  }
  return request;
}

function getDefaultFetch(fetchImpl = global.fetch, options = {}) {
  return typeof fetchImpl === 'function' ? fetchImpl : createNodeFetch(options);
}
async function assertExtractedTree(root, current = root, limits = { files: 0, bytes: 0, maxFiles: 10000, maxBytes: 2 * 1024 * 1024 * 1024 }) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(current, entry.name);
    const relative = path.relative(root, entryPath);
    assertSafeArchiveEntry(root, relative);
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) throw new Error(`Extracted archive contains a link: ${relative}`);
    if (stats.isDirectory()) await assertExtractedTree(root, entryPath, limits);
    else if (stats.isFile()) {
      limits.files += 1;
      limits.bytes += stats.size;
      if (limits.files > limits.maxFiles) throw new Error('Update archive contains too many files');
      if (limits.bytes > limits.maxBytes) throw new Error('Update archive expands beyond size limit');
    } else throw new Error(`Unsupported extracted entry: ${relative}`);
  }
  return { files: limits.files, bytes: limits.bytes };
}

async function downloadArtifact(url, fetchImpl, { allowedHosts = [], maxBytes = 1024 * 1024 * 1024 } = {}) {
  const artifactUrl = new URL(url);
  const hosts = allowedHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean);
  if (hosts.length && !hosts.includes(artifactUrl.hostname.toLowerCase())) throw new Error('Update artifact host is not allowed');
  const response = await getDefaultFetch(fetchImpl, { allowedHosts })(url);
  if (!response.ok) throw new Error(`Update artifact request failed: ${response.status}`);
  if (response.url && hosts.length && !hosts.includes(new URL(response.url).hostname.toLowerCase())) throw new Error('Update artifact redirect host is not allowed');
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > maxBytes) throw new Error('Update artifact is too large');
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) throw new Error('Update artifact is too large');
  return data;
}

async function downloadAndApplyWin7Update({
  manifest: rawManifest,
  installDir,
  publicKey,
  allowedHosts = [],
  fetchImpl = global.fetch,
  extractArchive,
  tempRoot = os.tmpdir(),
  currentVersion = '',
  preservePaths = PRESERVED_INSTALL_PATHS
}) {
  if (typeof extractArchive !== 'function') throw new Error('Archive extractor is required');
  const manifest = parseManifest(rawManifest, { allowedHosts });
  if (manifest.channel !== 'win7') throw new Error('Win7 updater requires win7 channel');
  if (currentVersion && compareVersions(manifest.version, currentVersion) <= 0) throw new Error('Update version is not newer than installed version');
  if (!verifyEd25519(canonicalManifestPayload(manifest), manifest.signature, publicKey)) throw new Error('Update manifest signature is invalid');
  const parent = path.dirname(path.resolve(installDir));
  const stageDir = path.join(parent, `${path.basename(installDir)}.update-stage`);
  const backupDir = path.join(parent, `${path.basename(installDir)}.update-backup`);
  await fs.mkdir(path.resolve(tempRoot), { recursive: true });
  const workDir = await fs.mkdtemp(path.join(path.resolve(tempRoot), 'pdb-win7-update-'));
  const archivePath = path.join(workDir, 'update.zip');
  try {
    const archive = await downloadArtifact(manifest.artifactUrl, fetchImpl, { allowedHosts });
    if (sha256Buffer(archive) !== manifest.sha256) throw new Error('Update artifact hash is invalid');
    await fs.rm(stageDir, { recursive: true, force: true });
    await fs.mkdir(stageDir, { recursive: true });
    await fs.writeFile(archivePath, archive);
    await extractArchive(archivePath, stageDir);
    await assertExtractedTree(stageDir);
    return { manifest, ...(await applyDirectoryUpdate({ currentDir: path.resolve(installDir), stagingDir: stageDir, backupDir, preservePaths })) };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

function withChannel(url, channel, version = '') {
  const parsed = new URL(url);
  parsed.searchParams.set('channel', channel);
  if (version) parsed.searchParams.set('version', String(version).replace(/^v/, ''));
  return parsed.toString();
}
function normalizeHosts(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

function createWin7Updater({
  getWindow,
  manifestUrl = process.env.UPDATE_MANIFEST_URL,
  publicKey = process.env.UPDATE_PUBLIC_KEY,
  allowedHosts = process.env.UPDATE_ALLOWED_HOSTS,
  fetchImpl = global.fetch,
  spawnImpl = spawn,
  appImpl = app,
  dialogImpl = dialog
} = {}) {
  let disposed = false;
  let pendingInstall = null;

  function trustConfig() {
    if (!manifestUrl || !publicKey) throw new Error('Updater trust configuration is missing');
    const url = new URL(manifestUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Updater manifest URL must use HTTPS without credentials or custom port');
    const hosts = normalizeHosts(allowedHosts);
    if (!hosts.length) hosts.push(url.hostname.toLowerCase());
    if (!hosts.includes(url.hostname.toLowerCase())) throw new Error('Updater manifest host is not allowed');
    return { url: url.toString(), publicKey: String(publicKey), hosts };
  }

  async function fetchManifest(currentVersion = appImpl.getVersion()) {
    const config = trustConfig();
    const response = await getDefaultFetch(fetchImpl, { allowedHosts: config.hosts })(withChannel(config.url, 'win7', currentVersion));
    if (!response.ok) throw new Error(`Update manifest request failed: ${response.status}`);
    if (response.status === 204) return null;
    if (response.url && !config.hosts.includes(new URL(response.url).hostname.toLowerCase())) throw new Error('Update manifest redirect host is not allowed');
    const manifest = parseManifest(await response.json(), { allowedHosts: config.hosts });
    if (manifest.channel !== 'win7') throw new Error('Win7 updater requires win7 channel');
    if (!verifyEd25519(canonicalManifestPayload(manifest), manifest.signature, config.publicKey)) throw new Error('Update manifest signature is invalid');
    return manifest;
  }

  async function checkAtStartup() {
    if (disposed || process.platform !== 'win32') return { status: 'unsupported' };
    const currentVersion = appImpl.getVersion();
    let manifest;
    try { manifest = await fetchManifest(currentVersion); } catch (error) {
      if (/trust configuration is missing/.test(error.message)) return { status: 'not-configured' };
      throw error;
    }
    if (!manifest) return { status: 'current' };
    const required = compareVersions(currentVersion, manifest.minSupportedVersion) < 0;
    if (compareVersions(manifest.version, currentVersion) <= 0) return { status: 'current', manifest, required };
    const window = getWindow?.();
    if (!window || window.isDestroyed?.()) return { status: 'available', manifest, required };
    const result = await dialogImpl.showMessageBox(window, {
      type: 'info',
      title: 'Có bản cập nhật',
      message: `Có bản ${manifest.version} cho kênh win7.`,
      detail: manifest.releaseNotes || 'Cập nhật bảo mật và sửa lỗi.',
      buttons: required ? ['Cập nhật ngay'] : ['Cập nhật ngay', 'Để sau'],
      defaultId: 0,
      cancelId: required ? 0 : 1,
      noLink: true
    });
    if (result.response !== 0 && !required) return { status: 'declined', manifest };
    const config = trustConfig();
    const keyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdb-win7-key-'));
    const publicKeyPath = path.join(keyDir, 'update-public-key.pem');
    await fs.writeFile(publicKeyPath, config.publicKey, { mode: 0o600 });
    pendingInstall = { manifest, config, publicKeyPath, currentVersion, appPath: path.resolve(appImpl.getAppPath()) };
    return { status: 'ready', manifest };
  }

  function installOnQuit() {
    if (!pendingInstall || disposed) return false;
    const appRoot = pendingInstall.appPath;
    const helper = path.join(appRoot, 'scripts', 'win7-updater.js');
    const child = spawnImpl(process.execPath, [helper, '--manifest-url', pendingInstall.config.url, '--install-dir', appRoot, '--public-key', pendingInstall.publicKeyPath, '--current-version', pendingInstall.currentVersion, '--app-exe', process.execPath, '--app-path', appRoot], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', UPDATE_ALLOWED_HOSTS: pendingInstall.config.hosts.join(',') }
    });
    child.unref?.();
    pendingInstall = null;
    appImpl.quit();
    return true;
  }

  function dispose() { disposed = true; pendingInstall = null; }

  return Object.freeze({ checkAtStartup, fetchManifest, installOnQuit, dispose });
}

module.exports = { downloadArtifact, downloadAndApplyWin7Update, assertExtractedTree, createWin7Updater, getDefaultFetch, withChannel, PRESERVED_INSTALL_PATHS };
