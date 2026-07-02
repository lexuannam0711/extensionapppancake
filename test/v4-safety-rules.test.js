const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyMessage,
  extractContactInfo,
  isNonTextMessage,
  detectPhoneNumber,
  detectAddress
} = require('../src/server/rules');

test('v4 safety: sticker/photo/system snippets are non-text and never contact intent', () => {
  for (const message of [
    'đã gửi một nhãn dán',
    'đã gửi một ảnh',
    'sent a sticker',
    '👍'
  ]) {
    const result = classifyMessage(message);
    assert.equal(result.intent, 'NON_TEXT', message);
    assert.equal(result.hasPhone, false, message);
    assert.equal(result.hasAddress, false, message);
    assert.equal(isNonTextMessage(message), true, message);
  }
});

test('v4 safety: pure links are non-text and digits inside links are ignored', () => {
  const message = 'https://example.com/order/0912345678';
  const result = classifyMessage(message);

  assert.equal(result.intent, 'NON_TEXT');
  assert.equal(result.hasPhone, false);
  assert.equal(detectPhoneNumber(message), false);
});

test('v4 safety: phone-only customer messages escalate as phone detected', () => {
  const result = classifyMessage('sđt của mình 0912345678 nha shop');
  const contact = extractContactInfo('sđt của mình 0912345678 nha shop');

  assert.equal(result.intent, 'PHONE_DETECTED');
  assert.equal(result.hasPhone, true);
  assert.equal(result.hasAddress, false);
  assert.equal(contact.phone, '0912345678');
  assert.equal(contact.phoneValid, true);
});

test('v4 safety: address-only customer messages escalate as address detected', () => {
  const message = 'ship về phường 3 quận 8 thành phố hồ chí minh';
  const result = classifyMessage(message);
  const contact = extractContactInfo(message);

  assert.equal(result.intent, 'ADDRESS_DETECTED');
  assert.equal(result.hasPhone, false);
  assert.equal(result.hasAddress, true);
  assert.equal(detectAddress(message), true);
  assert.equal(contact.addressValid, true);
});

test('v4 safety: phone and address together are high buy intent', () => {
  const message = 'mình lấy 1 hộp, sđt 0912345678, địa chỉ phường 3 quận 8';
  const result = classifyMessage(message);
  const contact = extractContactInfo(message);

  assert.equal(result.intent, 'BUY_INTENT_HIGH');
  assert.equal(result.hasPhone, true);
  assert.equal(result.hasAddress, true);
  assert.equal(contact.hasContact, true);
});

test('v4 safety: vague numeric messages are not treated as phone or address', () => {
  const result = classifyMessage('60');

  assert.equal(result.intent, 'UNKNOWN');
  assert.equal(result.hasPhone, false);
  assert.equal(result.hasAddress, false);
});
