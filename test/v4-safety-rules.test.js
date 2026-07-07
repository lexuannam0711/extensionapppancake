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

test('v4 safety: no-diacritic Vietnamese addresses are still detected', () => {
  const message = 'ship ve phuong 3 quan 8 thanh pho ho chi minh';
  const result = classifyMessage(message);
  const contact = extractContactInfo(message);

  assert.equal(result.intent, 'ADDRESS_DETECTED');
  assert.equal(result.hasAddress, true);
  assert.equal(detectAddress(message), true);
  assert.equal(contact.address, 'phuong 3 quan 8 thanh pho ho chi minh');
  assert.equal(contact.addressValid, true);
});

test('v4 safety: province abbreviations only count when paired with approved address markers', () => {
  for (const message of [
    'ship về hp bao lâu',
    'gửi về hcm mất mấy ngày',
    'phí ship về hn bao nhiêu',
    'em đùa thôi gửi về sao cũng được',
    'số nhà anh chưa biết',
    'đường này khó đi không'
  ]) {
    const result = classifyMessage(message);
    assert.notEqual(result.intent, 'ADDRESS_DETECTED', message);
    assert.equal(result.hasAddress, false, message);
    assert.equal(detectAddress(message), false, message);
  }
});

test('v4 safety: strict Vietnamese administrative markers still detect addresses', () => {
  for (const message of [
    'xã an đồng huyện an dương hp',
    'phường 3 hcm',
    'thôn đông xã bình minh huyện thanh oai hn',
    'địa chỉ xã bình minh huyện thanh oai hn',
    'xã bình minh tỉnh thanh hóa'
  ]) {
    const result = classifyMessage(message);
    assert.equal(result.intent, 'ADDRESS_DETECTED', message);
    assert.equal(result.hasAddress, true, message);
    assert.equal(detectAddress(message), true, message);
  }
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
