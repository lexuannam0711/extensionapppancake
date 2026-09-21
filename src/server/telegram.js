const https = require('https');

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_MAX_CALLBACK_DATA_LENGTH = 64;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LONG_POLL_TIMEOUT_SEC = 20;
const REPORT_HOUR = 23;
const REPORT_MIN = 30;

function normalizeChatId(value) {
  const text = String(value == null ? '' : value).trim();
  return text || '';
}

function parseAllowedChatIds(value) {
  const values = Array.isArray(value) ? value : [value];
  return Array.from(new Set(values.flatMap((item) => {
    if (Array.isArray(item)) return parseAllowedChatIds(item);
    return String(item == null ? '' : item)
      .split(',')
      .map(normalizeChatId)
      .filter(Boolean);
  })));
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncateText(value, maxLength = TELEGRAM_MAX_MESSAGE_LENGTH) {
  const text = String(value == null ? '' : value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function normalizeApiResponse(response) {
  if (response && typeof response.ok === 'boolean') return response;
  return { ok: true, result: response };
}

function createHttpsRequestApi(token, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : 10000;

  return (method, params = {}) => new Promise((resolve) => {
    const payload = JSON.stringify(params || {});
    const request = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: timeoutMs
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); } catch (_) { parsed = null; }
        if (parsed && typeof parsed.ok === 'boolean') return resolve(parsed);
        resolve({ ok: false, error_code: response.statusCode || 502, description: 'Telegram returned an invalid response' });
      });
    });
    request.on('error', () => resolve({ ok: false, error_code: 502, description: 'Telegram request failed' }));
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false, error_code: 504, description: 'Telegram request timed out' });
    });
    request.write(payload);
    request.end();
  });
}

function formatHelpMessage() {
  return [
    '<b>Pancake Desktop Bot</b>',
    '/status - xem trạng thái bot',
    '/start_bot - bật bot',
    '/stop_bot - tắt bot',
    '/autosend on|off - bật/tắt tự gửi',
    '/baocao - xem báo cáo trong ngày'
  ].join('\n');
}

function formatStatusMessage(status) {
  if (typeof status === 'string') return truncateText(status);
  const value = status && typeof status === 'object' ? status : {};
  const running = value.running ?? value.botRunning;
  const autoSend = value.autoSend;
  const lines = ['<b>Trạng thái hệ thống</b>'];
  if (running !== undefined) lines.push(`Bot: <b>${running ? 'đang chạy' : 'đã dừng'}</b>`);
  if (autoSend !== undefined) lines.push(`Auto-send: <b>${autoSend ? 'bật' : 'tắt'}</b>`);
  if (value.version) lines.push(`Phiên bản: ${escapeHtml(value.version)}`);
  if (value.message) lines.push(escapeHtml(value.message));
  return lines.length > 1 ? lines.join('\n') : '<b>Trạng thái hệ thống</b> chưa được cấu hình.';
}

function formatReviewCaseMessage(reviewCase = {}) {
  const id = reviewCase.id || reviewCase.reviewCaseId || reviewCase.conversationId || '';
  return truncateText([
    '<b>Case cần xử lý</b>',
    id ? `ID: <code>${escapeHtml(id)}</code>` : '',
    reviewCase.customerName ? `Khách: ${escapeHtml(reviewCase.customerName)}` : '',
    reviewCase.phone ? `SĐT: ${escapeHtml(reviewCase.phone)}` : '',
    reviewCase.address ? `Địa chỉ: ${escapeHtml(reviewCase.address)}` : '',
    reviewCase.message ? `Tin nhắn: ${escapeHtml(reviewCase.message)}` : '',
    reviewCase.reason ? `Lý do: ${escapeHtml(reviewCase.reason)}` : ''
  ].filter(Boolean).join('\n'));
}

function formatComplaintAlertMessage(alert = {}) {
  return truncateText([
    '<b>Cảnh báo khiếu nại</b>',
    alert.customerName ? `Khách: ${escapeHtml(alert.customerName)}` : '',
    alert.conversationId ? `Cuộc trò chuyện: <code>${escapeHtml(alert.conversationId)}</code>` : '',
    alert.message ? escapeHtml(alert.message) : '',
    alert.reason ? `Lý do: ${escapeHtml(alert.reason)}` : ''
  ].filter(Boolean).join('\n'));
}

function formatSystemAlertMessage(alert = {}) {
  const level = String(alert.level || 'INFO').toUpperCase();
  return truncateText([
    `<b>Cảnh báo hệ thống [${escapeHtml(level)}]</b>`,
    alert.context ? `Context: ${escapeHtml(alert.context)}` : '',
    alert.message ? escapeHtml(alert.message) : ''
  ].filter(Boolean).join('\n'));
}

function formatBuyCustomerMessage({ customerName, phone, address, message, addressLookup } = {}) {
  return [
    '🛒 <b>Khách MUA HÀNG</b>',
    `👤 ${escapeHtml(customerName || 'Khách')}`,
    phone ? `📞 ${escapeHtml(phone)}` : '',
    address ? `📍 ${escapeHtml(address)}` : '',
    addressLookup?.googleMapsUrl ? `🔎 Google Maps: ${escapeHtml(addressLookup.googleMapsUrl)}` : '',
    addressLookup?.confidence ? `⚠️ Độ chắc chắn: ${escapeHtml(addressLookup.confidence)}` : '',
    message ? `💬 ${escapeHtml(message)}` : ''
  ].filter(Boolean).join('\n');
}

function buildAlertKeyboard(alert = {}) {
  const url = String(alert.pancakeUrl || '');
  return /^https:\/\//i.test(url) ? { inline_keyboard: [[{ text: 'Mở Pancake', url }]] } : undefined;
}

function formatCallbackData(action, id) {
  const value = id == null ? '' : String(id);
  const data = value ? `rv:${action}:${value}` : `rv:${action}`;
  return data.length <= TELEGRAM_MAX_CALLBACK_DATA_LENGTH ? data : '';
}

function buildReviewKeyboard(reviewCase = {}) {
  const id = reviewCase.id || reviewCase.reviewCaseId || reviewCase.conversationId;
  const buttons = ['send', 'done', 'del']
    .map((action) => ({
      text: action === 'send' ? 'Gửi' : action === 'done' ? 'Xong' : 'Xóa',
      callback_data: formatCallbackData(action, id)
    }))
    .filter((button) => button.callback_data);
  const rows = buttons.length ? [buttons] : [];
  if (/^https:\/\//i.test(String(reviewCase.pancakeUrl || ''))) {
    rows.push([{ text: 'Mở Pancake', url: String(reviewCase.pancakeUrl) }]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

function msUntilNextReport(now = new Date()) {
  const next = new Date(now);
  next.setHours(REPORT_HOUR, REPORT_MIN, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function buildDailyStats(logs, now = new Date()) {
  const y = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const dateStr = `${y}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const sameLocalDay = (iso) => {
    const time = new Date(iso);
    return !Number.isNaN(time.getTime())
      && time.getFullYear() === y
      && time.getMonth() === month
      && time.getDate() === day;
  };
  const today = (Array.isArray(logs) ? logs : []).filter((item) => item && sameLocalDay(item.time));
  const stats = { dateStr, newCustomers: 0, buyOrders: 0, errors: 0, shortcutsSent: 0 };
  for (const log of today) {
    const type = log.type || '';
    const level = log.level || '';
    const message = String(log.message || '');
    if (level === 'ERROR') stats.errors++;
    if (type === 'BOT' && message.startsWith('Khách mới')) stats.newCustomers++;
    if (type === 'BOT' && message.startsWith('Khách mua hàng')) stats.buyOrders++;
    if (type === 'BOT' && /^Đã gửi \/\d+/.test(message)) stats.shortcutsSent++;
  }
  return stats;
}

function formatDailyReport(stats = {}) {
  return [
    `<b>Báo cáo cuối ngày ${escapeHtml(stats.dateStr || '')}</b>`,
    `Khách mới: <b>${Number(stats.newCustomers) || 0}</b>`,
    `Đơn mua: <b>${Number(stats.buyOrders) || 0}</b>`,
    `Shortcut đã gửi: <b>${Number(stats.shortcutsSent) || 0}</b>`,
    `Lỗi: <b>${Number(stats.errors) || 0}</b>`
  ].join('\n');
}

function createTelegramBot(options = {}) {
  const token = String(options.token ?? process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  const configuredChatId = normalizeChatId(options.chatId ?? process.env.TELEGRAM_CHAT_ID);
  const allowedChatIds = new Set(parseAllowedChatIds([
    configuredChatId,
    options.allowedChatIds ?? process.env.TELEGRAM_ALLOWED_CHAT_IDS
  ]));
  const targetChatId = configuredChatId || Array.from(allowedChatIds)[0] || '';
  const requestApi = options.requestApi || createHttpsRequestApi(token, options);
  const setTimeoutFn = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn = options.clearTimeout || ((id) => clearTimeout(id));
  const pollIntervalMs = Number.isFinite(Number(options.pollIntervalMs)) ? Math.max(0, Number(options.pollIntervalMs)) : DEFAULT_POLL_INTERVAL_MS;
  const longPollTimeoutSec = Number.isFinite(Number(options.longPollTimeoutSec)) ? Math.max(0, Number(options.longPollTimeoutSec)) : DEFAULT_LONG_POLL_TIMEOUT_SEC;
  const commandHandlers = options.commandHandlers || {};
  const reviewCallbacks = options.reviewCallbacks || {};
  let nextOffset = Number.isInteger(options.offset) ? options.offset : undefined;
  let polling = false;
  let pollingPromise = null;
  let delayTimer = null;

  function isConfigured() {
    return Boolean(token && allowedChatIds.size);
  }

  function isAllowedChatId(chatId) {
    return allowedChatIds.has(normalizeChatId(chatId));
  }

  async function callApi(method, params = {}) {
    if (!token) return { ok: false, error_code: 0, description: 'Telegram bot token is not configured' };
    try {
      return normalizeApiResponse(await requestApi(method, params));
    } catch (_) {
      return { ok: false, error_code: 502, description: 'Telegram request failed' };
    }
  }

  async function sendMessage(chatId, text, extra = {}) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!isConfigured() || !isAllowedChatId(normalizedChatId)) {
      return { ok: false, error_code: 403, description: 'Telegram chat is not allowed' };
    }
    return callApi('sendMessage', {
      chat_id: normalizedChatId,
      text: truncateText(text),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra
    });
  }

  async function sendTelegram(text) {
    const response = await sendMessage(targetChatId, text);
    return Boolean(response.ok);
  }

  async function notifyReviewCase(reviewCase = {}) {
    return sendMessage(targetChatId, formatReviewCaseMessage(reviewCase), { reply_markup: buildReviewKeyboard(reviewCase) });
  }

  async function notifyComplaintAlert(alert = {}) {
    return sendMessage(targetChatId, formatComplaintAlertMessage(alert), { reply_markup: buildAlertKeyboard(alert) });
  }

  async function notifySystemAlert(alert = {}) {
    return sendMessage(targetChatId, formatSystemAlertMessage(alert), { reply_markup: buildAlertKeyboard(alert) });
  }

  async function notifyBuyCustomer(payload = {}) {
    return sendTelegram(formatBuyCustomerMessage(payload));
  }

  async function notifyError(context, message) {
    return sendTelegram(`⚠️ <b>Lỗi server</b>\n${escapeHtml(context)}: ${escapeHtml(message)}`);
  }

  async function invokeHandler(name, payload, ...rest) {
    const handler = commandHandlers[name] || options[name];
    if (typeof handler !== 'function') return undefined;
    return handler(payload, ...rest);
  }

  async function reply(chatId, text) {
    return sendMessage(chatId, text);
  }

  async function handleCommand(message) {
    const text = String(message?.text || '').trim();
    const match = text.match(/^\/([a-z_]+)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i);
    if (!match) return { handled: false, reason: 'not_a_command' };
    const command = match[1].toLowerCase();
    const argument = String(match[2] || '').trim();
    const context = { message, command, argument, chatId: normalizeChatId(message.chat.id) };

    if (command === 'help') {
      await reply(context.chatId, formatHelpMessage());
      return { handled: true, command };
    }
    if (command === 'status') {
      const status = await invokeHandler('getStatus', context);
      await reply(context.chatId, formatStatusMessage(status));
      return { handled: true, command, status };
    }
    if (command === 'start_bot' || command === 'stop_bot') {
      const name = command === 'start_bot' ? 'startBot' : 'stopBot';
      const result = await invokeHandler(name, context);
      await reply(context.chatId, result?.message || (command === 'start_bot' ? 'Bot đã bật.' : 'Bot đã tắt.'));
      return { handled: true, command, result };
    }
    if (command === 'autosend') {
      const value = argument.toLowerCase();
      const enabled = ['on', '1', 'true', 'bật', 'bat'].includes(value)
        ? true
        : ['off', '0', 'false', 'tắt', 'tat'].includes(value)
          ? false
          : undefined;
      if (enabled === undefined) {
        await reply(context.chatId, 'Dùng: /autosend on hoặc /autosend off');
        return { handled: true, command, valid: false };
      }
      const result = await invokeHandler('setAutoSend', enabled, context);
      await reply(context.chatId, result?.message || `Auto-send đã ${enabled ? 'bật' : 'tắt'}.`);
      return { handled: true, command, enabled, result };
    }
    if (command === 'baocao') {
      const report = await invokeHandler('getDailyReport', context);
      await reply(context.chatId, typeof report === 'string' ? report : formatDailyReport(report));
      return { handled: true, command, report };
    }
    await reply(context.chatId, 'Lệnh không hợp lệ. Dùng /help để xem danh sách lệnh.');
    return { handled: true, command, valid: false };
  }

  async function handleCallbackQuery(callbackQuery, update) {
    const chatId = callbackQuery?.message?.chat?.id;
    if (!isAllowedChatId(chatId)) return { handled: false, reason: 'unauthorized_chat' };
    const data = String(callbackQuery?.data || '');
    const match = data.match(/^rv:(send|done|del)(?::([^:]+))?$/i);
    if (!match) {
      await callApi('answerCallbackQuery', { callback_query_id: callbackQuery?.id, text: 'Callback không hợp lệ.' });
      return { handled: false, reason: 'unknown_callback' };
    }
    const action = match[1].toLowerCase();
    const reviewCaseId = match[2] || '';
    await callApi('answerCallbackQuery', { callback_query_id: callbackQuery?.id, text: 'Đã nhận.' });
    const handler = reviewCallbacks[action];
    if (typeof handler !== 'function') {
      await reply(normalizeChatId(chatId), 'Chức năng xử lý case chưa được cấu hình.');
      return { handled: true, action, reviewCaseId, configured: false };
    }
    const result = await handler({ reviewCaseId, callbackQuery, update });
    const message = callbackQuery.message;
    if (message?.message_id) {
      const ok = result === true || result?.ok === true;
      const status = ok ? '✅ Đã xử lý' : '⚠️ Chưa xử lý được';
      await callApi('editMessageText', {
        chat_id: normalizeChatId(chatId),
        message_id: message.message_id,
        text: truncateText(`${message.text || formatReviewCaseMessage({ reviewCaseId })}\n\n<b>${status}</b>`),
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
    }
    return { handled: true, action, reviewCaseId, result };
  }

  async function handleUpdate(update = {}) {
    const message = update.message || update.edited_message;
    const callbackQuery = update.callback_query;
    const chatId = message?.chat?.id ?? callbackQuery?.message?.chat?.id;
    if (!isAllowedChatId(chatId)) return { handled: false, reason: 'unauthorized_chat' };
    if (callbackQuery) return handleCallbackQuery(callbackQuery, update);
    if (message?.text) return handleCommand(message);
    return { handled: false, reason: 'unsupported_update' };
  }

  async function pollOnce() {
    const params = { timeout: longPollTimeoutSec, allowed_updates: ['message', 'callback_query'] };
    if (nextOffset !== undefined) params.offset = nextOffset;
    const response = await callApi('getUpdates', params);
    if (!response.ok) throw new Error(response.description || 'Telegram polling failed');
    const updates = Array.isArray(response.result) ? response.result : [];
    for (const update of updates) {
      if (Number.isInteger(update?.update_id)) nextOffset = update.update_id + 1;
      try { await handleUpdate(update); } catch (error) {
        if (typeof options.onHandlerError === 'function') await options.onHandlerError(error, update);
      }
    }
    return updates.length;
  }

  function waitForPollInterval() {
    if (!polling || pollIntervalMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      delayTimer = setTimeoutFn(() => {
        delayTimer = null;
        resolve();
      }, pollIntervalMs);
    });
  }

  async function runPolling() {
    while (polling) {
      try { await pollOnce(); } catch (error) {
        if (typeof options.onPollingError === 'function') await options.onPollingError(error);
      }
      await waitForPollInterval();
    }
  }

  function startPolling() {
    if (!isConfigured()) return false;
    if (polling) return true;
    polling = true;
    pollingPromise = runPolling().finally(() => { pollingPromise = null; });
    return true;
  }

  async function stopPolling() {
    polling = false;
    if (delayTimer) {
      clearTimeoutFn(delayTimer);
      delayTimer = null;
    }
    if (pollingPromise) await pollingPromise;
    return true;
  }

  function scheduleDailyReport(getLogs) {
    if (!isConfigured()) return () => {};
    let timer = null;
    const arm = () => {
      timer = setTimeoutFn(async () => {
        try {
          const logs = await getLogs();
          await sendTelegram(formatDailyReport(buildDailyStats(logs)));
        } catch (_) { /* report is best-effort */ }
        arm();
      }, msUntilNextReport());
      if (timer && typeof timer.unref === 'function') timer.unref();
    };
    arm();
    return () => { if (timer) clearTimeoutFn(timer); };
  }

  return {
    isConfigured,
    isAllowedChatId,
    sendMessage,
    sendTelegram,
    notifyReviewCase,
    notifyComplaintAlert,
    notifySystemAlert,
    notifyBuyCustomer,
    notifyError,
    handleUpdate,
    handleCommand,
    handleCallbackQuery,
    pollOnce,
    startPolling,
    stopPolling,
    isPolling: () => polling,
    scheduleDailyReport,
    getAllowedChatIds: () => Array.from(allowedChatIds),
    getTargetChatId: () => targetChatId
  };
}

const defaultBot = createTelegramBot();

function isConfigured() { return defaultBot.isConfigured(); }
function sendTelegram(text) { return defaultBot.sendTelegram(text); }
function notifyServerUp(port) { return sendTelegram(`🟢 <b>Bot đã BẬT</b>\nServer chạy tại http://localhost:${escapeHtml(port)}`); }
function notifyServerDown() { return sendTelegram('🔴 <b>Bot đã TẮT</b>\nServer đã dừng.'); }
function notifyError(context, message) { return sendTelegram(`⚠️ <b>Lỗi server</b>\n${escapeHtml(context)}: ${escapeHtml(message)}`); }
function notifyBuyCustomer(payload) { return defaultBot.notifyBuyCustomer(payload); }
function notifyReviewCase(reviewCase) { return defaultBot.notifyReviewCase(reviewCase); }
function notifyComplaintAlert(alert) { return defaultBot.notifyComplaintAlert(alert); }
function notifySystemAlert(alert) { return defaultBot.notifySystemAlert(alert); }
function startPolling() { return defaultBot.startPolling(); }
function stopPolling() { return defaultBot.stopPolling(); }
function scheduleDailyReport(getLogs) { return defaultBot.scheduleDailyReport(getLogs); }

module.exports = {
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TELEGRAM_MAX_CALLBACK_DATA_LENGTH,
  parseAllowedChatIds,
  escapeHtml,
  formatHelpMessage,
  formatStatusMessage,
  formatReviewCaseMessage,
  formatComplaintAlertMessage,
  formatSystemAlertMessage,
  formatBuyCustomerMessage,
  buildAlertKeyboard,
  buildDailyStats,
  formatDailyReport,
  msUntilNextReport,
  createTelegramBot,
  isConfigured,
  sendTelegram,
  notifyServerUp,
  notifyServerDown,
  notifyError,
  notifyBuyCustomer,
  notifyReviewCase,
  notifyComplaintAlert,
  notifySystemAlert,
  startPolling,
  stopPolling,
  scheduleDailyReport
};
