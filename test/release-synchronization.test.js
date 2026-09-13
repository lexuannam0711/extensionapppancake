const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const modernPackage = require('../package.json');
const releaseWorkflow = require('node:fs').readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
const { createControlPlaneApp, createInMemoryRepository, createReleaseProvider } = require('../src/control-plane/server');
const { assertSafeArchiveEntry } = require('../src/update/pathSafety');
const { isBlockedPath } = require('../scripts/audit-artifact');
const { normalizeTag, validateReleaseVersion } = require('../scripts/validate-release-version');

function makeManifest(channel, version = '3.1.0', artifactUrl = `https://updates.example.test/PancakeDesktopAIShortcutBot-${version}-${channel}.artifact`) {
  return {
    version,
    channel,
    minSupportedVersion: '3.0.0',
    artifactUrl,
    sha256: 'a'.repeat(64),
    signature: Buffer.alloc(64, 7).toString('base64'),
    releaseNotes: 'Release'
  };
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('modern package version is plain semver', () => {
  assert.match(modernPackage.version, /^\d+\.\d+\.\d+$/);
});

test('release workflow rejects non-semver tags', () => {
  assert.equal(normalizeTag('v3.1.0'), '3.1.0');
  assert.throws(() => normalizeTag('v3.1.0-legacy'), /Release tag/);
  assert.equal(validateReleaseVersion().packageVersion, modernPackage.version);
  assert.match(releaseWorkflow, /manifest-modern\.json/);
});

test('release provider serves the modern artifact', () => {
  const modern = makeManifest('modern');
  const provider = createReleaseProvider({ modern });
  assert.equal(provider.getManifest('modern').channel, 'modern');
  assert.equal(provider.getManifest('modern').version, '3.1.0');
});

test('control plane returns 204 for current version and modern artifact for older clients', async () => {
  const modern = makeManifest('modern');
  const app = createControlPlaneApp({
    repository: createInMemoryRepository(),
    releaseProvider: createReleaseProvider({ modern }),
    jwtSecret: 'test-secret'
  });
  const { server, url } = await listen(app);
  try {
    const current = await fetch(`${url}/v1/update-manifest?channel=modern&version=3.1.0`);
    assert.equal(current.status, 204);
    const update = await fetch(`${url}/v1/update-manifest?channel=modern&version=3.0.0`);
    assert.equal(update.status, 200);
    const payload = await update.json();
    assert.equal(payload.version, '3.1.0');
    assert.equal(payload.channel, 'modern');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('control plane blocks release before serving manifest', async () => {
  const repository = createInMemoryRepository();
  await repository.blockRelease('3.1.0', 'bad build');
  const app = createControlPlaneApp({
    repository,
    releaseProvider: createReleaseProvider({ modern: makeManifest('modern') }),
    jwtSecret: 'test-secret'
  });
  const { server, url } = await listen(app);
  try {
    const response = await fetch(`${url}/v1/update-manifest?channel=modern`);
    assert.equal(response.status, 410);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('archive traversal and trusted public key audit paths are rejected or allowed correctly', () => {
  assert.throws(() => assertSafeArchiveEntry('/tmp/install', '../escape'), /Unsafe archive entry|outside/);
  assert.equal(isBlockedPath('app.asar/src/update/trusted-public-key.pem'), false);
  assert.equal(isBlockedPath('app.asar/src/update/release-signing-private-key.pem'), true);
});
