function shouldSkipByTags(info) {
  if (!info) return false;
  return Boolean(info.hasTags || (info.tags || []).length > 0);
}

function cloneConversationInfo(info) {
  const rowInfo = info && typeof info === 'object' ? info : {};
  const tags = Array.isArray(rowInfo.tags) ? [...rowInfo.tags] : [];
  return {
    ...rowInfo,
    tags,
    hasTags: Boolean(rowInfo.hasTags || tags.length > 0)
  };
}

async function readEffectiveConversationInfo({ info, readCurrentTags, onWarning } = {}) {
  try {
    const currentTags = await readCurrentTags();
    if (!Array.isArray(currentTags)) throw new TypeError('Current tags must be an array');
    return {
      ...(info && typeof info === 'object' ? info : {}),
      tags: [...currentTags],
      hasTags: currentTags.length > 0
    };
  } catch (error) {
    if (typeof onWarning === 'function') await onWarning(error);
    return cloneConversationInfo(info);
  }
}

function decideBeforeAnalysis({ info, lastSender, settings } = {}) {
  const hasTags = shouldSkipByTags(info);
  const tagName = settings?.newCustomerTagName || 'Saruto Mới';
  const shortcut = settings?.defaultNewCustomerShortcut || '/1';

  if (!hasTags) {
    return {
      phase: 'PRE_ANALYSIS',
      hasTags,
      action: 'NEW_CUSTOMER',
      tagName,
      shortcut,
      shouldApplyNewCustomerTag: true,
      shouldFillShortcut: true,
      shouldSendShortcut: true,
      shouldSkipAnalysis: true
    };
  }

  if (lastSender === 'admin') {
    return {
      phase: 'PRE_ANALYSIS',
      hasTags,
      action: 'SKIPPED_HUMAN_REPLY',
      tagName: '',
      shortcut: '',
      shouldApplyNewCustomerTag: false,
      shouldFillShortcut: false,
      shouldSendShortcut: false,
      shouldSkipAnalysis: true
    };
  }

  return {
    phase: 'PRE_ANALYSIS',
    hasTags,
    action: 'NEEDS_ANALYSIS',
    tagName: '',
    shortcut: '',
    shouldApplyNewCustomerTag: false,
    shouldFillShortcut: false,
    shouldSendShortcut: false,
    shouldSkipAnalysis: false
  };
}

function decideAfterAnalysis({ analysis, settings } = {}) {
  const result = analysis || {};
  const tagName = settings?.buyTagName || 'Mua hàng';
  const confidence = Number(result.confidence || 0);
  const minConfidence = Number(settings?.minConfidence || 0.75);
  const autoSend = Boolean(settings?.autoSend);
  const contactInfo = result.contactInfo || {};
  const hasContact = Boolean(contactInfo.phone || contactInfo.address);

  if (result.action === 'SKIP' || result.intent === 'NON_TEXT') {
    return {
      phase: 'POST_ANALYSIS',
      action: 'SKIPPED_NON_TEXT',
      shortcut: null,
      tagName: '',
      shouldApplyBuyTag: false,
      shouldMarkUnread: false,
      shouldNotifyBuy: false,
      shouldEnqueueReview: false,
      shouldFillShortcut: false,
      shouldAttemptAutoSend: false,
      recordExampleIfSent: false
    };
  }

  if (result.action === 'TAG_BUY_AND_MARK_UNREAD') {
    return {
      phase: 'POST_ANALYSIS',
      action: 'ESCALATED',
      shortcut: null,
      tagName,
      shouldApplyBuyTag: true,
      shouldMarkUnread: true,
      shouldNotifyBuy: hasContact,
      shouldEnqueueReview: true,
      shouldFillShortcut: false,
      shouldAttemptAutoSend: false,
      recordExampleIfSent: false
    };
  }

  if (!result.bestShortcut) {
    return {
      phase: 'POST_ANALYSIS',
      action: 'WAITING_REVIEW',
      shortcut: null,
      tagName: '',
      shouldApplyBuyTag: false,
      shouldMarkUnread: false,
      shouldNotifyBuy: false,
      shouldEnqueueReview: true,
      shouldFillShortcut: false,
      shouldAttemptAutoSend: false,
      recordExampleIfSent: false
    };
  }

  const shouldAttemptAutoSend = autoSend && confidence >= minConfidence;
  return {
    phase: 'POST_ANALYSIS',
    action: 'SHORTCUT',
    shortcut: result.bestShortcut,
    tagName: '',
    shouldApplyBuyTag: false,
    shouldMarkUnread: false,
    shouldNotifyBuy: false,
    shouldEnqueueReview: false,
    shouldFillShortcut: true,
    shouldAttemptAutoSend,
    recordExampleIfSent: shouldAttemptAutoSend
  };
}

function decideBeforeSend({ lastSender } = {}) {
  const adminAlreadyReplied = lastSender === 'admin';
  return {
    phase: 'PRE_SEND',
    action: adminAlreadyReplied ? 'SKIPPED_HUMAN_REPLY' : 'SEND_SHORTCUT',
    shouldSendShortcut: !adminAlreadyReplied,
    shouldRecordExample: !adminAlreadyReplied
  };
}

function shouldRecordManualExample({ assistantEnabled, learnExamplesEnabled = true } = {}) {
  return Boolean(assistantEnabled && learnExamplesEnabled);
}

const PDBBotDecision = {
  shouldSkipByTags,
  readEffectiveConversationInfo,
  decideBeforeAnalysis,
  decideAfterAnalysis,
  decideBeforeSend,
  shouldRecordManualExample
};

if (typeof window !== 'undefined') window.PDBBotDecision = PDBBotDecision;
if (typeof module !== 'undefined' && module.exports) module.exports = PDBBotDecision;
