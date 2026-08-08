const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PDBBotDecision = require('../src/renderer/botDecision');
const { analyzeMessageWithAI } = require('../src/server/ai');

const originalFetch = global.fetch;
const shortcuts = [
  { shortcut: '/1', topic: 'Khách mới', message: 'Xin chào' },
  { shortcut: '/32', topic: 'Chăm sóc khách cũ', message: 'Hướng dẫn khách đã mua' }
];

test.afterEach(() => {
  global.fetch = originalFetch;
});

function loadProcessOneConversation(context) {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const start = source.indexOf('async function processOneConversation');
  const end = source.indexOf('async function processOneAutoClick', start);
  if (start < 0 || end < 0) throw new Error('processOneConversation source not found');
  vm.runInNewContext(
    `${source.slice(start, end)}\nglobalThis.__processOneConversation = processOneConversation;`,
    context
  );
  return context.__processOneConversation;
}

function mockAI(result) {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ choices: [{ message: { content: JSON.stringify(result) } }] })
  });
}

function analyzeFromRendererPayload(body, settings) {
  return analyzeMessageWithAI({
    customerMessage: body.customerMessage,
    shortcuts,
    context: { currentTags: body.currentTags },
    settings: { aiApiKey: 'test-key', minConfidence: 0.75, ...settings },
    history: body.conversationHistory || []
  });
}

function createHarness(overrides = {}) {
  const runtime = { tabId: 'bot1', lastCustomerMessage: '', lastAnalysis: null };
  const message = overrides.message || 'customer message';
  const rowInfo = {
    id: 'conversation-1',
    name: 'Customer',
    snippet: message,
    hasTags: Boolean(overrides.rowTags?.length),
    tags: [...(overrides.rowTags || [])]
  };
  const calls = [];
  const senderQueue = [...(overrides.lastSenders || ['customer', 'customer'])];
  const settings = {
    autoSend: false,
    minConfidence: 0.75,
    buyTagName: 'Mua hàng',
    newCustomerTagName: 'Saruto Mới',
    defaultNewCustomerShortcut: '/1',
    ...(overrides.settings || {})
  };

  async function botCallForTab(tabId, method, ...args) {
    calls.push({ type: 'bot', tabId, method, args });
    if (method === 'getUnreadConversations') return [rowInfo];
    if (method === 'clickConversationById') return { ok: true, info: rowInfo };
    if (method === 'getCurrentTags') {
      if (overrides.currentTagsError) throw overrides.currentTagsError;
      return [...(overrides.currentTags || [])];
    }
    if (method === 'getCurrentCustomerName') return 'Customer';
    if (method === 'getLastMessageSender') return senderQueue.shift() || 'customer';
    if (method === 'getRecentMessages') return overrides.history || [{ from: 'customer', text: message }];
    if (method === 'getCustomerOrderStatus') return null;
    if (method === 'applyTagByName') return overrides.applyTagResult || { ok: true };
    if (method === 'markCurrentConversationUnread') return { ok: true };
    if (method === 'setReplyText') return { ok: true };
    if (method === 'clickSendButton') return { ok: true };
    throw new Error(`Unexpected bot method: ${method}`);
  }

  const coordinator = {
    async process(job) {
      calls.push({ type: 'coordinator', method: 'process', stage: job.stage });
      return { ...(await job.performAction()), deferred: true };
    },
    refreshDeferred() { return true; },
    completeDeferred(job, options) {
      calls.push({ type: 'coordinator', method: 'completeDeferred', options });
      return true;
    },
    async failDeferred(job, result) {
      calls.push({ type: 'coordinator', method: 'failDeferred', result });
      return { ok: false, ...result };
    }
  };

  const context = {
    window: {
      PDBBotDecision,
      PDBBuyTtsNotifier: {
        notifyBuyCustomer(payload) {
          calls.push({ type: 'tts', payload });
        }
      }
    },
    activeWvTab: 'bot1',
    settings,
    getActiveBotRuntime: () => runtime,
    botCallForTab,
    $: () => ({ textContent: '' }),
    makeDedupeKey: (info) => info.id,
    wasConversationProcessedAnywhere: () => false,
    createClickCoordinator: () => coordinator,
    sleep: async () => {},
    log: async (level, type, text, data) => calls.push({ type: 'log', level, logType: type, text, data }),
    prefixRuntime: (_runtime, text) => text,
    serializeError: (error) => String(error?.message || error),
    setActiveRuntimeMessages: () => {},
    setRuntimeLastDecision: (_runtime, action) => calls.push({ type: 'decision', action }),
    renderAnalysis: () => {},
    getDomHealthSafe: async () => ({ canTag: true, canMarkUnread: true, canTypeReply: true, canSend: true, missing: [] }),
    missingReason: () => '',
    enqueueReviewCase: async (item) => calls.push({ type: 'review', item }),
    recordExample: async (...args) => calls.push({ type: 'recordExample', args }),
    api: async (route, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ type: 'api', route, body });
      if (route === '/api/ai/analyze-message') return overrides.analysisFactory(body, settings);
      if (route === '/api/notify/buy') return { telegramSent: true };
      if (route === '/api/address/lookup') return { lookup: null };
      throw new Error(`Unexpected API route: ${route}`);
    }
  };

  return {
    runtime,
    calls,
    run: () => loadProcessOneConversation(context)(runtime),
    botMethods: () => calls.filter((call) => call.type === 'bot').map((call) => call.method)
  };
}

test('processOneConversation: active eligible tag plus repurchase applies buy tag, unread, notifications, and review', async () => {
  mockAI({
    intent: 'REPURCHASE_INTENT',
    action: 'TAG_BUY_AND_MARK_UNREAD',
    confidence: 0.9
  });
  const harness = createHarness({
    message: 'chị mua thêm 2 hộp',
    rowTags: ['Khách mới'],
    currentTags: ['Nhãn Saruto VIP'],
    settings: { autoSend: true },
    analysisFactory: async (body, settings) => ({
      ...(await analyzeFromRendererPayload(body, settings)),
      contactInfo: { phone: '0912345678', address: null }
    })
  });

  const result = await harness.run();
  const analyzeCall = harness.calls.find((call) => call.route === '/api/ai/analyze-message');
  const methods = harness.botMethods();

  assert.equal(result.action, 'ESCALATED');
  assert.deepEqual(analyzeCall.body.currentTags, ['Nhãn Saruto VIP']);
  assert.equal(analyzeCall.body.conversationHistory.length, 1);
  assert.equal(harness.calls.find((call) => call.method === 'getRecentMessages').args[0], 5);
  assert.ok(methods.indexOf('getCurrentTags') < methods.indexOf('getLastMessageSender'));
  assert.ok(methods.includes('applyTagByName'));
  assert.ok(methods.includes('markCurrentConversationUnread'));
  assert.equal(methods.includes('clickSendButton'), false);
  assert.ok(harness.calls.some((call) => call.type === 'tts'));
  assert.ok(harness.calls.some((call) => call.route === '/api/notify/buy'));
  assert.ok(harness.calls.some((call) => call.type === 'review'));
  assert.ok(harness.calls.some((call) => call.method === 'completeDeferred' && call.options.commit));
});

test('processOneConversation: safe /32 obeys Auto-send and the final sender guard', async () => {
  mockAI({
    intent: 'RETURNING_CUSTOMER_FOLLOWUP',
    action: 'SUGGEST_SHORTCUT',
    bestShortcut: '/32',
    confidence: 0.9,
    reason: 'Khách cũ hỏi cách dùng',
    shouldEscalate: false
  });
  const base = {
    message: 'chị dùng sản phẩm thế nào',
    currentTags: ['Đã Nhận Trả 01'],
    analysisFactory: analyzeFromRendererPayload
  };
  const fillOnly = createHarness({ ...base, settings: { autoSend: false } });
  const sent = createHarness({ ...base, settings: { autoSend: true } });
  const guarded = createHarness({ ...base, settings: { autoSend: true }, lastSenders: ['customer', 'admin'] });

  await fillOnly.run();
  await sent.run();
  const guardedResult = await guarded.run();

  assert.deepEqual(fillOnly.calls.find((call) => call.method === 'setReplyText').args, ['/32']);
  assert.equal(fillOnly.botMethods().includes('clickSendButton'), false);
  assert.deepEqual(sent.calls.find((call) => call.method === 'setReplyText').args, ['/32']);
  assert.equal(sent.botMethods().includes('clickSendButton'), true);
  assert.equal(guardedResult.action, 'SKIPPED_HUMAN_REPLY');
  assert.equal(guarded.botMethods().includes('clickSendButton'), false);
});

test('processOneConversation: inactive rendered tags use the normal new-customer path', async () => {
  const harness = createHarness({
    rowTags: ['Nhãn Saruto VIP'],
    currentTags: [],
    analysisFactory: () => { throw new Error('analysis must not run'); }
  });

  const result = await harness.run();

  assert.equal(result.action, 'NEW_CUSTOMER');
  assert.equal(harness.calls.some((call) => call.route === '/api/ai/analyze-message'), false);
  assert.deepEqual(harness.calls.find((call) => call.method === 'setReplyText').args, ['/1']);
  assert.equal(harness.botMethods().includes('clickSendButton'), true);
});

test('processOneConversation: sensitive eligible content skips without review or /32', async () => {
  const harness = createHarness({
    message: 'chị khiếu nại hàng sai',
    currentTags: ['Nhãn Saruto VIP'],
    settings: { autoSend: true },
    analysisFactory: analyzeFromRendererPayload
  });

  const result = await harness.run();

  assert.equal(result.action, 'SKIPPED_NON_TEXT');
  assert.equal(harness.botMethods().includes('setReplyText'), false);
  assert.equal(harness.botMethods().includes('clickSendButton'), false);
  assert.equal(harness.calls.some((call) => call.type === 'review'), false);
});

test('processOneConversation: already-active buy tag remains applied while unread still runs', async () => {
  mockAI({
    intent: 'REPURCHASE_INTENT',
    action: 'TAG_BUY_AND_MARK_UNREAD',
    confidence: 0.9
  });
  const harness = createHarness({
    message: 'chị mua thêm 2 hộp',
    currentTags: ['Nhãn Saruto VIP', 'Mua hàng'],
    applyTagResult: { ok: true, alreadyApplied: true },
    analysisFactory: analyzeFromRendererPayload
  });

  const result = await harness.run();

  assert.equal(result.action, 'ESCALATED');
  assert.deepEqual(harness.calls.find((call) => call.method === 'applyTagByName').args, ['Mua hàng']);
  assert.equal(harness.botMethods().includes('markCurrentConversationUnread'), true);
});
