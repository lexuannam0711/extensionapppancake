const https = require('https');

function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// Send a message to the configured Telegram chat. No-op (resolves false) when
// token/chat id are missing, so the app runs fine without Telegram set up.
// Never throws: notification failure must not break the calling flow.
function sendTelegram(text) {
  return new Promise((resolve) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return resolve(false);

    const payload = JSON.stringify({
      chat_id: chatId,
      text: String(text == null ? '' : text),
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 10000
      },
      (res) => {
        res.resume(); // drain
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(payload);
    req.end();
  });
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function notifyServerUp(port) {
  return sendTelegram(`🟢 <b>Bot đã BẬT</b>\nServer chạy tại http://localhost:${escapeHtml(port)}`);
}

function notifyServerDown() {
  return sendTelegram('🔴 <b>Bot đã TẮT</b>\nServer đã dừng.');
}

function notifyError(context, message) {
  return sendTelegram(`⚠️ <b>Lỗi server</b>\n${escapeHtml(context)}: ${escapeHtml(message)}`);
}

function notifyBuyCustomer({ customerName, phone, address, message, addressLookup }) {
  const lines = [
    '🛒 <b>Khách MUA HÀNG</b>',
    `👤 ${escapeHtml(customerName || 'Khách')}`,
    phone ? `📞 ${escapeHtml(phone)}` : '',
    address ? `📍 ${escapeHtml(address)}` : '',
    addressLookup?.googleMapsUrl ? `🔎 Google Maps: ${escapeHtml(addressLookup.googleMapsUrl)}` : '',
    addressLookup?.confidence ? `⚠️ Độ chắc chắn: ${escapeHtml(addressLookup.confidence)}` : '',
    message ? `💬 ${escapeHtml(message)}` : ''
  ].filter(Boolean);
  return sendTelegram(lines.join('\n'));
}

// Build end-of-day counts from the log entries (see store.appendLog shape).
// Pure function: filters to `dateStr` (local YYYY-MM-DD) and matches the log
// messages emitted by the bot loop. `now` is injectable for testing.
function buildDailyStats(logs, now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const dateStr = `${y}-${m}-${d}`;

  const sameLocalDay = (iso) => {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return false;
    const ly = t.getFullYear();
    const lm = String(t.getMonth() + 1).padStart(2, '0');
    const ld = String(t.getDate()).padStart(2, '0');
    return `${ly}-${lm}-${ld}` === dateStr;
  };

  const today = (Array.isArray(logs) ? logs : []).filter((x) => x && sameLocalDay(x.time));

  const stats = { dateStr, newCustomers: 0, buyOrders: 0, reviewCases: 0, errors: 0, shortcutsSent: 0 };
  for (const log of today) {
    const type = log.type || '';
    const level = log.level || '';
    const msg = String(log.message || '');
    if (level === 'ERROR') stats.errors++;
    if (type === 'BOT' && msg.startsWith('Khách mới')) stats.newCustomers++;
    if (type === 'BOT' && msg.startsWith('Khách mua hàng')) stats.buyOrders++;
    if (type === 'BOT' && /^Đã gửi \/\d+/.test(msg)) stats.shortcutsSent++;
    if (type === 'REVIEW_QUEUE' && msg.startsWith('Thêm ca')) stats.reviewCases++;
  }
  return stats;
}

function formatDailyReport(stats) {
  return [
    `📊 <b>Báo cáo cuối ngày ${escapeHtml(stats.dateStr)}</b>`,
    `🆕 Khách mới: <b>${stats.newCustomers}</b>`,
    `🛒 Đơn mua: <b>${stats.buyOrders}</b>`,
    `📨 Shortcut đã gửi: <b>${stats.shortcutsSent}</b>`,
    `⏳ Ca chờ duyệt: <b>${stats.reviewCases}</b>`,
    `⚠️ Lỗi: <b>${stats.errors}</b>`
  ].join('\n');
}

// Schedule the daily report at REPORT_HOUR:REPORT_MIN local time. Re-arms
// itself after each fire. Returns a cancel function. `getLogs` is async.
const REPORT_HOUR = 23;
const REPORT_MIN = 30;

function msUntilNextReport(now = new Date()) {
  const next = new Date(now);
  next.setHours(REPORT_HOUR, REPORT_MIN, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDailyReport(getLogs) {
  if (!isConfigured()) return () => {};
  let timer = null;
  const arm = () => {
    timer = setTimeout(async () => {
      try {
        const logs = await getLogs();
        await sendTelegram(formatDailyReport(buildDailyStats(logs)));
      } catch (_) { /* report is best-effort */ }
      arm();
    }, msUntilNextReport());
    if (timer.unref) timer.unref();
  };
  arm();
  return () => { if (timer) clearTimeout(timer); };
}

module.exports = {
  isConfigured,
  sendTelegram,
  notifyServerUp,
  notifyServerDown,
  notifyError,
  notifyBuyCustomer,
  buildDailyStats,
  formatDailyReport,
  msUntilNextReport,
  scheduleDailyReport
};
