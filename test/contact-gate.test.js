const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyMessage,
  extractContactInfo
} = require('../src/server/rules');
const { analyzeMessageWithAI } = require('../src/server/ai');
const { decideAfterAnalysis } = require('../src/renderer/botDecision');

const shortcuts = [
  { shortcut: '/17', topic: 'Xin số điện thoại', message: 'Cho shop xin số điện thoại nhận hàng' },
  { shortcut: '/18', topic: 'Xin địa chỉ', message: 'Cho shop xin địa chỉ nhận hàng đầy đủ' },
  { shortcut: '/8', topic: 'Xin thông tin nhận hàng', message: 'Cho shop xin số điện thoại và địa chỉ nhận hàng đầy đủ' }
];

const qualifiedMessage = 'số điện thoại 0912345678, địa chỉ xã bình minh huyện thanh oai tỉnh thanh hóa';

test('contact gate requires phone/address labels and all three address levels', () => {
  const result = classifyMessage(qualifiedMessage);
  const contact = extractContactInfo(qualifiedMessage);

  assert.equal(result.contactState, 'COMPLETE');
  assert.equal(result.intent, 'BUY_INTENT_HIGH');
  assert.equal(contact.phoneValid, true);
  assert.equal(contact.addressValid, true);
  assert.equal(contact.phoneLabel, true);
  assert.equal(contact.addressLabel, true);
});

test('phone or address phrases alone never become a buy escalation', async () => {
  for (const message of [
    'số điện thoại 0912345678',
    'địa chỉ xã bình minh huyện thanh oai tỉnh thanh hóa',
    '0912345678, xã bình minh huyện thanh oai tỉnh thanh hóa',
    'số điện thoại 0912345678, địa chỉ xã bình minh huyện thanh oai',
    'số điện thoại, địa chỉ xã bình minh huyện thanh oai tỉnh thanh hóa'
  ]) {
    const result = await analyzeMessageWithAI({
      customerMessage: message,
      shortcuts,
      context: { currentTags: [] }
    });

    assert.notEqual(result.action, 'TAG_BUY_AND_MARK_UNREAD', message);
  }
});

test('returning-customer tags do not bypass the contact gate', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('AI unavailable in unit test'); };
  try {
    const result = await analyzeMessageWithAI({
      customerMessage: 'ok em',
      shortcuts,
      context: { currentTags: ['Đã Nhận'] },
      history: [{ from: 'customer', text: 'ok em' }]
    });

    assert.notEqual(result.action, 'TAG_BUY_AND_MARK_UNREAD');
    assert.equal(Object.hasOwn(result, 'repurchase'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('renderer rejects a buy action without the complete contact package', () => {
  const decision = decideAfterAnalysis({
    analysis: {
      action: 'TAG_BUY_AND_MARK_UNREAD',
      contactInfo: {}
    },
    settings: { buyTagName: 'Mua hàng' }
  });

  assert.equal(decision.action, 'SKIPPED_CONTACT_GATE');
  assert.equal(decision.shouldApplyBuyTag, false);
  assert.equal(decision.shouldMarkUnread, false);
});
