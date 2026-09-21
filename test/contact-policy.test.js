const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyMessage,
  extractContactInfo,
  hasPhoneLabel,
  hasAddressLabel
} = require('../src/server/rules');
const { analyzeMessageWithAI, buildPrompt } = require('../src/server/ai');

const shortcuts = [
  { shortcut: '/17', topic: 'Xin số điện thoại', message: 'Cho shop xin số điện thoại nhận hàng' },
  { shortcut: '/18', topic: 'Xin địa chỉ', message: 'Cho shop xin địa chỉ nhận hàng đầy đủ' },
  { shortcut: '/8', topic: 'Xin thông tin nhận hàng', message: 'Cho shop xin số điện thoại và địa chỉ nhận hàng đầy đủ' },
  { shortcut: '/2', topic: 'Báo giá', message: 'Bảng giá sản phẩm' }
];

const completeMessage = 'số điện thoại 0912345678, địa chỉ xã Bình Minh huyện Thanh Oai tỉnh Thanh Hóa';

async function analyze(customerMessage, context = {}) {
  return analyzeMessageWithAI({
    customerMessage,
    shortcuts,
    context,
    settings: {}
  });
}

test('contact labels are detected as explicit phrases', () => {
  assert.equal(hasPhoneLabel(completeMessage), true);
  assert.equal(hasAddressLabel(completeMessage), true);
  assert.equal(hasPhoneLabel('0912345678'), false);
  assert.equal(hasPhoneLabel('điện thoại 0912345678'), false);
  assert.equal(hasAddressLabel('xã Bình Minh huyện Thanh Oai tỉnh Thanh Hóa'), false);
});

test('buy gate requires labeled phone and complete three-level address', async () => {
  const classification = classifyMessage(completeMessage);
  const contact = extractContactInfo(completeMessage);
  const result = await analyze(completeMessage);

  assert.equal(classification.contactState, 'COMPLETE');
  assert.equal(contact.hasCompleteContact, true);
  assert.equal(result.action, 'TAG_BUY_AND_MARK_UNREAD');
  assert.equal(result.contactInfo.phoneLabel, true);
  assert.equal(result.contactInfo.addressLabel, true);
});

test('phone/address data without both labels never triggers buy gate', async () => {
  for (const message of [
    '0912345678, xã Bình Minh huyện Thanh Oai tỉnh Thanh Hóa',
    'số điện thoại 0912345678, xã Bình Minh huyện Thanh Oai tỉnh Thanh Hóa',
    'địa chỉ xã Bình Minh huyện Thanh Oai tỉnh Thanh Hóa',
    'số điện thoại 0912345678, địa chỉ xã Bình Minh huyện Thanh Oai',
    'số điện thoại, địa chỉ xã Bình Minh huyện Thanh Oai tỉnh Thanh Hóa'
  ]) {
    const result = await analyze(message);
    assert.notEqual(result.action, 'TAG_BUY_AND_MARK_UNREAD', message);
  }
});

test('old-customer tags and repurchase wording do not bypass contact gate', async () => {
  for (const message of ['ok em', 'chị mua thêm 2 hộp', 'gửi về địa chỉ cũ']) {
    const result = await analyze(message, { currentTags: ['Đã Nhận', 'Nhận Saruto VIP'] });
    assert.notEqual(result.action, 'TAG_BUY_AND_MARK_UNREAD', message);
    assert.equal(Object.hasOwn(result, 'repurchase'), false);
  }
});

test('AI cannot create buy action when deterministic contact gate is incomplete', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        intent: 'BUY_INTENT_HIGH',
        action: 'TAG_BUY_AND_MARK_UNREAD',
        confidence: 1
      }) } }]
    })
  });
  try {
    const result = await analyze('xin chào', { currentTags: ['Đã Nhận'] });
    assert.notEqual(result.action, 'TAG_BUY_AND_MARK_UNREAD');
  } finally {
    global.fetch = originalFetch;
  }
});

test('prompt has no returning-customer policy or review action', () => {
  const prompt = buildPrompt('ok em', shortcuts, { currentTags: ['Đã Nhận'] });

  assert.doesNotMatch(prompt, /CHÍNH SÁCH KHÁCH CŨ|RETURNING_CUSTOMER_FOLLOWUP|REPURCHASE_INTENT/);
  assert.doesNotMatch(prompt, /WAITING_REVIEW/);
  assert.doesNotMatch(prompt, /"currentTags"/);
});

test('non-text messages remain skipped', async () => {
  const result = await analyze('sent a sticker');

  assert.equal(result.intent, 'NON_TEXT');
  assert.equal(result.action, 'SKIP');
  assert.equal(result.shouldEscalate, false);
});
