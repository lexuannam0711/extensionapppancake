const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  parseManifest,
  compareVersions,
  isUpdateAvailable,
  canonicalManifestPayload
} = require('../src/update/manifest');
const { sha256File, verifyEd25519, signEd25519, sha256Buffer } = require('../src/update/integrity');
const { safeJoin, assertSafePath } = require('../src/update/pathSafety');
const { applyDirectoryUpdate } = require('../src/update/rollback');
const { createModernUpdater } = require('../src/update/modern-updater');
const { createEncryptedTokenStore } = require('../src/auth/tokenStore');
const { auditArtifact } = require('../scripts/audit-artifact');
const { migrateData, DATA_SCHEMA_VERSION } = require('../src/server/dataMigration');
const {
  createControlPlaneApp,
  createInMemoryRepository,
  createHs256Token,
  normalizeHeartbeatInput,
  sanitizeMetadata
} = require('../src/control-plane/server');
const { createControlPlaneClient } = require('../src/control-plane/client');

function validManifest(overrides = {}) {
  return {
    version: '3.1.0',
    channel: 'modern',
    minSupportedVersion: '3.0.0',
    artifactUrl: 'https://updates.example.test/app.exe',
    sha256: 'a'.repeat(64),
    signature: Buffer.alloc(64, 7).toString('base64'),
    releaseNotes: 'Fixes',
    ...overrides
  };
}

test('manifest parser validates channel, version, URL, hash, and signature', () => {
  assert.deepEqual(parseManifest(validManifest()).version, '3.1.0');
  assert.throws(() => parseManifest(validManifest({ channel: 'unknown' })), /channel/);
  assert.throws(() => parseManifest(validManifest({ sha256: 'bad' })), /sha256/);
  assert.throws(() => parseManifest(validManifest({ artifactUrl: 'http://updates.example.test/app.exe' })), /HTTPS/);
});

test('semver comparison handles release and prerelease versions', () => {
  assert.equal(compareVersions('3.1.0', '3.0.9'), 1);
  assert.equal(compareVersions('3.1.0-beta.1', '3.1.0'), -1);
  assert.equal(isUpdateAvailable('3.0.0', validManifest()), true);
  assert.equal(isUpdateAvailable('3.1.0', validManifest()), false);
});

test('manifest signature covers stable payload without signature field', () => {
  const first = canonicalManifestPayload(validManifest());
  const second = canonicalManifestPayload({ ...validManifest(), signature: 'different' });
  assert.equal(first, second);
});

test('integrity helpers hash and verify Ed25519 signatures', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pdb-integrity-'));
  const artifact = path.join(tempRoot, 'artifact.bin');
  await fs.writeFile(artifact, 'payload');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const payload = Buffer.from('payload');
  const signature = crypto.sign(null, payload, privateKey).toString('base64');
  assert.equal(await sha256File(artifact), crypto.createHash('sha256').update(payload).digest('hex'));
  assert.equal(verifyEd25519(payload, signature, publicKey.export({ type: 'spki', format: 'pem' })), true);
  assert.equal(verifyEd25519(Buffer.from('tampered'), signature, publicKey.export({ type: 'spki', format: 'pem' })), false);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('path safety rejects traversal outside install root', () => {
  const root = path.join(os.tmpdir(), 'pdb-install');
  assert.equal(safeJoin(root, 'nested', 'file.txt'), path.resolve(root, 'nested', 'file.txt'));
  assert.throws(() => assertSafePath(root, path.join(root, '..', 'escape')), /outside/);
});

test('directory update swaps atomically and restores on failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdb-rollback-'));
  const current = path.join(root, 'current');
  const staging = path.join(root, 'staging');
  const backup = path.join(root, 'backup');
  await fs.mkdir(current);
  await fs.mkdir(staging);
  await fs.writeFile(path.join(current, 'version.txt'), 'old');
  await fs.writeFile(path.join(staging, 'version.txt'), 'new');
  await applyDirectoryUpdate({ currentDir: current, stagingDir: staging, backupDir: backup });
  assert.equal(await fs.readFile(path.join(current, 'version.txt'), 'utf8'), 'new');
  await fs.rm(root, { recursive: true, force: true });
});

test('data migration backs up old data and preserves existing new data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdb-migration-'));
  const legacy = path.join(root, 'legacy');
  const data = path.join(root, 'data');
  await fs.mkdir(legacy);
  await fs.mkdir(data);
  await fs.writeFile(path.join(legacy, 'settings.json'), JSON.stringify({ old: true }));
  const first = await migrateData({ dataRoot: data, legacyRoot: legacy });
  assert.equal(first.migrated, true);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, 'settings.json'))), { old: true });
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ local: true }));
  const second = await migrateData({ dataRoot: data, legacyRoot: legacy });
  assert.equal(second.migrated, false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(data, 'settings.json'))), { local: true });
  const metadata = JSON.parse(await fs.readFile(path.join(data, 'metadata.json')));
  assert.equal(metadata.dataSchemaVersion, DATA_SCHEMA_VERSION);
  await fs.rm(root, { recursive: true, force: true });
});

test('data migration copies legacy uploads without overwriting new files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdb-upload-migration-'));
  const legacyData = path.join(root, 'legacy-data');
  const dataRoot = path.join(root, 'data');
  const legacyUploads = path.join(root, 'legacy-uploads');
  const uploadsRoot = path.join(root, 'uploads');
  await fs.mkdir(legacyData, { recursive: true });
  await fs.mkdir(legacyUploads, { recursive: true });
  await fs.mkdir(uploadsRoot, { recursive: true });
  await fs.writeFile(path.join(legacyUploads, 'old.xlsx'), 'old');
  await fs.writeFile(path.join(uploadsRoot, 'new.xlsx'), 'new');
  await migrateData({ dataRoot, legacyRoot: legacyData, uploadsRoot, legacyUploadsRoot: legacyUploads });
  assert.equal(await fs.readFile(path.join(uploadsRoot, 'old.xlsx'), 'utf8'), 'old');
  assert.equal(await fs.readFile(path.join(uploadsRoot, 'new.xlsx'), 'utf8'), 'new');
  await fs.rm(root, { recursive: true, force: true });
});
test('control plane requires operator JWT for device registration and protects admin routes', async () => {
  const repository = createInMemoryRepository();
  const app = createControlPlaneApp({
    repository,
    manifests: { modern: validManifest() },
    jwtSecret: 'test-secret'
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const address = server.address();
    const operator = createHs256Token({ sub: 'user-1', role: 'operator', email: 'operator@example.test' }, 'test-secret');
    const admin = createHs256Token({ sub: 'admin-1', role: 'admin', email: 'admin@example.test' }, 'test-secret');
    const denied = await fetch(`http://127.0.0.1:${address.port}/v1/devices/register`, { method: 'POST' });
    assert.equal(denied.status, 401);
    const registered = await fetch(`http://127.0.0.1:${address.port}/v1/devices/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${operator}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-1', os: 'win32', channel: 'modern', appVersion: '3.0.0' })
    });
    assert.equal(registered.status, 200);
    const registration = await registered.json();
    assert.equal(typeof registration.deviceToken, 'string');
    const badHeartbeat = await fetch(`http://127.0.0.1:${address.port}/v1/devices/heartbeat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${operator}`, 'Content-Type': 'application/json', 'X-Device-Token': 'wrong' },
      body: JSON.stringify({ deviceId: 'device-1', appVersion: '3.0.0' })
    });
    assert.equal(badHeartbeat.status, 403);
    const heartbeat = await fetch(`http://127.0.0.1:${address.port}/v1/devices/heartbeat`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${operator}`, 'Content-Type': 'application/json', 'X-Device-Token': registration.deviceToken },
      body: JSON.stringify({ deviceId: 'device-1', appVersion: '3.0.0', online: true, lastUpdateStatus: 'current' })
    });
    assert.equal(heartbeat.status, 200);
    const operatorAdmin = await fetch(`http://127.0.0.1:${address.port}/v1/admin/devices`, {
      headers: { Authorization: `Bearer ${operator}` }
    });
    assert.equal(operatorAdmin.status, 403);
    const adminDevices = await fetch(`http://127.0.0.1:${address.port}/v1/admin/devices`, {
      headers: { Authorization: `Bearer ${admin}` }
    });
    assert.equal(adminDevices.status, 200);
    assert.equal((await adminDevices.json()).items[0].deviceId, 'device-1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('encrypted token store does not write plaintext refresh token', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdb-token-'));
  const filePath = path.join(root, 'refresh-token.bin');
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, '')
  };
  const store = createEncryptedTokenStore({ safeStorage, filePath });
  await store.save('refresh-secret');
  assert.equal(await store.load(), 'refresh-secret');
  assert.doesNotMatch(await fs.readFile(filePath, 'utf8'), /refresh-secret/);
  await store.clear();
  assert.equal(await store.load(), null);
  await fs.rm(root, { recursive: true, force: true });
});
test('artifact audit rejects runtime data and secret files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdb-artifact-'));
  await fs.mkdir(path.join(root, 'server', 'data'), { recursive: true });
  await fs.writeFile(path.join(root, 'server', 'data', 'settings.json'), '{}');
  await assert.rejects(() => auditArtifact(root), /blocked path/);
  await fs.rm(root, { recursive: true, force: true });
});
test('modern updater verifies signed installer bytes before launch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdb-modern-update-'));
  const artifact = Buffer.from('modern installer');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const unsigned = {
    version: '3.3.0',
    channel: 'modern',
    minSupportedVersion: '3.0.0',
    artifactUrl: 'https://updates.example.test/app.exe',
    sha256: sha256Buffer(artifact),
    signature: Buffer.alloc(64).toString('base64'),
    releaseNotes: 'Modern update'
  };
  const manifest = { ...unsigned, signature: signEd25519(canonicalManifestPayload(unsigned), privateKey) };
  const requests = [];
  const spawned = [];
  const updater = createModernUpdater({
    getWindow: () => ({ isDestroyed: () => false }),
    manifestUrl: 'https://updates.example.test/manifest.json',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    allowedHosts: ['updates.example.test'],
    tempRoot: root,
    dialogImpl: { showMessageBox: async () => ({ response: 0 }) },
    appImpl: { getVersion: () => '3.0.0', quit: () => {} },
    spawnImpl: (file) => { spawned.push(file); return { unref() {} }; },
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.includes('manifest.json')) return { ok: true, status: 200, json: async () => manifest };
      return { ok: true, status: 200, headers: new Headers({ 'content-length': String(artifact.length) }), arrayBuffer: async () => artifact };
    }
  });
  const result = await updater.checkAtStartup();
  assert.equal(result.status, 'downloaded');
  assert.equal(requests.length, 2);
  assert.equal(updater.installOnQuit(), true);
  assert.equal(spawned.length, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test('modern updater fails closed when trust configuration is missing', async () => {
  const updater = createModernUpdater({
    getWindow: () => ({ isDestroyed: () => false }),
    appImpl: { getVersion: () => '3.0.0' },
    dialogImpl: { showMessageBox: async () => ({ response: 0 }) }
  });
  assert.equal((await updater.checkAtStartup()).status, 'not-configured');
});

test('control-plane client authenticates, registers device, and reports disabled state', async () => {
  const requests = [];
  const values = new Map();
  const makeStore = (name) => ({
    async save(value) { values.set(name, value); },
    async load() { return values.get(name) || null; },
    async clear() { values.delete(name); }
  });
  let disabled = false;
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const client = createControlPlaneClient({
    controlPlaneUrl: 'https://control.example.test',
    supabaseUrl: 'https://project.supabase.co',
    supabaseAnonKey: 'public-anon-key',
    channel: 'modern',
    appVersion: '3.0.0',
    os: 'win32',
    deviceId: 'device-test',
    refreshTokenStore: makeStore('refresh'),
    deviceTokenStore: makeStore('device'),
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.includes('/auth/v1/token')) return json(200, { access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 });
      if (url.endsWith('/v1/devices/register')) return json(200, { ok: true, device: { deviceId: 'device-test' }, deviceToken: 'device-secret' });
      if (url.endsWith('/v1/me')) return json(200, { profile: { id: 'user-1', active: true }, devices: [] });
      if (url.endsWith('/v1/devices/heartbeat') && disabled) return json(403, { error: 'User disabled' });
      if (url.endsWith('/v1/devices/heartbeat')) return json(200, { ok: true, device: { deviceId: 'device-test', online: true } });
      throw new Error(`Unexpected URL: ${url}`);
    }
  });
  await client.login({ email: 'operator@example.test', password: 'password' });
  assert.equal(client.getStatus().status, 'online');
  assert.equal(JSON.stringify(client.getStatus()).includes('access-token'), false);
  assert.equal(JSON.stringify(client.getStatus()).includes('device-secret'), false);
  assert.equal(values.get('refresh'), 'refresh-token');
  assert.equal(values.get('device'), 'device-secret');
  disabled = true;
  await client.heartbeat();
  assert.equal(client.getStatus().status, 'disabled');
  assert.match(client.getStatus().error, /User disabled/);
  const deniedHeartbeatCount = requests.length;
  await client.heartbeat();
  assert.equal(requests.length, deniedHeartbeatCount);
  assert.equal(requests.some(({ url, options }) => url.endsWith('/v1/devices/heartbeat') && options.headers.Authorization === 'Bearer access-token'), true);
  client.dispose();
});
test('updaters treat control-plane 204 as current', async () => {
  const modern = createModernUpdater({
    getWindow: () => ({ isDestroyed: () => false }),
    manifestUrl: 'https://updates.example.test/manifest.json',
    publicKey: 'unused',
    allowedHosts: ['updates.example.test'],
    appImpl: { getVersion: () => '3.0.0' },
    fetchImpl: async () => ({ ok: true, status: 204, url: 'https://updates.example.test/manifest.json' })
  });
  assert.equal((await modern.checkAtStartup()).status, 'current');

});

test('sanitizeMetadata filters non-allowlisted keys and enforces size limit', () => {
  const clean = sanitizeMetadata({
    botActive: true,
    heapUsedMb: 120,
    rssMb: 250,
    uptimeSeconds: 3600,
    apiKey: 'secret-leaked',
    sqlInjection: 'DROP TABLE',
    arbitrary: 'ignored'
  });
  assert.deepEqual(clean, { botActive: true, heapUsedMb: 120, rssMb: 250, uptimeSeconds: 3600 });
  assert.equal(clean.apiKey, undefined);

  // Reject oversized payloads
  const oversized = { botActive: true, heapUsedMb: 1, rssMb: 1, uptimeSeconds: 1 };
  assert.deepEqual(sanitizeMetadata(oversized), oversized);
  assert.deepEqual(sanitizeMetadata(null), {});
  assert.deepEqual(sanitizeMetadata('string'), {});
});

test('normalizeHeartbeatInput accepts clean metadata and ignores malformed inputs', () => {
  const result = normalizeHeartbeatInput({
    appVersion: '3.0.0',
    online: true,
    metadata: { botActive: false, heapUsedMb: 80, token: 'leak' }
  });
  assert.equal(result.appVersion, '3.0.0');
  assert.equal(result.metadata.botActive, false);
  assert.equal(result.metadata.heapUsedMb, 80);
  assert.equal(result.metadata.token, undefined);
});

test('client heartbeat sends metadata gathered from getMetadata callback', async () => {
  const requests = [];
  const client = createControlPlaneClient({
    controlPlaneUrl: 'https://control.example.test',
    supabaseUrl: 'https://supabase.example.test',
    supabaseAnonKey: 'anon',
    safeStorage: { isEncryptionAvailable: () => false },
    channel: 'modern',
    appVersion: '3.0.0',
    deviceId: 'device-test-meta',
    refreshTokenStore: { save: async () => {}, load: async () => 'refresh-token', clear: async () => {} },
    deviceTokenStore: { save: async () => {}, load: async () => 'device-token', clear: async () => {} },
    getMetadata: () => ({ botActive: true, heapUsedMb: 99, uptimeSeconds: 42 }),
    fetchImpl: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      // Supabase token refresh
      if (url.includes('/auth/v1/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'jwt-test', refresh_token: 'refresh-token', expires_in: 3600 }) };
      if (url.endsWith('/v1/me')) return { ok: true, status: 200, json: async () => ({ profile: { id: 'u1', role: 'operator', active: true } }) };
      if (url.endsWith('/v1/devices/heartbeat')) return { ok: true, status: 200, json: async () => ({ ok: true, device: { deviceId: 'device-test-meta' } }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });

  // initialize loads refresh token from store and runs a session refresh -> sets accessToken
  await client.initialize();
  // now heartbeat should fire because accessToken is set
  await client.heartbeat();
  const hbReq = requests.find((r) => r.url.endsWith('/v1/devices/heartbeat'));
  assert.ok(hbReq, 'Heartbeat request should be sent');
  assert.equal(hbReq.body.metadata.botActive, true);
  assert.equal(hbReq.body.metadata.heapUsedMb, 99);
  assert.equal(hbReq.body.metadata.uptimeSeconds, 42);
  client.dispose();
});
