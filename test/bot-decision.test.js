const test = require('node:test');
const assert = require('node:assert/strict');

const PDBBotDecision = require('../src/renderer/botDecision');
const {
  shouldSkipByTags,
  readEffectiveConversationInfo,
  decideBeforeAnalysis,
  decideAfterAnalysis,
  decideBeforeSend
} = PDBBotDecision;

test('bot decision: live tags replace stale row tags without mutating either input', async () => {
  const info = { id: 'conversation-1', hasTags: false, tags: [] };
  const liveTags = ['Nhãn Saruto VIP'];

  const effectiveInfo = await readEffectiveConversationInfo({
    info,
    readCurrentTags: async () => liveTags
  });

  assert.notEqual(effectiveInfo, info);
  assert.notEqual(effectiveInfo.tags, liveTags);
  assert.deepEqual(effectiveInfo, {
    id: 'conversation-1',
    hasTags: true,
    tags: ['Nhãn Saruto VIP']
  });
  assert.deepEqual(info, { id: 'conversation-1', hasTags: false, tags: [] });
  liveTags.push('Later mutation');
  assert.deepEqual(effectiveInfo.tags, ['Nhãn Saruto VIP']);
});

test('bot decision: verified empty live tags clear stale row tags', async () => {
  const effectiveInfo = await readEffectiveConversationInfo({
    info: { id: 'conversation-1', hasTags: true, tags: ['Nhãn Saruto VIP'] },
    readCurrentTags: async () => []
  });

  assert.deepEqual(effectiveInfo, {
    id: 'conversation-1',
    hasTags: false,
    tags: []
  });
});

test('bot decision: tag read rejection warns once and retains cloned row tags', async () => {
  const error = new Error('tag panel unavailable');
  const warnings = [];
  const info = { id: 'conversation-1', hasTags: true, tags: ['Row tag'] };

  const effectiveInfo = await readEffectiveConversationInfo({
    info,
    readCurrentTags: async () => { throw error; },
    onWarning: async (caught) => warnings.push(caught)
  });

  assert.deepEqual(warnings, [error]);
  assert.notEqual(effectiveInfo, info);
  assert.notEqual(effectiveInfo.tags, info.tags);
  assert.deepEqual(effectiveInfo, info);
});

test('bot decision: malformed live tags warn and retain row tags', async () => {
  const warnings = [];

  const effectiveInfo = await readEffectiveConversationInfo({
    info: { hasTags: true, tags: ['Row tag'] },
    readCurrentTags: async () => 'not-an-array',
    onWarning: async (error) => warnings.push(error)
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /array/i);
  assert.deepEqual(effectiveInfo, { hasTags: true, tags: ['Row tag'] });
});

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

test('bot decision: no-tag customer with admin last message still gets new-customer shortcut send', () => {
  const decision = decideBeforeAnalysis({
    info: { hasTags: false, tags: [] },
    lastSender: 'admin',
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

    assert.equal(decision.action, analysis.intent === 'NON_TEXT' ? 'SKIPPED_NON_TEXT' : 'SKIPPED_NO_ACTION');
    assert.equal(decision.shouldApplyBuyTag, false);
    assert.equal(decision.shouldMarkUnread, false);
    assert.equal(decision.shouldFillShortcut, false);
    assert.equal(decision.shouldAttemptAutoSend, false);
  }
});

test('bot decision: buy/contact escalation applies buy tag, marks unread, notifies when contact exists', () => {
  const decision = decideAfterAnalysis({
    analysis: {
      action: 'TAG_BUY_AND_MARK_UNREAD',
      contactInfo: {
        phone: '0912345678',
        address: 'xã bình minh huyện thanh oai tỉnh thanh hóa',
        phoneValid: true,
        addressValid: true,
        phoneLabel: true,
        addressLabel: true
      }
    },
    settings: { buyTagName: 'Mua hàng' }
  });

  assert.equal(decision.action, 'ESCALATED');
  assert.equal(decision.tagName, 'Mua hàng');
  assert.equal(decision.shouldApplyBuyTag, true);
  assert.equal(decision.shouldMarkUnread, true);
  assert.equal(decision.shouldNotifyBuy, true);
});

test('bot decision: buy/contact escalation without contact does not notify buy', () => {
  const decision = decideAfterAnalysis({
    analysis: { action: 'TAG_BUY_AND_MARK_UNREAD', contactInfo: {} },
    settings: { buyTagName: 'Mua hàng' }
  });

  assert.equal(decision.action, 'SKIPPED_CONTACT_GATE');
  assert.equal(decision.shouldApplyBuyTag, false);
  assert.equal(decision.shouldMarkUnread, false);
  assert.equal(decision.shouldNotifyBuy, false);
});

test('bot decision: unsupported analysis action enters review queue', () => {
  const decision = decideAfterAnalysis({
    analysis: { action: 'UNSUPPORTED_ACTION', bestShortcut: '/2' },
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

test('bot decision: manual fill only records examples when assistant and learning are on', () => {
  assert.equal(PDBBotDecision.shouldRecordManualExample({ assistantEnabled: false, learnExamplesEnabled: true, typedMessage: '' }), false);
  assert.equal(PDBBotDecision.shouldRecordManualExample({ assistantEnabled: false, learnExamplesEnabled: true, typedMessage: 'giá bao nhiêu' }), false);
  assert.equal(PDBBotDecision.shouldRecordManualExample({ assistantEnabled: true, learnExamplesEnabled: false, typedMessage: 'giá bao nhiêu' }), false);
  assert.equal(PDBBotDecision.shouldRecordManualExample({ assistantEnabled: true, learnExamplesEnabled: true, typedMessage: '' }), true);
  assert.equal(PDBBotDecision.shouldRecordManualExample({ assistantEnabled: true, learnExamplesEnabled: true, typedMessage: 'giá bao nhiêu' }), true);
});
