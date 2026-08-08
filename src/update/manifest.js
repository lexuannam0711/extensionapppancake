const CHANNELS = new Set(['modern', 'win7']);
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const MANIFEST_FIELDS = ['version', 'channel', 'minSupportedVersion', 'artifactUrl', 'sha256', 'releaseNotes'];

function parseVersion(value) {
  const match = String(value || '').trim().match(VERSION_PATTERN);
  if (!match) throw new Error(`Invalid version: ${value}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ? match[4].split('.') : [] };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== null) return -1;
    if (rightNumber !== null) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function assertHttpsUrl(value, fieldName, allowedHosts = []) {
  let url;
  try { url = new URL(value); } catch (_) { throw new Error(`${fieldName} must be a valid URL`); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') throw new Error(`${fieldName} must use HTTPS`);
  if (url.username || url.password || url.port) throw new Error(`${fieldName} must not include credentials or a custom port`);
  if (allowedHosts.length && !allowedHosts.includes(hostname)) throw new Error(`${fieldName} host is not allowed`);
  if (/^(127\.|10\.|192\.168\.|169\.254\.|localhost$|::1$)/i.test(hostname)) throw new Error(`${fieldName} host is not public`);
  return url.toString();
}

function parseManifest(raw, { allowedHosts = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Manifest must be an object');
  const version = String(raw.version || '').trim().replace(/^v/, '');
  const minSupportedVersion = String(raw.minSupportedVersion || '').trim().replace(/^v/, '');
  parseVersion(version);
  parseVersion(minSupportedVersion);
  const channel = String(raw.channel || '').trim();
  if (!CHANNELS.has(channel)) throw new Error('Manifest channel is invalid');
  const sha256 = String(raw.sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Manifest sha256 is invalid');
  const signature = String(raw.signature || '').trim();
  let decodedSignature;
  try { decodedSignature = Buffer.from(signature, 'base64'); } catch (_) { throw new Error('Manifest signature is invalid'); }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || decodedSignature.length !== 64) throw new Error('Manifest signature is invalid');
  return Object.freeze({
    version,
    channel,
    minSupportedVersion,
    artifactUrl: assertHttpsUrl(String(raw.artifactUrl || '').trim(), 'Manifest artifactUrl', allowedHosts),
    sha256,
    signature,
    releaseNotes: String(raw.releaseNotes || '').slice(0, 20000)
  });
}

function canonicalManifestPayload(manifest) {
  return JSON.stringify(Object.fromEntries(MANIFEST_FIELDS.map((field) => [field, manifest[field]])));
}

function isUpdateAvailable(currentVersion, manifest) {
  return compareVersions(manifest.version, currentVersion) > 0;
}

function requiresMinimumVersion(currentVersion, manifest) {
  return compareVersions(currentVersion, manifest.minSupportedVersion) < 0;
}

module.exports = { CHANNELS, MANIFEST_FIELDS, parseVersion, compareVersions, parseManifest, canonicalManifestPayload, isUpdateAvailable, requiresMinimumVersion };