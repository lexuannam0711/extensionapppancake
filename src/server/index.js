require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { getSettings, saveSettings, getShortcuts, saveShortcuts, getLogs, appendLog, clearLogs, getExamples, appendExample, deleteExample, deleteExampleByPair, clearExamples, getReviewQueue, addOrUpdateReviewItem, claimReviewItemSend, releaseReviewItemSend, markReviewItemDone, deleteReviewItem, clearDoneReviewItems, UPLOADS } = require('./store');
const { parseExcel, createTemplateBuffer } = require('./shortcutImporter');
const { analyzeMessageWithAI, summarizeAIConfig, testAIConnection } = require('./ai');
const { classifyMessage } = require('./rules');
const { buildAddressLookup } = require('./addressLookup');
const { findSimilarExamples } = require('./shortcutMatcher');
const { isShortcut } = require('./validators');
const telegram = require('./telegram');
const { synthesizeSpeech, testTtsConnection, getAudioContentType } = require('./tts');
const { MAX_EXCEL_BYTES, isAllowedExcelUpload } = require('./uploadPolicy');

function isAllowedCorsOrigin(origin) {
  return origin == null || origin === '' || origin === 'null';
}

function getServerListenOptions(port) {
  return { port: Number(port), host: '127.0.0.1' };
}

function redactSettings(settings) {
  const { aiApiKey, ...safeSettings } = settings || {};
  return { ...safeSettings, aiApiKeyConfigured: Boolean(aiApiKey) };
}
function getAiTestErrorStatus(error) {
  return ['AI_NETWORK_ERROR', 'AI_PROVIDER_ERROR', 'AI_EMPTY_RESPONSE', 'AI_INVALID_RESPONSE'].includes(error?.code) ? 502 : 400;
}

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: MAX_EXCEL_BYTES, files: 1 },
  fileFilter(_req, file, callback) {
    if (isAllowedExcelUpload(file)) callback(null, true);
    else callback(new Error('Chỉ chấp nhận file Excel .xls hoặc .xlsx hợp lệ'));
  }
});
let lastImportPreview = null;

// Shared handler for /api/ai/analyze-message and its legacy alias.
async function handleAnalyzeMessage(req, res) {
  const { customerMessage = '', customerName = '', currentTags = [], context = {}, conversationHistory = [], orderStatus = null } = req.body || {};
  const settings = await getSettings();
  const shortcuts = await getShortcuts();
  let similarExamples = [];
  try {
    const ex = await getExamples();
    similarExamples = findSimilarExamples(customerMessage, ex.items, 6);
  } catch (_) { /* learning is best-effort, never break analyze */ }
  const analysis = await analyzeMessageWithAI({
    customerMessage,
    shortcuts: shortcuts.items,
    context: { ...context, customerName, currentTags, orderStatus },
    settings,
    examples: similarExamples,
    history: Array.isArray(conversationHistory) ? conversationHistory.slice(-5) : []
  });
  const shouldSend = Boolean(
    settings.autoSend &&
    analysis.bestShortcut &&
    analysis.confidence >= Number(settings.minConfidence || 0.75) &&
    !analysis.shouldEscalate
  );
  const output = { ...analysis, shouldSend, usedExamples: similarExamples.length };
  await appendLog({
    level: 'INFO',
    type: 'ANALYZE',
    message: `${analysis.intent}: ${analysis.bestShortcut || 'null'} - ${analysis.reason}`,
    data: { customerMessage, output }
  });
  res.json(output);
}

function createApp({ authToken = process.env.LOCAL_API_TOKEN, telegramBot = null } = {}) {
  const appTelegram = telegramBot || telegram;
  const app = express();
  app.use(cors({
    origin(origin, callback) {
      callback(null, isAllowedCorsOrigin(origin));
    }
  }));
  app.use((req, res, next) => {
    if (!authToken) return next();
    const supplied = Buffer.from(String(req.headers['x-local-api-token'] || ''));
    const expected = Buffer.from(String(authToken));
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.status(401).json({ error: 'Local API authentication required' });
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', async (_req, res) => {
    const settings = await getSettings();
    const shortcuts = await getShortcuts();
    res.json({ ok: true, time: new Date().toISOString(), settings: redactSettings(settings), shortcutCount: shortcuts.items.length });
  });

  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Pancake Desktop Bot</title><style>body{font-family:Arial;padding:30px;background:#f6fbf8;color:#102018}.card{background:white;border-radius:18px;padding:24px;box-shadow:0 10px 30px #0001;max-width:800px}code{background:#eef7f0;padding:2px 6px;border-radius:6px}</style></head><body><div class="card"><h1>Pancake Desktop AI Shortcut Bot v3</h1><p>Server đang chạy tại <code>http://localhost:${process.env.PORT || 8787}</code>.</p><p>Mở app Electron bằng <code>npm start</code> để chạy Pancake trong cửa sổ desktop.</p><p>API: <code>/health</code>, <code>/api/shortcuts</code>, <code>/api/ai/analyze-message</code>.</p></div></body></html>`);
  });

  app.get('/api/settings', async (_req, res) => res.json(redactSettings(await getSettings())));
  app.post('/api/settings', async (req, res) => {
    const saved = await saveSettings(req.body || {});
    await appendLog({ level: 'INFO', type: 'SETTINGS', message: 'Đã lưu settings', data: { aiApiKeyConfigured: Boolean(saved.aiApiKey) } });
    res.json(redactSettings(saved));
  });

  app.get('/api/ai/config', async (_req, res) => {
    const settings = await getSettings();
    res.json(summarizeAIConfig(settings));
  });

  app.post('/api/ai/config', async (req, res) => {
    const patch = {
      aiBaseUrl: String(req.body?.aiBaseUrl || '').trim(),
      aiApiKey: String(req.body?.aiApiKey || '').trim(),
      aiModel: String(req.body?.aiModel || '').trim(),
      aiProtocol: String(req.body?.aiProtocol || 'auto').trim().toLowerCase()
    };
    const saved = await saveSettings(patch);
    const output = summarizeAIConfig(saved);
    await appendLog({ level: 'INFO', type: 'AI_CONFIG', message: 'Đã lưu AI config', data: { aiApiKeyConfigured: Boolean(saved.aiApiKey), source: output.source } });
    res.json(output);
  });

  app.post('/api/ai/test', async (req, res) => {
    const settings = await getSettings();
    try {
      const result = await testAIConnection(settings, req.body || {});
      await appendLog({ level: 'SUCCESS', type: 'AI_TEST', message: result.message, data: result.config });
      res.json(result);
    } catch (error) {
      await appendLog({ level: 'ERROR', type: 'AI_TEST', message: error.message });
      res.status(getAiTestErrorStatus(error)).json({ error: error.message, code: error.code || 'AI_CONFIG_ERROR' });
    }
  });

  app.get('/api/shortcuts', async (_req, res) => res.json(await getShortcuts()));
  app.post('/api/shortcuts', async (req, res) => {
    const item = req.body || {};
    if (!isShortcut(item.shortcut)) return res.status(400).json({ error: 'Shortcut phải có dạng /n' });
    const data = await getShortcuts();
    const now = new Date().toISOString();
    const normalized = {
      shortcut: item.shortcut.trim(),
      topic: String(item.topic || ''),
      quickReply: String(item.quickReply || ''),
      message: String(item.message || ''),
      photos: String(item.photos || ''),
      folders: String(item.folders || ''),
      files: String(item.files || ''),
      createdAt: item.createdAt || now,
      updatedAt: now
    };
    const idx = data.items.findIndex((x) => x.shortcut === normalized.shortcut);
    if (idx >= 0) data.items[idx] = { ...data.items[idx], ...normalized };
    else data.items.push(normalized);
    await saveShortcuts(data.items);
    await appendLog({ level: 'SUCCESS', type: 'SHORTCUT', message: `Đã lưu ${normalized.shortcut}` });
    res.json({ ok: true, item: normalized, items: data.items });
  });

  app.delete('/api/shortcuts', async (_req, res) => {
    await saveShortcuts([]);
    await appendLog({ level: 'WARN', type: 'SHORTCUT', message: 'Đã xóa toàn bộ shortcuts' });
    res.json({ ok: true, items: [] });
  });

  app.delete('/api/shortcuts/:shortcut', async (req, res) => {
    const shortcut = `/${String(req.params.shortcut || '').replace(/^\//, '')}`;
    const data = await getShortcuts();
    const items = data.items.filter((x) => x.shortcut !== shortcut);
    await saveShortcuts(items);
    await appendLog({ level: 'WARN', type: 'SHORTCUT', message: `Đã xóa ${shortcut}` });
    res.json({ ok: true, items });
  });

  app.post('/api/shortcuts/import-excel', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Thiếu file Excel field=file' });
    try {
      const preview = parseExcel(req.file.path);
      lastImportPreview = preview;
      await appendLog({ level: 'INFO', type: 'IMPORT', message: `Preview Excel: ${preview.validRows.length} hợp lệ, ${preview.errors.length} lỗi` });
      res.json(preview);
    } catch (error) {
      await appendLog({ level: 'ERROR', type: 'IMPORT', message: error.message });
      res.status(500).json({ error: error.message });
    } finally {
      fs.promises.unlink(req.file.path).catch(() => {});
    }
  });

  app.post('/api/shortcuts/commit-import', async (req, res) => {
    if (!lastImportPreview) return res.status(400).json({ error: 'Chưa có preview import' });
    const mode = req.body?.mode || 'overwrite';
    const current = await getShortcuts();
    const map = new Map(current.items.map((item) => [item.shortcut, item]));
    for (const item of lastImportPreview.validRows) {
      if (mode === 'skip' && map.has(item.shortcut)) continue;
      map.set(item.shortcut, { ...(map.get(item.shortcut) || {}), ...item, updatedAt: new Date().toISOString() });
    }
    const items = Array.from(map.values()).sort((a, b) => Number(a.shortcut.slice(1)) - Number(b.shortcut.slice(1)));
    await saveShortcuts(items);
    await appendLog({ level: 'SUCCESS', type: 'IMPORT', message: `Đã import ${lastImportPreview.validRows.length} shortcuts` });
    res.json({ ok: true, items });
  });

  app.get('/api/shortcuts/template', (_req, res) => {
    const buffer = createTemplateBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="pancake-shortcuts-template.xlsx"');
    res.send(buffer);
  });

  app.post('/api/ai/analyze-message', handleAnalyzeMessage);
  // Backward-compatible alias for older clients.
  app.post('/api/ai/select-shortcut', handleAnalyzeMessage);

  // --- Learning: examples (few-shot) ---
  app.get('/api/examples', async (_req, res) => res.json(await getExamples()));

  app.post('/api/examples', async (req, res) => {
    const { message = '', shortcut = '', intent = '' } = req.body || {};
    if (!isShortcut(shortcut)) return res.status(400).json({ error: 'Shortcut phải có dạng /n' });
    const item = await appendExample({ message, shortcut, intent });
    if (!item) return res.status(400).json({ error: 'Thiếu message hoặc shortcut' });
    const data = await getExamples();
    res.json({ ok: true, item, count: data.items.length });
  });

  app.delete('/api/examples/:id', async (req, res) => {
    const data = await deleteExample(req.params.id);
    res.json({ ok: true, ...data });
  });

  app.post('/api/examples/delete-pair', async (req, res) => {
    const { message = '', shortcut = '' } = req.body || {};
    const data = await deleteExampleByPair(message, shortcut);
    await appendLog({ level: 'WARN', type: 'LEARN', message: `Đã xóa ví dụ sai: ${shortcut}`, data: { message } });
    res.json({ ok: true, ...data });
  });

  app.post('/api/examples/clear', async (_req, res) => res.json(await clearExamples()));

  app.get('/api/review-queue', async (_req, res) => {
    res.json(await getReviewQueue());
  });

  app.post('/api/review-queue', async (req, res) => {
    try {
      const body = req.body || {};
      const conversationId = String(body.conversationId || '').trim();
      const pancakeUrl = String(body.pancakeUrl || '').trim();
      if (!conversationId && !/^https:\/\//i.test(pancakeUrl)) {
        return res.status(400).json({ error: 'Thiếu tham chiếu cuộc trò chuyện' });
      }
      const result = await addOrUpdateReviewItem(body);
      await appendLog({
        level: 'INFO',
        type: 'REVIEW_QUEUE',
        message: `${result.updated ? 'Cập nhật' : 'Thêm'} ca chờ xử lý: ${result.item.conversationId || result.item.pancakeUrl}`,
        data: { item: result.item, updated: result.updated }
      });
      Promise.resolve(appTelegram.notifyReviewCase?.(result.item)).catch(() => {});
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ error: 'Không thể thêm ca xử lý' });
    }
  });

  app.post('/api/review-queue/:id/done', async (req, res) => {
    const item = await markReviewItemDone(req.params.id);
    if (!item) return res.status(404).json({ error: 'Không tìm thấy mục trong hàng đợi' });
    await appendLog({ level: 'SUCCESS', type: 'REVIEW_QUEUE', message: `Đã hoàn tất ca chờ xử lý: ${item.conversationId || item.pancakeUrl}`, data: { item } });
    res.json({ ok: true, item });
  });

  app.delete('/api/review-queue/:id', async (req, res) => {
    const result = await deleteReviewItem(req.params.id);
    if (!result) return res.status(404).json({ error: 'Không tìm thấy mục trong hàng đợi' });
    await appendLog({ level: 'WARN', type: 'REVIEW_QUEUE', message: `Đã xóa ca chờ xử lý: ${req.params.id}`, data: { id: req.params.id } });
    res.json({ ok: true, items: result.items });
  });

  app.post('/api/review-queue/clear-done', async (_req, res) => {
    const result = await clearDoneReviewItems();
    await appendLog({ level: 'INFO', type: 'REVIEW_QUEUE', message: `Đã xóa ${result.removed} mục đã hoàn tất khỏi hàng đợi`, data: { removed: result.removed } });
    res.json({ ok: true, ...result });
  });

  app.post('/api/rules/classify', (req, res) => res.json(classifyMessage(req.body?.text || '')));

  app.post('/api/tts/synthesize', async (req, res) => {
    const text = String(req.body?.input || req.body?.text || '').trim();
    if (!text || text.length > 2000) return res.status(400).json({ error: 'Nội dung TTS không hợp lệ' });
    try {
      const responseFormat = req.body?.format || req.body?.responseFormat;
      const audio = await synthesizeSpeech(text, {
        model: req.body?.model,
        responseFormat
      });
      res.type(getAudioContentType(responseFormat)).send(audio);
    } catch (error) {
      res.status(502).json({ error: error.code || 'TTS_UNAVAILABLE' });
    }
  });

  app.post('/api/tts/test', async (_req, res) => {
    try {
      res.json({ ok: await testTtsConnection() });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.code || 'TTS_UNAVAILABLE' });
    }
  });

  app.post('/api/address/lookup', (req, res) => {
    const { message = '', customerName = '', phone = '' } = req.body || {};
    res.json({ ok: true, lookup: buildAddressLookup({ message, customerName, phone }) });
  });

  app.get('/api/logs', async (req, res) => {
    const logs = await getLogs();
    const limit = Math.min(Number(req.query.limit || 200), 800);
    res.json(logs.slice(0, limit));
  });
  app.post('/api/logs', async (req, res) => res.json(await appendLog(req.body || {})));
  app.post('/api/logs/clear', async (_req, res) => res.json(await clearLogs()));

  app.post('/api/notify/test', async (_req, res) => {
    const msg = 'Test thông báo từ Pancake Desktop AI Shortcut Bot';
    await appendLog({ level: 'INFO', type: 'NOTIFY', message: msg });
    const sent = await appTelegram.sendTelegram(`🔔 ${msg}`);
    res.json({ ok: true, message: msg, telegramSent: sent });
  });

  app.post('/api/notify/buy', async (req, res) => {
    const { customerName = '', phone = '', address = '', message = '', addressLookup = null } = req.body || {};
    const sent = await appTelegram.notifyBuyCustomer?.({ customerName, phone, address, message, addressLookup });
    res.json({ ok: true, telegramSent: sent });
  });

  app.post('/api/notify/system-alert', async (req, res) => {
    const sent = await appTelegram.notifySystemAlert?.({
      tabId: req.body?.tabId,
      level: req.body?.level,
      message: req.body?.message,
      pancakeUrl: req.body?.pancakeUrl
    });
    res.json({ ok: true, telegramSent: Boolean(sent) });
  });

  app.post('/api/notify/complaint-alert', async (req, res) => {
    const sent = await appTelegram.notifyComplaintAlert?.({
      customerName: req.body?.customerName,
      conversationId: req.body?.conversationId,
      message: req.body?.message,
      pancakeUrl: req.body?.pancakeUrl,
      reason: req.body?.reason
    });
    res.json({ ok: true, telegramSent: Boolean(sent) });
  });

  // Centralized error handler: log + notify Telegram, never leak stack to client.
  app.use((err, _req, res, _next) => {
    const detail = err && err.message ? err.message : String(err);
    appendLog({ level: 'ERROR', type: 'SERVER', message: `Lỗi xử lý request: ${detail}` }).catch(() => {});
    Promise.resolve(appTelegram.notifyError?.('Request', detail)).catch(() => {});
    if (res.headersSent) return;
    res.status(500).json({ error: 'Lỗi server nội bộ' });
  });

  return app;
}

function startServer(port = Number(process.env.PORT || 8787), options = {}) {
  const telegramBot = options.telegramBot || telegram.createTelegramBot({
    getStatus: async () => {
      const current = await getSettings();
      return {
        running: Boolean(current.botEnabled),
        autoSend: Boolean(current.autoSend),
        tts: Boolean(current.buyTtsEnabled),
        shortcut: current.defaultNewCustomerShortcut,
        newCustomerTag: current.newCustomerTagName,
        buyTag: current.buyTagName
      };
    },
    startBot: async () => {
      await saveSettings({ botEnabled: true });
      await options.telegramControl?.startBot?.();
    },
    stopBot: async () => {
      await saveSettings({ botEnabled: false });
      await options.telegramControl?.stopBot?.();
    },
    setAutoSend: async (enabled) => {
      await saveSettings({ autoSend: Boolean(enabled) });
      await options.telegramControl?.setAutoSend?.(Boolean(enabled));
    },
    getDailyReport: async () => telegram.formatDailyReport(telegram.buildDailyStats(await getLogs())),
    reviewCallbacks: {
      send: async ({ reviewCaseId }) => {
        const item = await claimReviewItemSend(reviewCaseId);
        if (!item) return false;
        const handled = await options.telegramControl?.sendReviewShortcut?.(item);
        if (handled !== true) {
          await releaseReviewItemSend(reviewCaseId);
          return false;
        }
        await markReviewItemDone(reviewCaseId);
        return true;
      },
      done: async ({ reviewCaseId }) => Boolean(await markReviewItemDone(reviewCaseId)),
      del: async ({ reviewCaseId }) => Boolean(await deleteReviewItem(reviewCaseId))
    }
  });
  const app = createApp({ ...options, telegramBot });
  return new Promise((resolve) => {
    const server = app.listen(getServerListenOptions(port), () => {
      console.log(`[server] http://127.0.0.1:${port}`);
      telegram.notifyServerUp(port).catch(() => {});
      telegramBot.startPolling();
      telegramBot.scheduleDailyReport(getLogs);
      resolve(server);
    });
    server.on('close', () => { telegramBot.stopPolling().catch(() => {}); });
  });
}

// Notify on crashes (best-effort, non-blocking). Do not exit the process here;
// preserve existing behavior — only add the Telegram alert.
process.on('uncaughtException', (err) => {
  telegram.notifyError('uncaughtException', err && err.message ? err.message : String(err)).catch(() => {});
});
process.on('unhandledRejection', (reason) => {
  telegram.notifyError('unhandledRejection', reason && reason.message ? reason.message : String(reason)).catch(() => {});
});

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer, isAllowedCorsOrigin, getServerListenOptions, getAiTestErrorStatus };
