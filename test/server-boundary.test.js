const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApp,
  isAllowedCorsOrigin,
  getServerListenOptions,
  getAiTestErrorStatus
} = require('../src/server');

test('server boundary: CORS permits requests without an Origin header', () => {
  assert.equal(isAllowedCorsOrigin(undefined), true);
  assert.equal(isAllowedCorsOrigin(null), true);
  assert.equal(isAllowedCorsOrigin(''), true);
});

test('server boundary: CORS permits only the literal null renderer origin', () => {
  assert.equal(isAllowedCorsOrigin('null'), true);

  for (const untrustedOrigin of [
    'https://pages.fm',
    'https://pancake.vn',
    'https://evil.example',
    'http://127.0.0.1:8787',
    'NULL',
    ' null '
  ]) {
    assert.equal(
      isAllowedCorsOrigin(untrustedOrigin),
      false,
      `expected CORS to reject ${JSON.stringify(untrustedOrigin)}`
    );
  }
});

test('server boundary: listen configuration binds the API to IPv4 loopback', () => {
  assert.deepEqual(getServerListenOptions(8787), {
    port: 8787,
    host: '127.0.0.1'
  });
});

test('AI test maps configuration errors to 400 and upstream failures to 502', () => {
  assert.equal(getAiTestErrorStatus(new Error('Thiếu AI API key')), 400);
  assert.equal(getAiTestErrorStatus(Object.assign(new Error('network down'), { code: 'AI_NETWORK_ERROR' })), 502);
  assert.equal(getAiTestErrorStatus(Object.assign(new Error('provider rejected request'), { code: 'AI_PROVIDER_ERROR' })), 502);
});

test('server boundary: Electron API requires capability token when configured', async () => {
  const server = createApp({ authToken: 'local-secret' }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    const denied = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`http://127.0.0.1:${address.port}/health`, { headers: { 'X-Local-Api-Token': 'local-secret' } });
    assert.equal(allowed.status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});