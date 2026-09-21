const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  TtsError,
  getAudioContentType,
  normalizeTtsEndpoint,
  synthesizeSpeech
} = require('../src/server/tts');

function startFixture(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, endpoint: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function closeFixture(server) {
  await new Promise((resolve) => server.close(resolve));
}

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test('tts endpoint normalization appends the OpenAI speech path', () => {
  assert.equal(
    normalizeTtsEndpoint('https://tts.example.test'),
    'https://tts.example.test/v1/audio/speech'
  );
  assert.equal(
    normalizeTtsEndpoint('https://tts.example.test/v1/'),
    'https://tts.example.test/v1/audio/speech'
  );
  assert.equal(
    normalizeTtsEndpoint('https://tts.example.test/v1/audio/speech/'),
    'https://tts.example.test/v1/audio/speech'
  );
});

test('tts endpoint normalization rejects missing or unsupported endpoints with a typed error', () => {
  assert.throws(
    () => normalizeTtsEndpoint(''),
    (error) => error instanceof TtsError && error.code === 'TTS_CONFIG_ERROR'
  );
  assert.throws(
    () => normalizeTtsEndpoint('ftp://tts.example.test'),
    (error) => error instanceof TtsError && error.code === 'TTS_CONFIG_ERROR'
  );
  assert.throws(
    () => normalizeTtsEndpoint('http://tts.example.test'),
    (error) => error instanceof TtsError && error.code === 'TTS_CONFIG_ERROR'
  );
});

test('tts maps supported response formats to safe audio MIME types', () => {
  assert.equal(getAudioContentType('mp3'), 'audio/mpeg');
  assert.equal(getAudioContentType('wav'), 'audio/wav');
  assert.equal(getAudioContentType('ogg'), 'audio/ogg');
  assert.equal(getAudioContentType('unknown'), 'audio/mpeg');
});

test('synthesizeSpeech sends an OpenAI-compatible request and returns an mp3 Buffer', async () => {
  const audio = Buffer.from('ID3-test-audio');
  let request;
  const fixture = await startFixture((req, res) => {
    request = req;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      request.body = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(audio);
    });
  });

  try {
    const result = await withEnv({
      TTS_API_URL: fixture.endpoint,
      TTS_API_KEY: 'env-test-token',
      TTS_MODEL: 'google-tts/vi'
    }, () => synthesizeSpeech('Khách mua hàng mới'));

    assert.deepEqual(result, audio);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/audio/speech');
    assert.equal(request.headers.authorization, 'Bearer env-test-token');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.deepEqual(request.body, {
      model: 'google-tts/vi',
      input: 'Khách mua hàng mới',
      response_format: 'mp3'
    });
  } finally {
    await closeFixture(fixture.server);
  }
});

test('synthesizeSpeech never takes an apiKey option over the environment key', async () => {
  let authorization = '';
  const fixture = await startFixture((req, res) => {
    authorization = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(Buffer.from('audio'));
  });

  try {
    await withEnv({ TTS_API_URL: fixture.endpoint, TTS_API_KEY: 'env-only-token' }, () => (
      synthesizeSpeech('test', { apiKey: ['caller', 'supplied', 'fixture'].join('-') })
    ));
    assert.equal(authorization, 'Bearer env-only-token');
  } finally {
    await closeFixture(fixture.server);
  }
});

test('synthesizeSpeech reports missing configuration with typed errors', async () => {
  await withEnv({ TTS_API_URL: 'http://127.0.0.1:1', TTS_API_KEY: null }, async () => {
    await assert.rejects(
      synthesizeSpeech('test'),
      (error) => error instanceof TtsError && error.code === 'TTS_CONFIG_ERROR'
    );
  });
});

test('synthesizeSpeech preserves provider status in typed HTTP errors without exposing the bearer token', async () => {
  const fixture = await startFixture((_req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid credentials' }));
  });

  try {
    await withEnv({ TTS_API_URL: fixture.endpoint, TTS_API_KEY: 'secret-test-token' }, async () => {
      await assert.rejects(
        synthesizeSpeech('test'),
        (error) => {
          assert.equal(error instanceof TtsError, true);
          assert.equal(error.code, 'TTS_HTTP_ERROR');
          assert.equal(error.statusCode, 401);
          assert.match(error.message, /401/);
          assert.doesNotMatch(error.message, /secret-test-token/);
          return true;
        }
      );
    });
  } finally {
    await closeFixture(fixture.server);
  }
});

test('synthesizeSpeech reports empty audio responses as typed invalid responses', async () => {
  const fixture = await startFixture((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end();
  });

  try {
    await withEnv({ TTS_API_URL: fixture.endpoint, TTS_API_KEY: 'test-token' }, async () => {
      await assert.rejects(
        synthesizeSpeech('test'),
        (error) => error instanceof TtsError && error.code === 'TTS_INVALID_RESPONSE'
      );
    });
  } finally {
    await closeFixture(fixture.server);
  }
});

test('synthesizeSpeech converts request timeouts into typed timeout errors', async () => {
  const fixture = await startFixture(() => {});

  try {
    await withEnv({ TTS_API_URL: fixture.endpoint, TTS_API_KEY: 'test-token' }, async () => {
      await assert.rejects(
        synthesizeSpeech('test', { timeoutMs: 20 }),
        (error) => error instanceof TtsError && error.code === 'TTS_TIMEOUT'
      );
    });
  } finally {
    await closeFixture(fixture.server);
  }
});
