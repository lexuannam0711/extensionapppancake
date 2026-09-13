const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { dialog, app } = require('electron');
const { parseManifest, canonicalManifestPayload, isUpdateAvailable, requiresMinimumVersion } = require('./manifest');
const { sha256Buffer, verifyEd25519 } = require('./integrity');

function withChannel(url, channel, version = '') {
  const parsed = new URL(url);
  parsed.searchParams.set('channel', channel);
  if (version) parsed.searchParams.set('version', String(version).replace(/^v/, ''));
  return parsed.toString();
}
function normalizeHosts(value) {
  return [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

function requireTrustConfig({ manifestUrl, publicKey, allowedHosts }) {
  if (!manifestUrl || !publicKey) throw new Error('Updater trust configuration is missing');
  const url = new URL(manifestUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Updater manifest URL must use HTTPS without credentials or custom port');
  const hosts = normalizeHosts(allowedHosts);
  if (!hosts.length) hosts.push(url.hostname.toLowerCase());
  if (!hosts.includes(url.hostname.toLowerCase())) throw new Error('Updater manifest host is not allowed');
  return { manifestUrl: url.toString(), publicKey: String(publicKey), allowedHosts: hosts };
}

async function fetchJson(url, fetchImpl, allowedHosts) {
  const response = await fetchWithAllowedRedirects(url, fetchImpl, allowedHosts);
  if (!response.ok) throw new Error(`Update manifest request failed: ${response.status}`);
  if (response.status === 204) return null;
  if (response.url && !allowedHosts.includes(new URL(response.url).hostname.toLowerCase())) throw new Error('Update manifest redirect host is not allowed');
  return response.json();
}

async function fetchWithAllowedRedirects(url, fetchImpl, allowedHosts) {
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'https:' || !allowedHosts.includes(parsed.hostname.toLowerCase())) throw new Error('Update URL host is not allowed');
    const response = await fetchImpl(current, { redirect: 'manual' });
    const location = response.headers?.get?.('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, parsed).toString();
      continue;
    }
    if (response.url && !allowedHosts.includes(new URL(response.url).hostname.toLowerCase())) throw new Error('Update redirect host is not allowed');
    return response;
  }
  throw new Error('Too many update redirects');
}

async function downloadVerifiedArtifact(manifest, { fetchImpl, allowedHosts, maxBytes = 1024 * 1024 * 1024 }) {
  const artifactUrl = new URL(manifest.artifactUrl);
  if (!allowedHosts.includes(artifactUrl.hostname.toLowerCase())) throw new Error('Update artifact host is not allowed');
  const response = await fetchWithAllowedRedirects(manifest.artifactUrl, fetchImpl, allowedHosts);
  if (!response.ok) throw new Error(`Update artifact request failed: ${response.status}`);
  if (response.url && !allowedHosts.includes(new URL(response.url).hostname.toLowerCase())) throw new Error('Update artifact redirect host is not allowed');
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > maxBytes) throw new Error('Update artifact is too large');
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) throw new Error('Update artifact is too large');
  if (sha256Buffer(data) !== manifest.sha256) throw new Error('Update artifact hash is invalid');
  return data;
}

function createModernUpdater({
  getWindow,
  manifestUrl = process.env.UPDATE_MANIFEST_URL,
  publicKey = process.env.UPDATE_PUBLIC_KEY,
  allowedHosts = process.env.UPDATE_ALLOWED_HOSTS,
  fetchImpl = global.fetch,
  tempRoot = os.tmpdir(),
  spawnImpl = spawn,
  dialogImpl = dialog,
  appImpl = app
} = {}) {
  let disposed = false;
  let pendingInstall = false;
  let downloadedInstaller = null;
  let trustedConfig = null;

  function getTrustConfig() {
    if (!trustedConfig) trustedConfig = requireTrustConfig({ manifestUrl, publicKey, allowedHosts });
    return trustedConfig;
  }

  async function fetchManifest(currentVersion = appImpl.getVersion()) {
    const config = getTrustConfig();
    const raw = await fetchJson(withChannel(config.manifestUrl, 'modern', currentVersion), fetchImpl, config.allowedHosts);
    if (raw === null) return null;
    const manifest = parseManifest(raw, { allowedHosts: config.allowedHosts });
    if (manifest.channel !== 'modern') throw new Error('Modern updater requires modern channel');
    if (!verifyEd25519(canonicalManifestPayload(manifest), manifest.signature, config.publicKey)) throw new Error('Update manifest signature is invalid');
    return manifest;
  }

  async function startDownload(manifest) {
    const artifact = await downloadVerifiedArtifact(manifest, { fetchImpl, allowedHosts: getTrustConfig().allowedHosts });
    const directory = await fs.mkdtemp(path.join(path.resolve(tempRoot), 'pdb-modern-update-'));
    const installer = path.join(directory, `PancakeDesktopAIShortcutBot-${manifest.version}.exe`);
    await fs.writeFile(installer, artifact, { flag: 'wx', mode: 0o700 });
    downloadedInstaller = { directory, installer };
    pendingInstall = true;
    return { status: 'downloaded', manifest };
  }

  async function checkAtStartup() {
    if (disposed || process.platform !== 'win32') return { status: 'unsupported' };
    if (pendingInstall) return { status: 'pending' };
    const currentVersion = appImpl.getVersion();
    let manifest;
    try { manifest = await fetchManifest(currentVersion); } catch (error) {
      if (/trust configuration is missing/.test(error.message)) return { status: 'not-configured' };
      throw error;
    }
    if (!manifest) return { status: 'current' };
    const available = isUpdateAvailable(currentVersion, manifest);
    const required = requiresMinimumVersion(currentVersion, manifest);
    if (!available) return { status: 'current', manifest };
    const window = getWindow?.();
    if (!window || window.isDestroyed?.()) return { status: 'available', manifest, required };
    const result = await dialogImpl.showMessageBox(window, {
      type: 'info',
      title: 'Có bản cập nhật',
      message: `Có bản ${manifest.version} cho kênh ${manifest.channel}.`,
      detail: manifest.releaseNotes || 'Cập nhật bảo mật và sửa lỗi.',
      buttons: required ? ['Cập nhật ngay'] : ['Cập nhật ngay', 'Để sau'],
      defaultId: 0,
      cancelId: required ? 0 : 1,
      noLink: true
    });
    if (result.response !== 0 && !required) return { status: 'declined', manifest };
    return startDownload(manifest);
  }

  function installOnQuit() {
    if (!pendingInstall || !downloadedInstaller || disposed) return false;
    pendingInstall = false;
    const { installer } = downloadedInstaller;
    const child = spawnImpl(installer, [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
    downloadedInstaller = null;
    appImpl.quit();
    return true;
  }

  function dispose() { disposed = true; }

  return Object.freeze({ checkAtStartup, fetchManifest, installOnQuit, dispose });
}

module.exports = { createModernUpdater, downloadVerifiedArtifact, requireTrustConfig };
