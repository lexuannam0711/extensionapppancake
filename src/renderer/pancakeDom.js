(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./pancakeUrlPolicy'));
  } else {
    root.PDBPancakeDom = factory(root.PDBPancakeUrlPolicy);
  }
})(typeof window !== 'undefined' ? window : globalThis, function (urlPolicy) {
  const CHAT_SHELL_SELECTOR = '.conversation-list-item, #messageCol, .message-list, textarea#replyBoxComposer';
  const LOGIN_PATHS = Object.freeze(['/', '/login', '/signin', '/sign-in']);

  function pageClassification(kind, isChatPage) {
    return Object.freeze({ kind, isChatPage });
  }

  function hasChatShell(documentRef) {
    try {
      return Boolean(documentRef?.querySelector(CHAT_SHELL_SELECTOR));
    } catch (_) {
      return false;
    }
  }

  function classifyPancakePage(documentRef, value) {
    const urlKind = urlPolicy?.classifyPancakeUrl(value) || 'untrusted';
    if (urlKind === 'untrusted') return pageClassification('untrusted', false);
    if (urlKind === 'auth') return pageClassification('auth', false);
    if (hasChatShell(documentRef)) return pageClassification('chat', true);

    const path = new URL(String(value || '')).pathname.replace(/\/+$/, '') || '/';
    if (LOGIN_PATHS.includes(path.toLowerCase())) {
      return pageClassification('auth', false);
    }
    return pageClassification('wrong_page', false);
  }

  function text(element) {
    return String(element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isInternallyVisible(element, getStyle) {
    const style = getStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && rect.width > 0
      && rect.height > 0;
  }

  function readActiveTagNames(documentRef, options = {}) {
    const getStyle = options.getComputedStyle || globalThis.getComputedStyle;
    const buttons = Array.from(
      documentRef.querySelectorAll('#listShowTags .btn-tag-item, .btn-tag-item')
    );
    return buttons
      .filter((button) => isInternallyVisible(button, getStyle))
      .filter((button) => Boolean(button.querySelector('.ellipse')))
      .map(text)
      .filter(Boolean);
  }

  function readConversationInfo(element, index) {
    if (!element.id) throw new Error('Unread conversation row has no stable id');
    const tagElements = Array.from(
      element.querySelectorAll('.list-tags-conv .conversation_tags_item')
    );
    const tags = tagElements.map(text).filter(Boolean);
    return {
      ...(index == null ? {} : { index }),
      id: element.id,
      name: text(element.querySelector('.name-text')),
      snippet: text(element.querySelector('.snippet-text')),
      tags,
      hasTags: tags.length > 0
    };
  }

  function collectUnreadConversations(documentRef, options = {}) {
    const getStyle = options.getComputedStyle || globalThis.getComputedStyle;
    const rows = Array.from(documentRef.querySelectorAll('.conversation-list-item.unread'));
    const items = [];
    let rawCount = 0;
    let malformedCount = 0;

    for (const row of rows) {
      if (!row?.isConnected) {
        malformedCount += 1;
        continue;
      }
      rawCount += 1;
      try {
        if (!isInternallyVisible(row, getStyle)) continue;
        items.push(readConversationInfo(row, items.length));
      } catch (_) {
        malformedCount += 1;
      }
    }

    return {
      rawCount,
      items,
      malformedCount,
      degraded: rawCount > 0 && items.length === 0
    };
  }

  function escapeCssId(id) {
    return String(id).replace(/([ #;?%&,.+*~\':"!^$[\]()=>|/@])/g, '\\$1');
  }

  function findConversationElementById(documentRef, id) {
    const conversationId = String(id || '').trim();
    if (!conversationId) return null;
    const element = documentRef.getElementById(conversationId)
      || documentRef.querySelector(`#${escapeCssId(conversationId)}`);
    if (!element?.isConnected || String(element.id || '') !== conversationId) return null;
    return element;
  }

  async function clickConversationById(documentRef, id) {
    const element = findConversationElementById(documentRef, id);
    if (!element) return { ok: false, code: 'STALE_CONVERSATION' };
    const info = readConversationInfo(element);
    if (String(info.id) !== String(id)) return { ok: false, code: 'STALE_CONVERSATION' };
    element.scrollIntoView({ block: 'center' });
    element.click();
    return { ok: true, info };
  }

  return {
    classifyPancakePage,
    collectUnreadConversations,
    findConversationElementById,
    clickConversationById,
    readActiveTagNames
  };
});
