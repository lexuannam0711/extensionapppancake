const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_CUSTOMER_TAGS,
  MAX_CUSTOMER_TAG_LENGTH,
  normalizeVietnameseText,
  sanitizeCustomerTags,
  getEligibleReturningCustomerTags,
  getRepurchaseBlocker,
  detectExplicitRepurchase
} = require('../src/server/rules');
const {
  analyzeMessageWithAI,
  buildPrompt,
  selectLastCustomerText
} = require('../src/server/ai');

const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

const shortcuts = [
  { shortcut: '/1', topic: 'Khách mới', message: 'Xin chào' },
  { shortcut: '/32', topic: 'Chăm sóc khách cũ', message: 'Hướng dẫn khách đã mua' }
];

const shortcutsWithContactRequests = [
  ...shortcuts,
  { shortcut: '/8', topic: 'Xin thong tin', message: 'Cho shop xin so dien thoai va dia chi nhan hang day du' },
  { shortcut: '/10', topic: 'Dia chi nha thuoc', message: 'Dia chi cong ty, quay thuoc va map' },
  { shortcut: '/17', topic: 'Xin so dien thoai', message: 'Cho shop xin so dien thoai' },
  { shortcut: '/18', topic: 'Xin dia chi', message: 'Cho shop xin dia chi nhan hang day du' }
];

function mockAI(result, { ok = true } = {}) {
  global.fetch = async () => ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Error',
    json: async () => ok
      ? { choices: [{ message: { content: typeof result === 'string' ? result : JSON.stringify(result) } }] }
      : { error: { message: 'mock failure' } }
  });
}

function analyze(overrides = {}) {
  return analyzeMessageWithAI({
    customerMessage: 'chị đang dùng sản phẩm thế nào',
    shortcuts,
    context: { currentTags: ['Nhãn Saruto VIP'] },
    settings: { aiApiKey: 'test-key', minConfidence: 0.75 },
    history: [],
    ...overrides
  });
}

function loadCreateAppWithStore(storeOverrides) {
  const storePath = require.resolve('../src/server/store');
  const serverPath = require.resolve('../src/server/index');
  const previousStore = require.cache[storePath];
  const previousServer = require.cache[serverPath];
  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: { UPLOADS: process.cwd(), ...storeOverrides }
  };
  delete require.cache[serverPath];
  const { createApp } = require(serverPath);

  if (previousStore) require.cache[storePath] = previousStore;
  else delete require.cache[storePath];
  if (previousServer) require.cache[serverPath] = previousServer;
  else delete require.cache[serverPath];
  return createApp;
}

async function listenOnEphemeralPort(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

async function analyzeThroughRoute({ autoSend, body, aiResult, shortcutItems = shortcuts }) {
  if (aiResult) mockAI(aiResult);
  const createApp = loadCreateAppWithStore({
    getSettings: async () => ({ autoSend, minConfidence: 0.75, aiApiKey: 'test-key' }),
    getShortcuts: async () => ({ items: shortcutItems }),
    getExamples: async () => ({ items: [] }),
    appendLog: async () => {}
  });
  const server = await listenOnEphemeralPort(createApp());
  try {
    const address = server.address();
    const response = await originalFetch(`http://127.0.0.1:${address.port}/api/ai/analyze-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: response.status, result: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('repurchase tags are array-only, bounded, normalized, and returned in original form', () => {
  assert.deepEqual(sanitizeCustomerTags('Nhãn Saruto'), []);
  assert.equal(sanitizeCustomerTags(Array(MAX_CUSTOMER_TAGS + 4).fill('tag')).length, MAX_CUSTOMER_TAGS);
  assert.equal(sanitizeCustomerTags(['x'.repeat(MAX_CUSTOMER_TAG_LENGTH + 7)])[0].length, MAX_CUSTOMER_TAG_LENGTH);
  assert.equal(normalizeVietnameseText('  ĐÃ   NHẬN   TRẢ  '), 'da nhan tra');

  const tags = ['  Nhãn Saruto - VIP  ', 'Đã Nhận Trả 02', 'Khách Trống lịch', 'Không liên quan'];
  assert.deepEqual(getEligibleReturningCustomerTags(tags), tags.slice(0, 3).map((tag) => tag.trim()));
});

test('plain da nhan tags are eligible returning-customer tags', () => {
  assert.deepEqual(getEligibleReturningCustomerTags(['\u0110\u00e3 Nh\u1eadn']), ['\u0110\u00e3 Nh\u1eadn']);
  assert.deepEqual(getEligibleReturningCustomerTags(['\u0110\u00e3 nh\u1eadn 01', '\u0110\u00e3 nh\u1eadn h\u00e0ng']), [
    '\u0110\u00e3 nh\u1eadn 01',
    '\u0110\u00e3 nh\u1eadn h\u00e0ng'
  ]);
});

test('explicit repurchase detection accepts positive forms and applies negatives first', () => {
  for (const message of [
    'ok',
    'ok em',
    'oke',
    'oki',
    'em gui di',
    'gui tiep 2 hop',
    'gui them 2 hop',
    'gui ve dia chi cu',
    'chị mua thêm nhé',
    'chị mua tiếp',
    'chị mua 2 hộp',
    'lấy lại giúp chị',
    'gửi thêm cho mình',
    'gửi địa chỉ cũ',
    'gửi về địa chỉ cũ',
    'gửi tiếp đi',
    'ừ em gửi đi',
    'gửi tiếp dùng thử xem sao',
    'ship lại đơn cũ',
    'cho chị 2 hộp',
    'giao về địa chỉ cũ',
    'cảm ơn shop, cho chị 2 hộp'
  ]) {
    assert.equal(detectExplicitRepurchase(message), true, message);
  }

  for (const message of [
    'chị không mua thêm đâu',
    'hủy đơn ship lại giúp chị',
    'hàng sai, khiếu nại chứ không lấy nữa',
    'chị không nhận được hàng mà shop còn gửi thêm à',
    'dịch vụ tệ, đừng ship lại',
    'chị đã dùng 2 hộp rồi',
    'cho chị xem giá 2 hộp bao nhiêu',
    'ok cảm ơn'
  ]) {
    assert.equal(detectExplicitRepurchase(message), false, message);
  }
});

test('repurchase blockers match complaint phrases, not substrings inside unrelated words', () => {
  assert.equal(getRepurchaseBlocker('tết shop có gửi thêm không'), null);
  assert.equal(getRepurchaseBlocker('dịch vụ tệ, đừng gửi thêm'), 'COMPLAINT');
});

test('last customer text is selected only from the final five history items', () => {
  const history = [
    { from: 'customer', text: 'mua thêm 9 hộp' },
    { from: 'admin', text: '1' },
    { from: 'admin', text: '2' },
    { from: 'customer', text: 'tin trong cửa sổ' },
    { from: 'admin', text: '3' },
    { from: 'customer', text: 'ok em' }
  ];
  assert.equal(selectLastCustomerText(history, ''), 'ok em');
  assert.equal(selectLastCustomerText(history, 'chị không mua nữa'), 'chị không mua nữa');
  assert.equal(selectLastCustomerText(history, 'sent a sticker'), 'sent a sticker');
  assert.equal(selectLastCustomerText([{ from: 'admin', text: 'shop' }], 'fallback'), 'fallback');
});

test('clear repurchase is handled by the server rule without AI confirmation', async () => {
  global.fetch = async () => { throw new Error('AI must not be called'); };
  const result = await analyze({
    customerMessage: '',
    history: [
      { from: 'admin', text: 'shop tư vấn' },
      { from: 'customer', text: 'cho chị lấy thêm 2 hộp' }
    ],
    settings: { aiApiKey: 'test-key', autoSend: true }
  });

  assert.equal(result.intent, 'REPURCHASE_INTENT');
  assert.equal(result.action, 'TAG_BUY_AND_MARK_UNREAD');
  assert.equal(result.confidence, 1);
  assert.equal(result.shouldSend, false);
  assert.equal(result.repurchase.evidence, 'explicit_rule');
});

test('rule candidate escalates even when AI would be uncertain', async () => {
  global.fetch = async () => { throw new Error('AI must not be called'); };
  const result = await analyze({ customerMessage: '\u0063\u0068\u1ecb mua ti\u1ebfp 2 h\u1ed9p' });

  assert.equal(result.action, 'TAG_BUY_AND_MARK_UNREAD');
  assert.equal(result.bestShortcut, null);
  assert.equal(result.repurchase.evidence, 'explicit_rule');
});

test('AI alone cannot escalate without a matching rule and uses /32', async () => {
  mockAI({ intent: 'REPURCHASE_INTENT', action: 'TAG_BUY_AND_MARK_UNREAD', confidence: 0.99 });
  const result = await analyze({ customerMessage: '\u0063\u0068\u1ecb \u0111ang xem l\u1ea1i s\u1ea3n ph\u1ea9m' });

  assert.equal(result.action, 'SUGGEST_SHORTCUT');
  assert.equal(result.bestShortcut, '/32');
  assert.equal(Object.hasOwn(result, 'repurchase'), false);
});

test('plain da nhan tags force returning customers back to /32 when AI suggests contact shortcuts', async () => {
  for (const aiShortcut of ['/17', '/18']) {
    mockAI({
      intent: 'BUY_INTENT_LOW',
      action: 'SUGGEST_SHORTCUT',
      bestShortcut: aiShortcut,
      confidence: 0.95,
      reason: 'mock contact request'
    });
    const result = await analyze({
      customerMessage: '\u0063\u0068\u1ecb \u0111ang d\u00f9ng th\u1eed',
      shortcuts: shortcutsWithContactRequests,
      context: { currentTags: ['\u0110\u00e3 Nh\u1eadn'] }
    });

    assert.equal(result.intent, 'RETURNING_CUSTOMER_FOLLOWUP', aiShortcut);
    assert.equal(result.action, 'SUGGEST_SHORTCUT', aiShortcut);
    assert.equal(result.bestShortcut, '/32', aiShortcut);
    assert.equal(Object.hasOwn(result, 'repurchase'), false, aiShortcut);
  }
});

test('certain short confirmations are handled by server rule without a preceding admin offer', async () => {
  global.fetch = async () => { throw new Error('AI must not be called'); };
  for (const message of ['ok', 'OK!', 'ok em', 'Oke.', 'oki', 'ok em g\u1eedi \u0111i', 'em gui di']) {
    const result = await analyze({
      customerMessage: message,
      history: [{ from: 'customer', text: message }]
    });
    assert.equal(result.action, 'TAG_BUY_AND_MARK_UNREAD', message);
    assert.equal(result.repurchase.evidence, 'explicit_rule', message);
  }
});

test('certain short confirmation does not depend on admin acknowledgements or stale offers', async () => {
  global.fetch = async () => { throw new Error('AI must not be called'); };
  const adminAcknowledgement = await analyze({
    customerMessage: 'ok em',
    history: [{ from: 'admin', text: 'ok em' }]
  });
  assert.equal(adminAcknowledgement.action, 'TAG_BUY_AND_MARK_UNREAD');

  const staleOffer = await analyze({
    customerMessage: 'ok em',
    history: [
      { from: 'admin', text: '\u0063\u0068\u1ecb l\u1ea5y th\u00eam 2 h\u1ed9p nh\u00e9' },
      { from: 'customer', text: '\u0063\u0068\u1ecb kh\u00f4ng mua n\u1eefa' }
    ]
  });
  assert.equal(staleOffer.action, 'TAG_BUY_AND_MARK_UNREAD');
});

test('isolated short confirmations escalate without AI confirmation', async () => {
  global.fetch = async () => { throw new Error('AI must not be called'); };
  const result = await analyze({ customerMessage: 'ok em', history: [] });

  assert.equal(result.action, 'TAG_BUY_AND_MARK_UNREAD');
  assert.equal(result.bestShortcut, null);
  assert.equal(result.repurchase.evidence, 'explicit_rule');
});

test('certain short confirmations ignore low-confidence or invalid AI responses', async () => {
  global.fetch = async () => { throw new Error('AI must not be called'); };
  const lowConfidence = await analyze({ customerMessage: 'ok em' });
  assert.equal(lowConfidence.action, 'TAG_BUY_AND_MARK_UNREAD');
  assert.equal(lowConfidence.bestShortcut, null);

  const invalid = await analyze({ customerMessage: 'ok em gửi đi' });
  assert.equal(invalid.action, 'TAG_BUY_AND_MARK_UNREAD');
  assert.equal(invalid.bestShortcut, null);
});

test('certain short confirmation remains valid when the latest admin message is not an offer', async () => {
  global.fetch = async () => { throw new Error('AI must not be called'); };
  const result = await analyze({
    customerMessage: 'ok em',
    history: [
      { from: 'admin', text: '\u0063\u0068\u1ecb l\u1ea5y th\u00eam 2 h\u1ed9p nh\u00e9' },
      { from: 'admin', text: 'h\u1ebft h\u00e0ng r\u1ed3i ch\u1ecb \u01a1i' },
      { from: 'customer', text: 'ok em' }
    ]
  });

  assert.equal(result.action, 'TAG_BUY_AND_MARK_UNREAD');
  assert.equal(result.bestShortcut, null);
});

test('current non-text content is skipped instead of replaying stale purchase history', async () => {
  global.fetch = async () => { throw new Error('AI must not be called'); };
  const result = await analyze({
    customerMessage: 'sent a sticker',
    history: [
      { from: 'admin', text: 'chị cần lấy thêm không' },
      { from: 'customer', text: 'cho chị mua thêm 2 hộp' }
    ]
  });

  assert.equal(result.intent, 'NON_TEXT');
  assert.equal(result.action, 'SKIP');
  assert.equal(result.shouldSend, false);
});

test('route escalates a server-rule candidate and keeps it non-sendable', async () => {
  const { status, result } = await analyzeThroughRoute({
    autoSend: true,
    aiResult: { intent: 'REPURCHASE_INTENT', action: 'TAG_BUY_AND_MARK_UNREAD', confidence: 0.9 },
    body: {
      customerMessage: 'chị mua thêm 2 hộp',
      currentTags: ['Nhãn Saruto VIP'],
      conversationHistory: [{ from: 'customer', text: 'chị mua thêm 2 hộp' }]
    }
  });

  assert.equal(status, 200);
  assert.equal(result.intent, 'REPURCHASE_INTENT');
  assert.equal(result.action, 'TAG_BUY_AND_MARK_UNREAD');
  assert.equal(result.bestShortcut, null);
  assert.equal(result.shouldSend, false);
});

test('route escalates an explicit candidate even when AI would not confirm repurchase', async () => {
  const { status, result } = await analyzeThroughRoute({
    autoSend: true,
    aiResult: {
      intent: 'RETURNING_CUSTOMER_FOLLOWUP',
      action: 'SUGGEST_SHORTCUT',
      bestShortcut: '/32',
      confidence: 0.95
    },
    body: {
      customerMessage: 'chị mua tiếp 2 hộp',
      currentTags: ['Nhãn Saruto VIP'],
      conversationHistory: [{ from: 'customer', text: 'chị mua tiếp 2 hộp' }]
    }
  });

  assert.equal(status, 200);
  assert.equal(result.action, 'TAG_BUY_AND_MARK_UNREAD');
  assert.equal(result.bestShortcut, null);
  assert.equal(result.shouldSend, false);
  assert.equal(result.repurchase.evidence, 'explicit_rule');
});

test('route with auto-send keeps plain da nhan returning customers on /32 when AI suggests /17', async () => {
  const { status, result } = await analyzeThroughRoute({
    autoSend: true,
    shortcutItems: shortcutsWithContactRequests,
    aiResult: {
      intent: 'BUY_INTENT_LOW',
      action: 'SUGGEST_SHORTCUT',
      bestShortcut: '/17',
      confidence: 0.95,
      reason: 'mock contact request'
    },
    body: {
      customerMessage: '\u0063\u0068\u1ecb \u0111ang d\u00f9ng th\u1eed',
      currentTags: ['\u0110\u00e3 Nh\u1eadn'],
      conversationHistory: [{ from: 'customer', text: '\u0063\u0068\u1ecb \u0111ang d\u00f9ng th\u1eed' }]
    }
  });

  assert.equal(status, 200);
  assert.equal(result.intent, 'RETURNING_CUSTOMER_FOLLOWUP');
  assert.equal(result.action, 'SUGGEST_SHORTCUT');
  assert.equal(result.bestShortcut, '/32');
  assert.notEqual(result.bestShortcut, '/17');
  assert.equal(result.shouldSend, true);
});

test('short confirmations without a preceding admin offer skip the AI gate', async () => {
  let aiCalls = 0;
  global.fetch = async () => {
    aiCalls += 1;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          intent: 'REPURCHASE_INTENT',
          action: 'TAG_BUY_AND_MARK_UNREAD',
          confidence: 0.9
        }) } }]
      })
    };
  };

  const messages = ['ok', 'ok em', 'oke', 'oki', 'ok em g\u1eedi \u0111i', 'em gui di'];
  for (const message of messages) {
    const result = await analyze({
      customerMessage: message,
      history: [{ from: 'customer', text: message }]
    });
    assert.equal(result.action, 'TAG_BUY_AND_MARK_UNREAD', message);
  }
  assert.equal(aiCalls, 0);
});

test('courtesy plus an explicit quantity purchase uses the server rule', async () => {
  global.fetch = async () => { throw new Error('AI must not be called'); };
  const result = await analyze({ customerMessage: 'cảm ơn shop, cho chị 2 hộp' });

  assert.equal(result.action, 'TAG_BUY_AND_MARK_UNREAD');
  assert.equal(result.repurchase.evidence, 'explicit_rule');
});

test('AI-confirmed safe non-purchase selects configured /32', async () => {
  mockAI({ intent: 'RETURNING_CUSTOMER_FOLLOWUP', action: 'SUGGEST_SHORTCUT', bestShortcut: '/32', confidence: 0.9 });
  const result = await analyze({ settings: { autoSend: true } });

  assert.equal(result.intent, 'RETURNING_CUSTOMER_FOLLOWUP');
  assert.equal(result.action, 'SUGGEST_SHORTCUT');
  assert.equal(result.bestShortcut, '/32');
  assert.equal(result.confidence, 0.9);
  assert.equal(result.shouldSend, false);
  assert.equal(result.shouldEscalate, false);
});

test('actual server response follows Auto-send for AI-confirmed /32', async () => {
  const body = {
    customerMessage: 'chị dùng sản phẩm thế nào',
    currentTags: ['Đã Nhận Trả 01'],
    conversationHistory: [{ from: 'customer', text: 'chị dùng sản phẩm thế nào' }]
  };

  const aiResult = { intent: 'RETURNING_CUSTOMER_FOLLOWUP', action: 'SUGGEST_SHORTCUT', bestShortcut: '/32', confidence: 0.9 };
  const enabled = await analyzeThroughRoute({ autoSend: true, body, aiResult });
  const disabled = await analyzeThroughRoute({ autoSend: false, body, aiResult });

  assert.equal(enabled.status, 200);
  assert.equal(enabled.result.bestShortcut, '/32');
  assert.equal(enabled.result.shouldSend, true);
  assert.equal(disabled.status, 200);
  assert.equal(disabled.result.bestShortcut, '/32');
  assert.equal(disabled.result.shouldSend, false);
});

test('eligible policy with missing /32 skips instead of entering review', async () => {
  mockAI({ intent: 'RETURNING_CUSTOMER_FOLLOWUP', action: 'SUGGEST_SHORTCUT', bestShortcut: '/32', confidence: 0.95 });
  const result = await analyze({ shortcuts: [{ shortcut: '/1', topic: 'Khách mới' }] });

  assert.equal(result.bestShortcut, null);
  assert.match(result.action, /^(SKIP|WAITING_REVIEW)$/);
  assert.equal(result.shouldSend, false);
});

test('AI failure falls back to /32 without escalation', async () => {
  mockAI('not json');
  const result = await analyze({ customerMessage: 'chị đang xem lại sản phẩm' });

  assert.equal(result.action, 'SUGGEST_SHORTCUT');
  assert.equal(result.bestShortcut, '/32');
});

test('low-confidence AI safe follow-up still uses /32', async () => {
  mockAI({ intent: 'RETURNING_CUSTOMER_FOLLOWUP', action: 'SUGGEST_SHORTCUT', bestShortcut: '/32', confidence: 0.4 });
  const result = await analyze({ customerMessage: '\u0063\u0068\u1ecb \u0111ang d\u00f9ng th\u1eed' });

  assert.equal(result.action, 'SUGGEST_SHORTCUT');
  assert.equal(result.bestShortcut, '/32');
});

test('complaint, refusal, non-text, and contact safety take precedence for eligible tags', async () => {
  global.fetch = async () => { throw new Error('AI must not be called'); };
  const complaint = await analyze({ customerMessage: 'chị khiếu nại hàng sai' });
  const refusal = await analyze({ customerMessage: 'chị không mua thêm đâu' });
  const nonText = await analyze({ customerMessage: 'sent a sticker' });
  const contact = await analyze({ customerMessage: 'sđt 0912345678' });

  assert.equal(complaint.intent, 'COMPLAINT');
  assert.equal(complaint.action, 'SKIP');
  assert.equal(refusal.intent, 'REFUSAL');
  assert.match(refusal.action, /^(SKIP|WAITING_REVIEW)$/);
  assert.equal(nonText.intent, 'NON_TEXT');
  assert.equal(nonText.action, 'SKIP');
  assert.equal(contact.intent, 'PHONE_DETECTED');
  assert.equal(contact.action, 'SKIP');
  assert.equal(Object.hasOwn(contact, 'repurchase'), false);
});

test('a stale history confirmation cannot override the current refusal', async () => {
  global.fetch = async () => { throw new Error('AI must not be called'); };
  const result = await analyze({
    customerMessage: 'chị không mua nữa',
    history: [{ from: 'customer', text: 'ok em' }]
  });

  assert.equal(result.intent, 'REFUSAL');
  assert.equal(result.action, 'SKIP');
  assert.equal(Object.hasOwn(result, 'repurchase'), false);
});

test('noneligible customers retain the existing general AI behavior', async () => {
  mockAI({
    intent: 'GREETING',
    action: 'SUGGEST_SHORTCUT',
    bestShortcut: '/1',
    confidence: 0.82,
    reason: 'Lời chào',
    shouldEscalate: false
  });
  const result = await analyze({
    customerMessage: 'xin chào shop',
    context: { currentTags: ['Khách mới'] }
  });

  assert.equal(result.intent, 'GREETING');
  assert.equal(result.action, 'SUGGEST_SHORTCUT');
  assert.equal(result.bestShortcut, '/1');
  assert.equal(Object.hasOwn(result, 'repurchase'), false);
});

test('noneligible customers can still use configured contact-request shortcuts', async () => {
  mockAI({
    intent: 'BUY_INTENT_LOW',
    action: 'SUGGEST_SHORTCUT',
    bestShortcut: '/17',
    confidence: 0.9,
    reason: 'general flow contact request',
    shouldEscalate: false
  });
  const result = await analyze({
    customerMessage: '\u0063\u0068\u1ecb mu\u1ed1n mua nh\u01b0ng ch\u01b0a g\u1eedi \u0111\u1ecba ch\u1ec9',
    shortcuts: shortcutsWithContactRequests,
    context: { currentTags: ['Khach moi'] }
  });

  assert.equal(result.intent, 'BUY_INTENT_LOW');
  assert.equal(result.action, 'SUGGEST_SHORTCUT');
  assert.equal(result.bestShortcut, '/17');
  assert.equal(Object.hasOwn(result, 'repurchase'), false);
});

test('phone-only contact requests missing address without buy escalation', async () => {
  global.fetch = async () => { throw new Error('AI must not be called'); };
  const result = await analyze({
    customerMessage: 'sđt 0912345678',
    shortcuts: shortcutsWithContactRequests,
    context: { currentTags: ['Khách mới'] }
  });

  assert.equal(result.intent, 'PHONE_DETECTED');
  assert.equal(result.action, 'SUGGEST_SHORTCUT');
  assert.equal(result.bestShortcut, '/18');
  assert.equal(result.shouldEscalate, false);
  assert.equal(Object.hasOwn(result, 'repurchase'), false);
});

test('server rejects AI buy action for store location questions', async () => {
  mockAI({
    intent: 'BUY_INTENT_HIGH',
    action: 'TAG_BUY_AND_MARK_UNREAD',
    bestShortcut: null,
    confidence: 1,
    reason: 'learned example says buy',
    shouldEscalate: true
  });
  const result = await analyze({
    customerMessage: 'xin địa chỉ nhà thuốc',
    shortcuts: shortcutsWithContactRequests,
    context: { currentTags: ['Khách mới'] }
  });

  assert.equal(result.intent, 'STORE_LOCATION_QUESTION');
  assert.equal(result.action, 'SUGGEST_SHORTCUT');
  assert.equal(result.bestShortcut, '/10');
  assert.equal(result.shouldEscalate, false);
});

test('server does not expose an AI shortcut when AI action requests review', async () => {
  mockAI({
    intent: 'GREETING',
    action: 'WAITING_REVIEW',
    bestShortcut: '/1',
    confidence: 0.99,
    reason: 'review required',
    shouldEscalate: false
  });
  const result = await analyze({
    customerMessage: 'xin chào shop',
    context: { currentTags: ['Khách mới'] }
  });

  assert.equal(result.action, 'WAITING_REVIEW');
  assert.equal(result.bestShortcut, null);
  assert.equal(result.shouldEscalate, true);
});

test('non-text skip remains unchanged for customers without returning-customer tags', async () => {
  global.fetch = async () => { throw new Error('AI must not be called'); };
  const result = await analyze({
    customerMessage: 'sent a sticker',
    context: { currentTags: ['Khach moi'] }
  });

  assert.equal(result.intent, 'NON_TEXT');
  assert.equal(result.action, 'SKIP');
  assert.equal(result.shouldEscalate, false);
});

test('AI prompt bounds customer tags before serializing context', () => {
  const longTag = `Nhan Saruto ${'x'.repeat(MAX_CUSTOMER_TAG_LENGTH * 2)}`;
  const currentTags = [
    longTag,
    ...Array.from({ length: MAX_CUSTOMER_TAGS - 1 }, (_, index) => `Tag ${index}`),
    'INJECTION_SHOULD_NOT_REACH_PROMPT'
  ];
  const prompt = buildPrompt('xin chao', shortcuts, { currentTags, source: 'test' });

  assert.match(prompt, new RegExp(sanitizeCustomerTags([longTag])[0]));
  assert.doesNotMatch(prompt, /INJECTION_SHOULD_NOT_REACH_PROMPT/);
  assert.doesNotMatch(prompt, new RegExp(`x{${MAX_CUSTOMER_TAG_LENGTH + 1}}`));
});

test('returning-customer prompt defines the constrained matrix and forbids invented shortcuts', () => {
  const prompt = buildPrompt('ok em', shortcuts, { currentTags: ['Đã Nhận Trả 01'] }, [], [
    { from: 'admin', text: 'chị lấy thêm không' },
    { from: 'customer', text: 'ok em' }
  ]);
  assert.match(prompt, /server has already handled explicit repeat-purchase/i);
  assert.match(prompt, /Do not return REPURCHASE_INTENT/i);
  assert.match(prompt, /RETURNING_CUSTOMER_FOLLOWUP/);
  assert.doesNotMatch(prompt, /INTENT hợp lệ:[^\n]*REPURCHASE_INTENT/);
  assert.match(prompt, /\/32/);
  assert.match(prompt, /không (?:được )?bịa shortcut/i);
});

test('AI prompt includes the current message and only the five most recent history items', () => {
  const history = Array.from({ length: 7 }, (_, index) => ({
    from: index % 2 ? 'admin' : 'customer',
    text: `history-marker-${index}`
  }));
  const prompt = buildPrompt('ok em gửi đi', shortcuts, { currentTags: ['Nhận Saruto VIP'] }, [], history);

  assert.match(prompt, /ok em gửi đi/);
  assert.doesNotMatch(prompt, /history-marker-0|history-marker-1/);
  for (let index = 2; index < 7; index += 1) {
    assert.match(prompt, new RegExp(`history-marker-${index}`));
  }
});

test('noneligible customer prompt keeps the original intent surface', () => {
  const prompt = buildPrompt('xin chào', shortcuts, { currentTags: ['Khách mới'] });

  assert.doesNotMatch(prompt, /CHÍNH SÁCH KHÁCH CŨ/);
  assert.doesNotMatch(prompt, /REPURCHASE_INTENT|RETURNING_CUSTOMER_FOLLOWUP/);
});
