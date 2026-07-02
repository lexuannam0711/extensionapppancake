const test = require('node:test');
const assert = require('node:assert/strict');

const { isShortcut, sanitizeShortcut, validateShortcutOnly, validateTopSuggestions } = require('../src/server/validators');
const { keywordSuggest } = require('../src/server/shortcutMatcher');

const shortcuts = [
  { shortcut: '/1', topic: 'Khách mới', message: 'Xin chào khách mới' },
  { shortcut: '/2', topic: 'Báo giá', message: 'Bảng giá combo liệu trình' },
  { shortcut: '/3', topic: 'Ship COD', message: 'Thông tin ship cod vận chuyển' },
  { shortcut: '/4', topic: 'Khiếu nại', message: 'Shop tiếp nhận khiếu nại và xử lý' }
];

test('v4 safety: only /number shortcuts are valid outgoing messages', () => {
  assert.equal(isShortcut('/1'), true);
  assert.equal(isShortcut('/123'), true);
  assert.equal(isShortcut(' /2 '), true);
  assert.equal(isShortcut('xin chào'), false);
  assert.equal(isShortcut('/abc'), false);
  assert.equal(isShortcut('1'), false);
});

test('v4 safety: sanitizeShortcut rejects non-shortcut text', () => {
  assert.equal(sanitizeShortcut(' /9 '), '/9');
  assert.throws(() => sanitizeShortcut('xin chào khách'), /Invalid shortcut/);
});

test('v4 safety: validateShortcutOnly rejects invented shortcuts', () => {
  const result = validateShortcutOnly({ shortcut: '/999', confidence: 0.9, reason: 'invented' }, shortcuts);

  assert.equal(result.shortcut, null);
  assert.equal(result.confidence, 0);
  assert.equal(result.reason, 'Shortcut not found in imported list');
});

test('v4 safety: validateTopSuggestions dedupes and only keeps imported shortcuts', () => {
  const result = validateTopSuggestions([
    { shortcut: '/2', confidence: 0.9 },
    { shortcut: '/2', confidence: 0.8 },
    { shortcut: '/999', confidence: 0.95 },
    { shortcut: 'hello', confidence: 1 },
    { shortcut: '/3', confidence: 0.7 }
  ], shortcuts);

  assert.deepEqual(result.map((item) => item.shortcut), ['/2', '/3']);
});

test('v4 safety: keywordSuggest skips non-text and never suggests shortcut for sticker', () => {
  const result = keywordSuggest('đã gửi một nhãn dán', shortcuts);

  assert.equal(result.intent, 'NON_TEXT');
  assert.equal(result.action, 'SKIP');
  assert.equal(result.bestShortcut, null);
  assert.equal(result.shouldSend, false);
});

test('v4 safety: keywordSuggest escalates contact messages instead of sending shortcut', () => {
  const result = keywordSuggest('sđt 0912345678', shortcuts);

  assert.equal(result.intent, 'PHONE_DETECTED');
  assert.equal(result.action, 'TAG_BUY_AND_MARK_UNREAD');
  assert.equal(result.bestShortcut, null);
  assert.equal(result.shouldSend, false);
  assert.equal(result.shouldEscalate, true);
});

test('v4 safety: keywordSuggest only returns shortcuts from imported list', () => {
  const result = keywordSuggest('shop báo giá combo bao nhiêu tiền', shortcuts);

  assert.equal(result.action, 'SUGGEST_SHORTCUT');
  assert.equal(result.bestShortcut, '/2');
  assert.equal(result.topSuggestions.every((item) => shortcuts.some((s) => s.shortcut === item.shortcut)), true);
});
