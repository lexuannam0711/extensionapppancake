const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveClientConfig } = require('../src/control-plane/clientConfig');
const { createControlPlaneClient } = require('../src/control-plane/client');

test('clientConfig resolves public production defaults when environment is empty', () => {
  const config = resolveClientConfig({});
  assert.equal(config.controlPlaneUrl, 'https://api.xnampersonal.id.vn');
  assert.equal(config.supabaseUrl, 'https://dbxraxyytegqmzhygosc.supabase.co');
  assert.ok(config.supabaseAnonKey && config.supabaseAnonKey.startsWith('eyJ'));
  assert.equal(config.updateManifestUrl, 'https://api.xnampersonal.id.vn/v1/update-manifest');
});

test('clientConfig prefers environment variables over defaults', () => {
  const custom = {
    CONTROL_PLANE_URL: 'https://custom.example.test',
    SUPABASE_URL: 'https://custom-sub.supabase.co',
    SUPABASE_ANON_KEY: 'custom-anon-key',
    UPDATE_MANIFEST_URL: 'https://custom.example.test/v1/update-manifest'
  };
  const config = resolveClientConfig(custom);
  assert.equal(config.controlPlaneUrl, 'https://custom.example.test');
  assert.equal(config.supabaseUrl, 'https://custom-sub.supabase.co');
  assert.equal(config.supabaseAnonKey, 'custom-anon-key');
  assert.equal(config.updateManifestUrl, 'https://custom.example.test/v1/update-manifest');
});

test('control plane client initializes configured state with resolved defaults', () => {
  const config = resolveClientConfig({});
  const makeStore = () => ({
    save: async () => {},
    load: async () => null,
    clear: async () => {}
  });
  const client = createControlPlaneClient({
    controlPlaneUrl: config.controlPlaneUrl,
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    refreshTokenStore: makeStore(),
    deviceTokenStore: makeStore(),
    deviceId: 'device-zero-config-test',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) })
  });
  assert.equal(client.getStatus().configured, true);
  assert.equal(client.getStatus().status, 'signed_out');
  client.dispose();
});
