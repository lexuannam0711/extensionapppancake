const fs = require('fs/promises');
const path = require('path');
const { migrateData } = require('./dataMigration');

const LEGACY_ROOT = path.resolve(__dirname, '../../server/data');
let ROOT = path.resolve(process.env.PANCAKE_DATA_DIR || LEGACY_ROOT);
let UPLOADS = path.resolve(process.env.PANCAKE_UPLOADS_DIR || path.resolve(__dirname, '../../uploads'));
let LEGACY_SOURCE = LEGACY_ROOT;
const LEGACY_UPLOADS = path.resolve(__dirname, '../../uploads');
let initializationPromise = null;
let writeQueue = Promise.resolve();

function configureStorePaths({ dataRoot, uploadsRoot, legacyRoot } = {}) {
  ROOT = path.resolve(dataRoot || process.env.PANCAKE_DATA_DIR || LEGACY_ROOT);
  UPLOADS = path.resolve(uploadsRoot || process.env.PANCAKE_UPLOADS_DIR || path.resolve(__dirname, '../../uploads'));
  LEGACY_SOURCE = path.resolve(legacyRoot || LEGACY_ROOT);
  initializationPromise = null;
  return { dataRoot: ROOT, uploadsRoot: UPLOADS };
}

async function ensureDirs() {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await fs.mkdir(ROOT, { recursive: true });
      await fs.mkdir(UPLOADS, { recursive: true });
      await migrateData({ dataRoot: ROOT, legacyRoot: LEGACY_SOURCE, uploadsRoot: UPLOADS, legacyUploadsRoot: LEGACY_UPLOADS });
    })();
  }
  return initializationPromise;
}

async function readJson(file, fallback) {
  await ensureDirs();
  const filePath = path.join(ROOT, file);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeJson(file, fallback);
    return fallback;
  }
}

function writeJson(file, data) {
  const operation = writeQueue.catch(() => {}).then(async () => {
    await ensureDirs();
    const filePath = path.join(ROOT, file);
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    const backupPath = `${filePath}.bak`;
    await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await fs.copyFile(filePath, backupPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
      await fs.rm(filePath, { force: true });
      await fs.rename(temporaryPath, filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
    }
    return data;
  });
  writeQueue = operation.catch(() => {});
  return operation;
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
  buyTtsExternalEnabled: true,
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
  aiModel: '',
  aiProtocol: 'auto'
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
const REVIEW_QUEUE_MAX = 500;

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

async function getReviewQueue() {
  const data = await readJson('review-queue.json', { items: [] });
  return { items: Array.isArray(data.items) ? data.items : [] };
}

function normalizeAddressLookup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const value = (item) => String(item == null ? '' : item).trim();
  const googleMapsUrl = value(raw.googleMapsUrl);
  if (!/^https:\/\//i.test(googleMapsUrl)) return null;
  return {
    rawAddress: value(raw.rawAddress),
    query: value(raw.query),
    googleMapsUrl,
    confidence: value(raw.confidence),
    note: value(raw.note)
  };
}

function normalizeQueueInput(raw) {
  const value = (item) => String(item == null ? '' : item).trim().slice(0, 2000);
  return {
    customerName: value(raw?.customerName).slice(0, 200),
    customerMessage: value(raw?.customerMessage),
    intent: value(raw?.intent).slice(0, 80),
    reason: value(raw?.reason).slice(0, 500),
    pancakeUrl: value(raw?.pancakeUrl).slice(0, 1000),
    conversationId: value(raw?.conversationId).slice(0, 200),
    suggestedShortcut: /^\/\d+$/.test(String(raw?.suggestedShortcut || '').trim()) ? String(raw.suggestedShortcut).trim() : '',
    addressLookup: normalizeAddressLookup(raw?.addressLookup)
  };
}

async function addOrUpdateReviewItem(raw) {
  const input = normalizeQueueInput(raw);
  const data = await getReviewQueue();
  const now = new Date().toISOString();
  const existingIndex = input.conversationId
    ? data.items.findIndex((item) => item.status === 'pending' && item.conversationId === input.conversationId)
    : -1;
  if (existingIndex >= 0) {
    const previous = data.items[existingIndex];
    const item = {
      ...previous,
      ...input,
      addressLookup: input.addressLookup || previous.addressLookup || null,
      updatedAt: now
    };
    const items = data.items.map((entry, index) => index === existingIndex ? item : entry);
    await writeJson('review-queue.json', { items });
    return { item, updated: true };
  }
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ...input,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    completedAt: null
  };
  await writeJson('review-queue.json', { items: [item, ...data.items].slice(0, REVIEW_QUEUE_MAX) });
  return { item, updated: false };
}

async function markReviewItemDone(id) {
  const data = await getReviewQueue();
  const index = data.items.findIndex((item) => item.id === String(id));
  if (index < 0) return null;
  const current = data.items[index];
  if (current.status === 'done') return current;
  const item = { ...current, status: 'done', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeJson('review-queue.json', { items: data.items.map((entry, itemIndex) => itemIndex === index ? item : entry) });
  return item;
}

async function claimReviewItemSend(id) {
  const data = await getReviewQueue();
  const index = data.items.findIndex((item) => item.id === String(id));
  if (index < 0) return null;
  const current = data.items[index];
  if (current.status === 'done' || current.status === 'sending') return null;
  const now = new Date().toISOString();
  const item = { ...current, status: 'sending', sendAttemptedAt: now, updatedAt: now };
  await writeJson('review-queue.json', { items: data.items.map((entry, itemIndex) => itemIndex === index ? item : entry) });
  return item;
}

async function releaseReviewItemSend(id) {
  const data = await getReviewQueue();
  const index = data.items.findIndex((item) => item.id === String(id));
  if (index < 0) return null;
  const current = data.items[index];
  if (current.status !== 'sending') return current;
  const item = { ...current, status: 'pending', sendAttemptedAt: null, updatedAt: new Date().toISOString() };
  await writeJson('review-queue.json', { items: data.items.map((entry, itemIndex) => itemIndex === index ? item : entry) });
  return item;
}

async function deleteReviewItem(id) {
  const data = await getReviewQueue();
  const items = data.items.filter((item) => item.id !== String(id));
  if (items.length === data.items.length) return null;
  await writeJson('review-queue.json', { items });
  return { items };
}

async function clearDoneReviewItems() {
  const data = await getReviewQueue();
  const items = data.items.filter((item) => item.status !== 'done');
  await writeJson('review-queue.json', { items });
  return { items, removed: data.items.length - items.length };
}

module.exports = {
  get ROOT() { return ROOT; },
  get UPLOADS() { return UPLOADS; },
  configureStorePaths,
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
  claimReviewItemSend,
  releaseReviewItemSend,
  markReviewItemDone,
  deleteReviewItem,
  clearDoneReviewItems
};
