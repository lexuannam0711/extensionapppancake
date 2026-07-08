const fs = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../server/data');
const UPLOADS = path.resolve(__dirname, '../../uploads');

async function ensureDirs() {
  await fs.mkdir(ROOT, { recursive: true });
  await fs.mkdir(UPLOADS, { recursive: true });
}

async function readJson(file, fallback) {
  await ensureDirs();
  const filePath = path.join(ROOT, file);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    await writeJson(file, fallback);
    return fallback;
  }
}

async function writeJson(file, data) {
  await ensureDirs();
  const filePath = path.join(ROOT, file);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

const DEFAULT_SETTINGS = {
  botEnabled: false,
  autoSend: false,
  shortcutOnlyMode: true,
  minConfidence: 0.75,
  defaultNewCustomerShortcut: '/1',
  newCustomerTagName: 'Saruto Mới',
  buyTagName: 'Mua hàng',
  buyTtsEnabled: true,
  buyTtsDebounceMs: 1500,
  allowShortcutAfterBuyIntent: false,
  processDelayMs: 3000,
  scanIntervalMs: 2500,
  autoClickEnabled: false,
  autoClickDelayMs: 3000,
  learnExamplesEnabled: true,
  theme: 'light',
  aiBaseUrl: '',
  aiApiKey: '',
  aiModel: ''
};

async function getSettings() {
  const settings = await readJson('settings.json', DEFAULT_SETTINGS);
  const savedSettings = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  return { ...DEFAULT_SETTINGS, ...savedSettings };
}

async function saveSettings(patch) {
  const current = await getSettings();
  return writeJson('settings.json', { ...current, ...patch });
}

async function getShortcuts() {
  const data = await readJson('shortcuts.json', { items: [] });
  data.items = Array.isArray(data.items) ? data.items : [];
  return data;
}

async function saveShortcuts(items) {
  return writeJson('shortcuts.json', { items: Array.isArray(items) ? items : [] });
}

async function getLogs() {
  return readJson('logs.json', []);
}

async function appendLog(entry) {
  const logs = await getLogs();
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toISOString(),
    level: entry.level || 'INFO',
    type: entry.type || 'GENERAL',
    message: entry.message || '',
    data: entry.data || null
  };
  logs.unshift(item);
  await writeJson('logs.json', logs.slice(0, 800));
  return item;
}

async function clearLogs() {
  await writeJson('logs.json', []);
  return [];
}

const EXAMPLES_MAX = 500;

async function getExamples() {
  const data = await readJson('examples.json', { items: [] });
  data.items = Array.isArray(data.items) ? data.items : [];
  return data;
}

async function appendExample(entry) {
  const message = String(entry.message || '').trim();
  const shortcut = String(entry.shortcut || '').trim();
  if (!message || !shortcut) return null;

  const data = await getExamples();
  // Dedupe identical (message, shortcut): refresh timestamp instead of adding.
  const existing = data.items.find((x) => x.message === message && x.shortcut === shortcut);
  if (existing) {
    existing.createdAt = new Date().toISOString();
    existing.intent = entry.intent || existing.intent || '';
    await writeJson('examples.json', { items: data.items.slice(0, EXAMPLES_MAX) });
    return existing;
  }

  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    message,
    shortcut,
    intent: entry.intent || '',
    createdAt: new Date().toISOString()
  };
  data.items.unshift(item);
  await writeJson('examples.json', { items: data.items.slice(0, EXAMPLES_MAX) });
  return item;
}

async function deleteExample(id) {
  const data = await getExamples();
  const items = data.items.filter((x) => x.id !== id);
  await writeJson('examples.json', { items });
  return { items };
}

async function deleteExampleByPair(message, shortcut) {
  const m = String(message || '').trim();
  const s = String(shortcut || '').trim();
  const data = await getExamples();
  const items = data.items.filter((x) => !(x.message === m && x.shortcut === s));
  await writeJson('examples.json', { items });
  return { items };
}

async function clearExamples() {
  await writeJson('examples.json', { items: [] });
  return { items: [] };
}

const REVIEW_QUEUE_MAX = 500;

async function getReviewQueue() {
  const data = await readJson('review-queue.json', { items: [] });
  data.items = Array.isArray(data.items) ? data.items : [];
  return data;
}

function normalizeAddressLookup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (x) => String(x == null ? '' : x).trim();
  const googleMapsUrl = str(raw.googleMapsUrl);
  if (!googleMapsUrl) return null;
  return {
    rawAddress: str(raw.rawAddress),
    query: str(raw.query),
    googleMapsUrl,
    confidence: str(raw.confidence),
    note: str(raw.note)
  };
}

function normalizeQueueInput(raw) {
  const r = raw || {};
  const str = (x) => String(x == null ? '' : x).trim();
  return {
    customerName: str(r.customerName),
    customerMessage: str(r.customerMessage),
    intent: str(r.intent),
    reason: str(r.reason),
    pancakeUrl: str(r.pancakeUrl),
    conversationId: str(r.conversationId),
    addressLookup: normalizeAddressLookup(r.addressLookup)
  };
}

async function addOrUpdateReviewItem(entry) {
  const input = normalizeQueueInput(entry);
  const data = await getReviewQueue();
  const now = new Date().toISOString();

  // Dedupe: merge into existing pending item with same conversationId (Req 1.7).
  if (input.conversationId) {
    const existing = data.items.find(
      (x) => x.status === 'pending' && x.conversationId === input.conversationId
    );
    if (existing) {
      existing.customerMessage = input.customerMessage;
      existing.intent = input.intent;
      existing.reason = input.reason;
      existing.pancakeUrl = input.pancakeUrl;
      existing.addressLookup = input.addressLookup || existing.addressLookup || null;
      existing.updatedAt = now;
      await writeJson('review-queue.json', { items: data.items });
      return { item: existing, updated: true };
    }
  }

  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    conversationId: input.conversationId,
    customerName: input.customerName,
    customerMessage: input.customerMessage,
    intent: input.intent,
    reason: input.reason,
    pancakeUrl: input.pancakeUrl,
    addressLookup: input.addressLookup,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    completedAt: null
  };
  data.items.unshift(item);
  // Trim to REVIEW_QUEUE_MAX, dropping oldest createdAt (newest are at the front). (Req 5.6)
  const items = data.items.slice(0, REVIEW_QUEUE_MAX);
  await writeJson('review-queue.json', { items });
  return { item, updated: false };
}

async function markReviewItemDone(id) {
  const data = await getReviewQueue();
  const item = data.items.find((x) => x.id === id);
  if (!item) return null;
  if (item.status === 'done') return item; // idempotent: keep original completedAt (Req 4.6)
  const now = new Date().toISOString();
  item.status = 'done';
  item.completedAt = now;
  item.updatedAt = now;
  await writeJson('review-queue.json', { items: data.items });
  return item;
}

async function deleteReviewItem(id) {
  const data = await getReviewQueue();
  const exists = data.items.some((x) => x.id === id);
  if (!exists) return null; // route returns 404 (Req 4.4)
  const items = data.items.filter((x) => x.id !== id);
  await writeJson('review-queue.json', { items });
  return { items };
}

async function clearDoneReviewItems() {
  const data = await getReviewQueue();
  const items = data.items.filter((x) => x.status !== 'done');
  const removed = data.items.length - items.length;
  await writeJson('review-queue.json', { items });
  return { items, removed };
}

module.exports = {
  ROOT,
  UPLOADS,
  ensureDirs,
  readJson,
  writeJson,
  getSettings,
  saveSettings,
  getShortcuts,
  saveShortcuts,
  getLogs,
  appendLog,
  clearLogs,
  getExamples,
  appendExample,
  deleteExample,
  deleteExampleByPair,
  clearExamples,
  REVIEW_QUEUE_MAX,
  getReviewQueue,
  normalizeQueueInput,
  addOrUpdateReviewItem,
  markReviewItemDone,
  deleteReviewItem,
  clearDoneReviewItems
};
