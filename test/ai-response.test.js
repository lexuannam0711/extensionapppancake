const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractResponseText,
  resolveAIConfig,
  testAIConnection
} = require('../src/server/ai');

test('AI response parser accepts normal OpenAI message content', () => {
  assert.equal(
    extractResponseText({ choices: [{ message: { content: '{"ok":true}' } }] }),
    '{"ok":true}'
  );
});

test('AI response parser accepts Antigravity reasoning content when final content is empty', () => {
  assert.equal(
    extractResponseText({ choices: [{ message: { content: '', reasoning_content: '{"ok":true}' } }] }),
    '{"ok":true}'
  );
});

test('AI response parser accepts OpenAI text and Gemini candidate parts', () => {
  assert.equal(extractResponseText({ choices: [{ text: '{"ok":true}' }] }), '{"ok":true}');
  assert.equal(
    extractResponseText({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }),
    '{"ok":true}'
  );
});

test('AI response parser accepts Antigravity Interactions model output steps', () => {
  assert.equal(
    extractResponseText({
      steps: [
        { type: 'thought', content: [{ type: 'text', text: '{"ok":false}' }] },
        { type: 'model_output', content: [{ type: 'text', text: '{"ok":true}' }] }
      ]
    }),
    '{"ok":true}'
  );
});

test('AI response parser accepts Antigravity Interactions outputs', () => {
  assert.equal(
    extractResponseText({ outputs: [{ type: 'text', text: '{"ok":true}' }] }),
    '{"ok":true}'
  );
});

test('AI response parser accepts wrapped provider envelopes', () => {
  assert.equal(
    extractResponseText({ interaction: { outputs: [{ text: '{"ok":true}' }] } }),
    '{"ok":true}'
  );
  assert.equal(
    extractResponseText({ data: { message: { content: '{"ok":true}' } } }),
    '{"ok":true}'
  );
  assert.equal(
    extractResponseText({ data: { choices: [{ message: { content: '{"ok":true}' } }] } }),
    '{"ok":true}'
  );
});

test('AI response parser ignores Gemini thinking parts when a final part exists', () => {
  assert.equal(
    extractResponseText({
      candidates: [{ content: { parts: [
        { thought: true, text: '{"ok":false}' },
        { text: '{"ok":true}' }
      ] } }]
    }),
    '{"ok":true}'
  );
});

test('AI response parser accepts structured content parts and output_text', () => {
  assert.equal(
    extractResponseText({ choices: [{ message: { content: [{ type: 'text', text: '{"ok":true}' }] } }] }),
    '{"ok":true}'
  );
  assert.equal(extractResponseText({ output_text: '{"ok":true}' }), '{"ok":true}');
});

test('AI connection reports a typed empty-response error', async () => {
  const previousFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ choices: [{ message: { content: '' } }] })
  });
  try {
    await assert.rejects(
      testAIConnection({ aiBaseUrl: 'https://antigravity.example.test/v1', aiApiKey: 'test-key', aiModel: 'ag-model' }),
      (error) => error?.code === 'AI_EMPTY_RESPONSE'
    );
  } finally {
    global.fetch = previousFetch;
  }
});

test('AI config resolves explicit Antigravity protocol', () => {
  const config = resolveAIConfig({
    aiProtocol: 'antigravity',
    aiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    aiApiKey: 'test-key',
    aiModel: 'antigravity-preview-09-2026'
  });
  assert.equal(config.protocol, 'antigravity');
  assert.equal(config.transport, 'interactions');
  assert.equal(config.chatUrl, 'https://generativelanguage.googleapis.com/v1beta/interactions');
});

test('AI config uses OpenAI-compatible transport for custom Antigravity v1 gateways', () => {
  const config = resolveAIConfig({
    aiProtocol: 'antigravity',
    aiBaseUrl: 'https://ag.example.test/v1',
    aiApiKey: 'test-key',
    aiModel: 'ag-model'
  });
  assert.equal(config.transport, 'openai-chat');
  assert.equal(config.chatUrl, 'https://ag.example.test/v1/chat/completions');
});

test('Antigravity Interactions transport sends native agent payload', async () => {
  const previousFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"ok":true}' }] }]
      })
    };
  };
  try {
    const result = await testAIConnection({
      aiProtocol: 'antigravity',
      aiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      aiApiKey: 'test-key',
      aiModel: 'antigravity-preview-09-2026'
    });
    assert.equal(result.ok, true);
    assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(request.options.headers['x-goog-api-key'], 'test-key');
    assert.equal(request.options.headers.Authorization, undefined);
    assert.equal(request.body.agent, 'antigravity-preview-09-2026');
    assert.equal(request.body.model, undefined);
    assert.equal(request.body.input.includes('{"ok":true}'), true);
    assert.equal(request.body.response_format, undefined);
    assert.equal(request.body.generation_config, undefined);
    assert.equal(request.body.environment, 'remote');
    assert.equal(request.body.store, false);
    assert.equal(request.body.stream, false);
  } finally {
    global.fetch = previousFetch;
  }
});

test('Antigravity transport sends native Gemini generateContent payload', async () => {
  const previousFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] })
    };
  };
  try {
    const result = await testAIConnection({
      aiProtocol: 'antigravity',
      aiBaseUrl: 'https://cloudcode-pa.googleapis.com',
      aiApiKey: 'test-token',
      aiModel: 'gemini-3-flash'
    });
    assert.equal(result.ok, true);
    assert.equal(request.url, 'https://cloudcode-pa.googleapis.com/v1internal:generateContent');
    assert.equal(request.options.headers.Authorization, 'Bearer test-token');
    assert.equal(request.body.model, 'gemini-3-flash');
    assert.equal(request.body.contents[0].role, 'user');
    assert.equal(typeof request.body.contents[0].parts[0].text, 'string');
    assert.equal(request.body.generationConfig.maxOutputTokens, 700);
  } finally {
    global.fetch = previousFetch;
  }
});

test('Gemini transport uses model path and API-key header', async () => {
  const previousFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] })
    };
  };
  try {
    await testAIConnection({
      aiProtocol: 'gemini',
      aiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      aiApiKey: 'test-key',
      aiModel: 'gemini-2.5-flash'
    });
    assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(request.options.headers['x-goog-api-key'], 'test-key');
    assert.equal(request.options.headers.Authorization, undefined);
    assert.equal(request.body.model, undefined);
  } finally {
    global.fetch = previousFetch;
  }
});
