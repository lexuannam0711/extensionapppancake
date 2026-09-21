const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTelegramBot,
  parseAllowedChatIds,
  formatHelpMessage,
  formatReviewCaseMessage,
  formatComplaintAlertMessage,
  formatSystemAlertMessage
} = require('../src/server/telegram');

function createApiMock() {
  const calls = [];
  return {
    calls,
    requestApi: async (method, params) => {
      calls.push({ method, params });
      if (method === 'getUpdates') return { ok: true, result: [] };
      return { ok: true, result: { message_id: calls.length } };
    }
  };
}

test('telegram: parses and normalizes chat whitelist without exposing secrets', () => {
  assert.deepEqual(parseAllowedChatIds('123, -456,123'), ['123', '-456']);
  assert.deepEqual(parseAllowedChatIds(['123', -456, '', null]), ['123', '-456']);
  assert.deepEqual(parseAllowedChatIds(undefined), []);
});

test('telegram: formats operator help and alert messages with escaped input', () => {
  assert.match(formatHelpMessage(), /\/start_bot/);
  assert.match(formatReviewCaseMessage({ id: 'rv-1', customerName: '<A>', message: 'x & y' }), /&lt;A&gt;/);
  assert.match(formatComplaintAlertMessage({ customerName: '<A>', message: 'x & y' }), /x &amp; y/);
  assert.match(formatSystemAlertMessage({ level: 'ERROR', message: '<boom>' }), /&lt;boom&gt;/);
});

test('telegram: rejects unauthorized commands and accepts whitelisted commands', async () => {
  const api = createApiMock();
  const events = [];
  const bot = createTelegramBot({
    token: 'test-token',
    chatId: '100',
    requestApi: api.requestApi,
    getStatus: async () => ({ running: true, autoSend: false }),
    setAutoSend: async (enabled) => events.push({ type: 'autosend', enabled })
  });

  const denied = await bot.handleUpdate({ update_id: 1, message: { chat: { id: 999 }, text: '/status' } });
  assert.equal(denied.handled, false);
  assert.equal(denied.reason, 'unauthorized_chat');
  assert.equal(api.calls.length, 0);

  const accepted = await bot.handleUpdate({ update_id: 2, message: { chat: { id: 100 }, text: '/autosend on' } });
  assert.equal(accepted.handled, true);
  assert.deepEqual(events, [{ type: 'autosend', enabled: true }]);
  assert.equal(api.calls.at(-1).method, 'sendMessage');
  assert.equal(api.calls.at(-1).params.chat_id, '100');
});

test('telegram: dispatches all control commands through injected callbacks', async () => {
  const api = createApiMock();
  const events = [];
  const bot = createTelegramBot({
    token: 'test-token',
    chatId: '100',
    requestApi: api.requestApi,
    getStatus: async () => ({ running: false, autoSend: true }),
    startBot: async () => events.push('start'),
    stopBot: async () => events.push('stop'),
    setAutoSend: async (enabled) => events.push(`autosend:${enabled}`),
    getDailyReport: async () => 'DAILY REPORT'
  });

  for (const text of ['/help', '/status', '/start_bot', '/stop_bot', '/autosend off', '/baocao']) {
    const result = await bot.handleUpdate({ message: { chat: { id: '100' }, text } });
    assert.equal(result.handled, true, text);
  }

  assert.deepEqual(events, ['start', 'stop', 'autosend:false']);
  const sent = api.calls.filter((call) => call.method === 'sendMessage').map((call) => call.params.text);
  assert.equal(sent.some((text) => text.includes('DAILY REPORT')), true);
  assert.equal(sent.some((text) => text.includes('/start_bot')), true);
});

test('telegram: handles review callbacks and acknowledges every callback', async () => {
  const api = createApiMock();
  const events = [];
  const bot = createTelegramBot({
    token: 'test-token',
    chatId: '100',
    requestApi: api.requestApi,
    reviewCallbacks: {
      send: async (payload) => { events.push({ action: 'send', payload }); return true; },
      done: async (payload) => { events.push({ action: 'done', payload }); return true; },
      del: async (payload) => { events.push({ action: 'del', payload }); return true; }
    }
  });

  for (const [action, expected] of [['send', 'send'], ['done', 'done'], ['del', 'del']]) {
    const result = await bot.handleUpdate({
      callback_query: {
        id: `callback-${action}`,
        data: `rv:${action}:review-1`,
        message: { chat: { id: '100' }, message_id: 22 }
      }
    });
    assert.equal(result.handled, true);
    assert.equal(result.action, expected);
  }

  assert.deepEqual(events.map((event) => event.action), ['send', 'done', 'del']);
  assert.equal(api.calls.filter((call) => call.method === 'answerCallbackQuery').length, 3);
  assert.equal(api.calls.filter((call) => call.method === 'editMessageText').length, 3);
  assert.match(api.calls.find((call) => call.method === 'editMessageText').params.text, /Đã xử lý/);
  assert.equal(events[0].payload.reviewCaseId, 'review-1');
  assert.equal(events[0].payload.callbackQuery.id, 'callback-send');
  assert.equal(events[0].payload.update.callback_query.data, 'rv:send:review-1');
});

test('telegram: notifyReviewCase uses whitelisted chat and callback buttons', async () => {
  const api = createApiMock();
  const bot = createTelegramBot({ token: 'test-token', chatId: '100', requestApi: api.requestApi });

  const result = await bot.notifyReviewCase({
    id: 'review-42',
    customerName: 'Customer',
    message: 'Please review'
  });

  assert.equal(result.ok, true);
  const call = api.calls.find((item) => item.method === 'sendMessage');
  assert.equal(call.params.chat_id, '100');
  assert.deepEqual(call.params.reply_markup.inline_keyboard[0].map((button) => button.callback_data), [
    'rv:send:review-42',
    'rv:done:review-42',
    'rv:del:review-42'
  ]);
});

test('telegram: complaint and system alerts use the configured target chat', async () => {
  const api = createApiMock();
  const bot = createTelegramBot({ token: 'test-token', chatId: '100', requestApi: api.requestApi });

  assert.equal((await bot.notifyComplaintAlert({ message: 'Complaint', pancakeUrl: 'https://pancake.vn/conversations/1' })).ok, true);
  assert.equal((await bot.notifySystemAlert({ level: 'WARN', message: 'System warning', pancakeUrl: 'https://pancake.vn/conversations/2' })).ok, true);

  const messages = api.calls.filter((item) => item.method === 'sendMessage');
  assert.equal(messages.length, 2);
  assert.equal(messages.every((item) => item.params.chat_id === '100'), true);
  assert.equal(messages.every((item) => item.params.reply_markup.inline_keyboard[0][0].text === 'Mở Pancake'), true);
});

test('telegram: polling advances offset, processes updates, and stops', async () => {
  const calls = [];
  let batches = [[
    { update_id: 10, message: { chat: { id: '100' }, text: '/help' } },
    { update_id: 11, message: { chat: { id: '100' }, text: '/status' } }
  ], []];
  const bot = createTelegramBot({
    token: 'test-token',
    chatId: '100',
    requestApi: async (method, params) => {
      calls.push({ method, params });
      if (method === 'getUpdates') return { ok: true, result: batches.shift() || [] };
      return { ok: true, result: {} };
    },
    pollIntervalMs: 1,
    longPollTimeoutSec: 0
  });

  assert.equal(await bot.pollOnce(), 2);
  assert.equal(await bot.pollOnce(), 0);
  const polls = calls.filter((call) => call.method === 'getUpdates');
  assert.equal(polls[0].params.offset, undefined);
  assert.equal(polls[1].params.offset, 12);

  assert.equal(bot.startPolling(), true);
  assert.equal(bot.isPolling(), true);
  await bot.stopPolling();
  assert.equal(bot.isPolling(), false);
});

test('telegram: missing configuration is a safe no-op', async () => {
  const calls = [];
  const bot = createTelegramBot({ requestApi: async (...args) => calls.push(args) });

  assert.equal(bot.isConfigured(), false);
  assert.equal(await bot.sendTelegram('hello'), false);
  assert.equal((await bot.notifyComplaintAlert({ message: 'complaint' })).ok, false);
  assert.equal(bot.startPolling(), false);
  assert.equal(calls.length, 0);
});
