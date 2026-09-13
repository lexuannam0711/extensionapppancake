const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { requestJsonCompat } = require('../src/server/httpClient');
const { testAIConnection } = require('../src/server/ai');

function startFixture(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

test('legacy HTTP fallback sends JSON and parses a successful response without fetch', async () => {
  const fixture = await startFixture((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.headers['content-type'], 'application/json');
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      assert.deepEqual(JSON.parse(body), { ping: 'pong' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  try {
    const response = await requestJsonCompat(fixture.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ping: 'pong' })
    }, { fetchImpl: undefined });
    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test('legacy HTTP fallback preserves provider error status and JSON body', async () => {
  const fixture = await startFixture((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid key' } }));
  });

  try {
    const response = await requestJsonCompat(fixture.url, {}, { fetchImpl: undefined });
    assert.equal(response.ok, false);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { message: 'invalid key' } });
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test('AI connection test works when fetch is unavailable', async () => {
  const fixture = await startFixture((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });

  try {
    const result = await testAIConnection({}, {
      aiBaseUrl: fixture.url,
      aiApiKey: 'test-key',
      aiModel: 'test-model'
    }, { fetchImpl: undefined });
    assert.equal(result.ok, true);
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});
