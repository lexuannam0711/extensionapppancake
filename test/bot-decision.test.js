const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldSkipByTags,
  decideBeforeAnalysis,
  decideAfterAnalysis,
  decideBeforeSend
} = require('../src/renderer/botDecision');

test('bot decision: shouldSkipByTags matches current tag semantics', () => {
  assert.equal(shouldSkipByTags(null), false);
  assert.equal(shouldSkipByTags(undefined), false);
  assert.equal(shouldSkipByTags({ hasTags: true }), true);
  assert.equal(shouldSkipByTags({ hasTags: false, tags: [] }), false);
  assert.equal(shouldSkipByTags({ tags: ['Saruto Mới'] }), true);
});

test('bot decision: no-tag customer with customer last message gets new-customer tag and shortcut send', () => {
  const decision = decideBeforeAnalysis({
    info: { hasTags: false, tags: [] },
    lastSender: 'customer',
    settings: { newCustomerTagName: 'Saruto Mới', defaultNewCustomerShortcut: '/1' }
  });

  assert.equal(decision.action, 'NEW_CUSTOMER');
  assert.equal(decision.tagName, 'Saruto Mới');
  assert.equal(decision.shortcut, '/1');
  assert.equal(decision.shouldApplyNewCustomerTag, true);
  assert.equal(decision.shouldFillShortcut, true);
  assert.equal(decision.shouldSendShortcut, true);
  assert.equal(decision.shouldSkipAnalysis, true);
});

test('bot decision: no-tag customer with admin last message gets tagged only without shortcut send', () => {
  const decision = decideBeforeAnalysis({
    info: { hasTags: false, tags: [] },
    lastSender: 'admin',
    settings: { newCustomerTagName: 'Saruto Mới', defaultNewCustomerShortcut: '/1' }
  });

  assert.equal(decision.action, 'NEW_CUSTOMER_TAGGED_ONLY_HUMAN_REPLY');
  assert.equal(decision.tagName, 'Saruto Mới');
  assert.equal(decision.shortcut, '/1');
  assert.equal(decision.shouldApplyNewCustomerTag, true);
  assert.equal(decision.shouldFillShortcut, false);
  assert.equal(decision.shouldSendShortcut, false);
  assert.equal(decision.shouldSkipAnalysis, true);
});

test('bot decision: tagged customer with admin last message skips duplicate reply', () => {
  const decision = decideBeforeAnalysis({
    info: { hasTags: true, tags: ['Saruto Mới'] },
    lastSender: 'admin',
    settings: {}
  });

  assert.equal(decision.action, 'SKIPPED_HUMAN_REPLY');
  assert.equal(decision.shouldApplyNewCustomerTag, false);
  assert.equal(decision.shouldSendShortcut, false);
  assert.equal(decision.shouldSkipAnalysis, true);
});

test('bot decision: tagged customer with customer last message proceeds to analysis', () => {
  const decision = decideBeforeAnalysis({
    info: { hasTags: true, tags: ['Saruto Mới'] },
    lastSender: 'customer',
    settings: {}
  });

  assert.equal(decision.action, 'NEEDS_ANALYSIS');
  assert.equal(decision.shouldApplyNewCustomerTag, false);
  assert.equal(decision.shouldSendShortcut, false);
  assert.equal(decision.shouldSkipAnalysis, false);
});

test('bot decision: skip or non-text analysis is skipped without review side effects', () => {
  for (const analysis of [{ action: 'SKIP' }, { intent: 'NON_TEXT' }]) {
    const decision = decideAfterAnalysis({ analysis, settings: {} });

    assert.equal(decision.action, 'SKIPPED_NON_TEXT');
    assert.equal(decision.shouldApplyBuyTag, false);
    assert.equal(decision.shouldMarkUnread, false);
    assert.equal(decision.shouldEnqueueReview, false);
    assert.equal(decision.shouldFillShortcut, false);
    assert.equal(decision.shouldAttemptAutoSend, false);
  }
});

test('bot decision: buy/contact escalation applies buy tag, marks unread, notifies when contact exists', () => {
  const decision = decideAfterAnalysis({
    analysis: {
      action: 'TAG_BUY_AND_MARK_UNREAD',
      contactInfo: { phone: '0912345678' }
    },
    settings: { buyTagName: 'Mua hàng' }
  });

  assert.equal(decision.action, 'ESCALATED');
  assert.equal(decision.tagName, 'Mua hàng');
  assert.equal(decision.shouldApplyBuyTag, true);
  assert.equal(decision.shouldMarkUnread, true);
  assert.equal(decision.shouldNotifyBuy, true);
  assert.equal(decision.shouldEnqueueReview, true);
});

test('bot decision: buy/contact escalation without contact does not notify buy', () => {
  const decision = decideAfterAnalysis({
    analysis: { action: 'TAG_BUY_AND_MARK_UNREAD', contactInfo: {} },
    settings: { buyTagName: 'Mua hàng' }
  });

  assert.equal(decision.action, 'ESCALATED');
  assert.equal(decision.shouldApplyBuyTag, true);
  assert.equal(decision.shouldMarkUnread, true);
  assert.equal(decision.shouldNotifyBuy, false);
  assert.equal(decision.shouldEnqueueReview, true);
});

test('bot decision: missing best shortcut goes to review queue', () => {
  const decision = decideAfterAnalysis({
    analysis: { action: 'WAITING_REVIEW', bestShortcut: null },
    settings: {}
  });

  assert.equal(decision.action, 'WAITING_REVIEW');
  assert.equal(decision.shouldEnqueueReview, true);
  assert.equal(decision.shouldFillShortcut, false);
  assert.equal(decision.shouldAttemptAutoSend, false);
});

test('bot decision: shortcut with auto-send off only fills shortcut', () => {
  const decision = decideAfterAnalysis({
    analysis: { bestShortcut: '/2', confidence: 0.95 },
    settings: { autoSend: false, minConfidence: 0.75 }
  });

  assert.equal(decision.action, 'SHORTCUT');
  assert.equal(decision.shortcut, '/2');
  assert.equal(decision.shouldFillShortcut, true);
  assert.equal(decision.shouldAttemptAutoSend, false);
  assert.equal(decision.recordExampleIfSent, false);
});

test('bot decision: shortcut with auto-send on and enough confidence attempts auto-send', () => {
  const decision = decideAfterAnalysis({
    analysis: { bestShortcut: '/2', confidence: 0.9 },
    settings: { autoSend: true, minConfidence: 0.75 }
  });

  assert.equal(decision.action, 'SHORTCUT');
  assert.equal(decision.shortcut, '/2');
  assert.equal(decision.shouldFillShortcut, true);
  assert.equal(decision.shouldAttemptAutoSend, true);
  assert.equal(decision.recordExampleIfSent, true);
});

test('bot decision: shortcut with auto-send on but low confidence fills only', () => {
  const decision = decideAfterAnalysis({
    analysis: { bestShortcut: '/2', confidence: 0.5 },
    settings: { autoSend: true, minConfidence: 0.75 }
  });

  assert.equal(decision.action, 'SHORTCUT');
  assert.equal(decision.shortcut, '/2');
  assert.equal(decision.shouldFillShortcut, true);
  assert.equal(decision.shouldAttemptAutoSend, false);
  assert.equal(decision.recordExampleIfSent, false);
});

test('bot decision: final send guard blocks admin-last duplicate sends', () => {
  const decision = decideBeforeSend({ lastSender: 'admin' });

  assert.equal(decision.action, 'SKIPPED_HUMAN_REPLY');
  assert.equal(decision.shouldSendShortcut, false);
  assert.equal(decision.shouldRecordExample, false);
});

test('bot decision: final send guard allows customer-last sends', () => {
  const decision = decideBeforeSend({ lastSender: 'customer' });

  assert.equal(decision.action, 'SEND_SHORTCUT');
  assert.equal(decision.shouldSendShortcut, true);
  assert.equal(decision.shouldRecordExample, true);
});
