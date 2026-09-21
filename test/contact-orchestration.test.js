const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PDBBotDecision = require('../src/renderer/botDecision');
const { analyzeMessageWithAI } = require('../src/server/ai');

const shortcuts = [
  { shortcut: '/1', topic: 'Khách mới', message: 'Xin chào' },
  { shortcut: '/17', topic: 'Xin số điện thoại', message: 'Cho shop xin số điện thoại nhận hàng' },
  { shortcut: '/18', topic: 'Xin địa chỉ', message: 'Cho shop xin địa chỉ nhận hàng đầy đủ' }
];

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

function createHarness(message) {
  const runtime = { tabId: 'bot1', lastCustomerMessage: '', lastAnalysis: null };
  const rowInfo = { id: 'conversation-1', name: 'Customer', snippet: message, hasTags: true, tags: ['Đã Nhận'] };
  const calls = [];
  const settings = {
    autoSend: false,
    minConfidence: 0.75,
    buyTagName: 'Mua hàng',
    newCustomerTagName: 'Khách mới',
    defaultNewCustomerShortcut: '/1'
  };

  async function botCallForTab(tabId, method, ...args) {
    calls.push({ type: 'bot', tabId, method, args });
    if (method === 'getUnreadConversations') return [rowInfo];
    if (method === 'clickConversationById') return { ok: true, info: rowInfo };
    if (method === 'getCurrentTags') return [...rowInfo.tags];
    if (method === 'getCurrentCustomerName') return 'Customer';
    if (method === 'getLastMessageSender') return 'customer';
    if (method === 'getRecentMessages') return [{ from: 'customer', text: message }];
    if (method === 'getCustomerOrderStatus') return null;
    if (method === 'applyTagByName') return { ok: true };
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
      PDBBuyTtsNotifier: { notifyBuyCustomer(payload) { calls.push({ type: 'tts', payload }); } }
    },
    activeWvTab: 'bot1',
    AbortSignal,
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
    enqueueReviewCase: async (payload) => calls.push({ type: 'queue', payload }),
    recordExample: async (...args) => calls.push({ type: 'recordExample', args }),
    api: async (route, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ type: 'api', route, body });
      if (route === '/api/ai/analyze-message') {
        return analyzeMessageWithAI({
          customerMessage: body.customerMessage,
          shortcuts,
          context: { currentTags: body.currentTags },
          settings: { minConfidence: 0.75 }
        });
      }
      if (route === '/api/notify/buy') return { telegramSent: true };
      if (route === '/api/address/lookup') return { lookup: null };
      if (route === '/api/review-queue') return { ok: true, item: { id: 'review-1' } };
      throw new Error(`Unexpected API route: ${route}`);
    }
  };

  return {
    calls,
    run: () => loadProcessOneConversation(context)(runtime),
    methods: () => calls.filter((call) => call.type === 'bot').map((call) => call.method)
  };
}

test('orchestration applies buy actions only for complete labeled contact', async () => {
  const harness = createHarness('số điện thoại 0912345678, địa chỉ xã Bình Minh huyện Thanh Oai tỉnh Thanh Hóa');
  const result = await harness.run();

  assert.equal(result.action, 'ESCALATED');
  assert.equal(harness.methods().includes('applyTagByName'), true);
  assert.equal(harness.methods().includes('markCurrentConversationUnread'), true);
  assert.equal(harness.calls.some((call) => call.route === '/api/notify/buy'), true);
});

test('orchestration skips unlabeled complete-looking contact without side effects', async () => {
  const harness = createHarness('0912345678, xã Bình Minh huyện Thanh Oai tỉnh Thanh Hóa');
  const result = await harness.run();

  assert.equal(result.action, 'SKIPPED_NO_ACTION');
  assert.equal(harness.methods().includes('applyTagByName'), false);
  assert.equal(harness.methods().includes('markCurrentConversationUnread'), false);
  assert.equal(harness.calls.some((call) => call.route === '/api/notify/buy'), false);
});
