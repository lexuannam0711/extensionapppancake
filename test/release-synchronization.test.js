const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const modernPackage = require('../package.json');
const win7Package = require('../package.win7.json');
const releaseWorkflow = require('node:fs').readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
const { createControlPlaneApp, createInMemoryRepository, createReleaseProvider } = require('../src/control-plane/server');
const { canonicalManifestPayload } = require('../src/update/manifest');
const { sha256Buffer, signEd25519 } = require('../src/update/integrity');
const { assertSafeArchiveEntry } = require('../src/update/pathSafety');
const { downloadAndApplyWin7Update } = require('../src/update/win7-updater');
const { isBlockedPath } = require('../scripts/audit-artifact');
const { launchAppAndWait } = require('../scripts/win7-updater');
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

test('modern and Win7 package versions stay identical and plain semver', () => {
  assert.equal(modernPackage.version, win7Package.version);
  assert.match(modernPackage.version, /^\d+\.\d+\.\d+$/);
  assert.match(win7Package.version, /^\d+\.\d+\.\d+$/);
});

test('release workflow rejects non-semver tags and does not add a Win7 version suffix', () => {
  assert.equal(normalizeTag('v3.1.0'), '3.1.0');
  assert.throws(() => normalizeTag('v3.1.0-win7'), /Release tag/);
  assert.equal(validateReleaseVersion().packageVersion, modernPackage.version);
  assert.doesNotMatch(releaseWorkflow, /GITHUB_REF_NAME\.Substring\(1\) \+ '-win7'/);
  assert.match(releaseWorkflow, /manifest-modern\.json/);
  assert.match(releaseWorkflow, /manifest-win7\.json/);
  assert.match(releaseWorkflow, /\*-Win7-x64\.zip/);
});

test('release provider keeps one version while selecting channel artifact', () => {
  const modern = makeManifest('modern');
  const win7 = makeManifest('win7', '3.1.0', 'https://updates.example.test/PancakeDesktopAIShortcutBot-3.1.0-Win7-x64.zip');
  const provider = createReleaseProvider({ modern, win7 });
  assert.equal(provider.getManifest('modern').version, provider.getManifest('win7').version);
  assert.equal(provider.getManifest('modern').channel, 'modern');
  assert.equal(provider.getManifest('win7').channel, 'win7');
  assert.notEqual(provider.getManifest('modern').artifactUrl, provider.getManifest('win7').artifactUrl);
  assert.throws(() => createReleaseProvider({ modern, win7: makeManifest('win7', '3.2.0') }), /versions must match/);
});

test('control plane returns 204 for current version and channel-specific artifact for older clients', async () => {
  const modern = makeManifest('modern');
  const win7 = makeManifest('win7', '3.1.0', 'https://updates.example.test/PancakeDesktopAIShortcutBot-3.1.0-Win7-x64.zip');
  const app = createControlPlaneApp({
    repository: createInMemoryRepository(),
    releaseProvider: createReleaseProvider({ modern, win7 }),
    jwtSecret: 'test-secret'
  });
  const { server, url } = await listen(app);
  try {
    const current = await fetch(`${url}/v1/update-manifest?channel=modern&version=3.1.0`);
    assert.equal(current.status, 204);
    const update = await fetch(`${url}/v1/update-manifest?channel=win7&version=3.0.0`);
    assert.equal(update.status, 200);
    const payload = await update.json();
    assert.equal(payload.version, '3.1.0');
    assert.equal(payload.channel, 'win7');
    assert.match(payload.artifactUrl, /-Win7-x64\.zip$/);
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

test('Win7 update verifies signature and hash while preserving local files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdb-release-sync-'));
  const installDir = path.join(root, 'app');
  const tempRoot = path.join(root, 'tmp');
  await fs.mkdir(path.join(installDir, 'uploads'), { recursive: true });
  await fs.mkdir(path.join(installDir, 'server', 'data'), { recursive: true });
  await fs.writeFile(path.join(installDir, '.env'), 'LOCAL=1');
  await fs.writeFile(path.join(installDir, 'uploads', 'keep.txt'), 'keep');
  await fs.writeFile(path.join(installDir, 'server', 'data', 'shortcuts.json'), '{items:[]}');

  const artifact = Buffer.from('win7-release-3.1.0');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = makeManifest('win7', '3.1.0', 'https://updates.example.test/PancakeDesktopAIShortcutBot-3.1.0-Win7-x64.zip');
  const signedManifest = {
    ...manifest,
    sha256: sha256Buffer(artifact)
  };
  signedManifest.signature = signEd25519(canonicalManifestPayload(signedManifest), privateKey);

  try {
    const result = await downloadAndApplyWin7Update({
      manifest: signedManifest,
      installDir,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
      allowedHosts: ['updates.example.test'],
      tempRoot,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        url: signedManifest.artifactUrl,
        headers: { get: () => String(artifact.length) },
        arrayBuffer: async () => artifact
      }),
      extractArchive: async (_archivePath, destination) => {
        await fs.writeFile(path.join(destination, 'version.txt'), '3.1.0');
      }
    });
    assert.equal(result.manifest.version, '3.1.0');
    assert.equal(await fs.readFile(path.join(installDir, 'version.txt'), 'utf8'), '3.1.0');
    assert.equal(await fs.readFile(path.join(installDir, '.env'), 'utf8'), 'LOCAL=1');
    assert.equal(await fs.readFile(path.join(installDir, 'uploads', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(await fs.readFile(path.join(installDir, 'server', 'data', 'shortcuts.json'), 'utf8'), '{items:[]}');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('archive traversal and trusted public key audit paths are rejected or allowed correctly', () => {
  assert.throws(() => assertSafeArchiveEntry('/tmp/install', '../escape'), /Unsafe archive entry|outside/);
  assert.equal(isBlockedPath('app.asar/src/update/trusted-public-key.pem'), false);
  assert.equal(isBlockedPath('app.asar/src/update/release-signing-private-key.pem'), true);
});

test('Win7 updater rejects replayed versions and startup failures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdb-release-replay-'));
  const installDir = path.join(root, 'app');
  const artifact = Buffer.from('release');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const unsigned = { ...makeManifest('win7', '3.1.0'), sha256: sha256Buffer(artifact) };
  const manifest = { ...unsigned, signature: signEd25519(canonicalManifestPayload(unsigned), privateKey) };
  const options = {
    manifest,
    installDir,
    currentVersion: '3.1.0',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    allowedHosts: ['updates.example.test'],
    fetchImpl: async () => ({ ok: true, status: 200, url: manifest.artifactUrl, headers: { get: () => String(artifact.length) }, arrayBuffer: async () => artifact }),
    extractArchive: async () => {}
  };
  try {
    await assert.rejects(() => downloadAndApplyWin7Update(options), /not newer/);
    const child = new EventEmitter();
    const startup = launchAppAndWait('electron.exe', installDir, {
      waitMs: 50,
      spawnImpl: (_file, _args, spawnOptions) => {
        assert.equal(spawnOptions.env.ELECTRON_RUN_AS_NODE, undefined);
        setImmediate(() => child.emit('exit', 1));
        return child;
      }
    });
    await assert.rejects(startup, /exited during startup/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
