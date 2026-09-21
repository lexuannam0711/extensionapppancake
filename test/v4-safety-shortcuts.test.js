const test = require('node:test');
const assert = require('node:assert/strict');

const { isShortcut, sanitizeShortcut, validateShortcutOnly, validateTopSuggestions } = require('../src/server/validators');
const { keywordSuggest } = require('../src/server/shortcutMatcher');

const shortcuts = [
  { shortcut: '/1', topic: 'Khách mới', message: 'Xin chào khách mới' },
  { shortcut: '/2', topic: 'Báo giá', message: 'Bảng giá combo liệu trình' },
  { shortcut: '/3', topic: 'Ship COD', message: 'Thông tin ship cod vận chuyển' },
  { shortcut: '/4', topic: 'Khiếu nại', message: 'Shop tiếp nhận khiếu nại và xử lý' },
  { shortcut: '/8', topic: 'Xin thông tin nhận hàng', message: 'Cho shop xin số điện thoại và địa chỉ nhận hàng đầy đủ' },
  { shortcut: '/10', topic: 'Địa chỉ nhà thuốc', message: 'Địa chỉ công ty và quầy thuốc, gửi map cho khách' },
  { shortcut: '/17', topic: 'Xin số điện thoại', message: 'Cho shop xin số điện thoại nhận hàng' },
  { shortcut: '/18', topic: 'Xin địa chỉ', message: 'Cho shop xin địa chỉ nhận hàng đầy đủ' }
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

test('v4 safety: keywordSuggest requests missing address for phone-only contact', () => {
  const result = keywordSuggest('sđt 0912345678', shortcuts);

  assert.equal(result.intent, 'PHONE_DETECTED');
  assert.equal(result.action, 'SUGGEST_SHORTCUT');
  assert.equal(result.bestShortcut, '/18');
  assert.equal(result.shouldSend, false);
  assert.equal(result.shouldEscalate, false);
});

test('v4 safety: keywordSuggest selects contact shortcuts by semantic role', () => {
  assert.equal(keywordSuggest('xã A huyện B tỉnh C', shortcuts).bestShortcut, '/17');
  assert.equal(keywordSuggest('địa chỉ phường 3 quận 8', shortcuts).bestShortcut, '/8');
  assert.equal(keywordSuggest('0912345678, phường 3 quận 8', shortcuts).bestShortcut, '/18');
});

test('v4 safety: store location shortcut is selected dynamically, not by shortcut number', () => {
  const renamed = shortcuts.map((item) => item.shortcut === '/10' ? { ...item, shortcut: '/77' } : item);
  const result = keywordSuggest('xin địa chỉ nhà thuốc', renamed);

  assert.equal(result.intent, 'STORE_LOCATION_QUESTION');
  assert.equal(result.action, 'SUGGEST_SHORTCUT');
  assert.equal(result.bestShortcut, '/77');
  assert.equal(result.shouldSend, false);
});

test('v4 safety: missing semantic shortcut is skipped', () => {
  const result = keywordSuggest('xin địa chỉ nhà thuốc', shortcuts.filter((item) => item.shortcut !== '/10'));

  assert.equal(result.action, 'SKIP');
  assert.equal(result.bestShortcut, null);
  assert.equal(result.shouldEscalate, false);
});

test('v4 safety: keywordSuggest only returns shortcuts from imported list', () => {
  const result = keywordSuggest('shop báo giá combo bao nhiêu tiền', shortcuts);

  assert.equal(result.action, 'SUGGEST_SHORTCUT');
  assert.equal(result.bestShortcut, '/2');
  assert.equal(result.topSuggestions.every((item) => shortcuts.some((s) => s.shortcut === item.shortcut)), true);
});
