(() => {
  if (window.__PDB__) return true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function text(el) {
    return String(el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // Pancake dùng framework (Vue/React) theo dõi value qua native setter.
  // Gán thẳng el.value KHÔNG kích hoạt setter đó -> composer bị coi là rỗng,
  // nút gửi không hiện (chỉ thấy nút like). Phải set qua native setter rồi
  // dispatch input để framework cập nhật state.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function dispatchInput(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
  }

  function sanitizeOutgoingText(input) {
    const cleaned = String(input || '').trim();
    if (!/^\/\d+$/.test(cleaned)) {
      throw new Error('Blocked non-shortcut outgoing text: ' + cleaned);
    }
    return cleaned;
  }

  async function waitForSelector(selector, timeout = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const el = document.querySelector(selector);
      if (el && visible(el)) return el;
      await sleep(120);
    }
    throw new Error('Không tìm thấy selector: ' + selector);
  }

  function getUnreadConversations() {
    return Array.from(document.querySelectorAll('.conversation-list-item.unread'))
      .filter(visible)
      .map((el, index) => ({
        index,
        id: el.id || el.closest('[id]')?.id || `unread-${index}`,
        name: text(el.querySelector('.name-text')),
        snippet: text(el.querySelector('.snippet-text')),
        tags: Array.from(el.querySelectorAll('.list-tags-conv .conversation_tags_item')).map(text).filter(Boolean),
        hasTags: Array.from(el.querySelectorAll('.list-tags-conv .conversation_tags_item')).length > 0
      }));
  }

  // Đọc id cuộc trò chuyện đang được chọn (highlight) trong danh sách.
  // Vân tay cuộc trò chuyện ĐANG MỞ trong cột tin nhắn (#messageCol), KHÔNG
  // dựa vào danh sách hội thoại (Pancake không đánh dấu item active ổn định).
  // Ghép tên khách (#pageCustomer .customer-name) + id tin nhắn CUỐI cùng
  // (.inbox-message-ele cuối). Khi đổi khách hoặc có tin mới -> vân tay đổi,
  // dùng để trợ lý gợi ý phát hiện "đổi cuộc". '' nếu chưa mở cuộc nào.
  // Theo DOM thật: header cuộc đang mở có avatar khách class
  // "customer-avatar-<ID>" (ID ổn định theo từng cuộc, đáng tin hơn tên).
  function getActiveConversationId() {
    const scope = document.querySelector('.selected-customer') || document;
    let cid = '';
    const avatar = scope.querySelector('img[class*="customer-avatar-"]');
    if (avatar) {
      const m = String(avatar.className || '').match(/customer-avatar-(\d+)/);
      if (m && m[1]) cid = m[1];
    }
    if (!cid) cid = text(document.querySelector('#pageCustomer .customer-name')) || '';
    const nodes = document.querySelectorAll('.message-list .inbox-message-ele');
    const lastId = nodes.length ? (nodes[nodes.length - 1].id || '') : '';
    if (!cid && !lastId) return '';
    return `${cid}::${lastId}`;
  }

  function findConversationElementById(id) {
    if (!id) return document.querySelector('.conversation-list-item.unread');
    const escaped = id.replace(/([ #;?%&,.+*~\':"!^$[\]()=>|/@])/g, '\\$1');
    return document.getElementById(id) || document.querySelector(`#${escaped}`) || document.querySelector('.conversation-list-item.unread');
  }

  async function clickConversationById(id) {
    const el = findConversationElementById(id);
    if (!el) throw new Error('Không tìm thấy hội thoại unread để click');
    const info = {
      id: el.id || id,
      name: text(el.querySelector('.name-text')),
      snippet: text(el.querySelector('.snippet-text')),
      tags: Array.from(el.querySelectorAll('.list-tags-conv .conversation_tags_item')).map(text).filter(Boolean),
      hasTags: Array.from(el.querySelectorAll('.list-tags-conv .conversation_tags_item')).length > 0
    };
    window.__PDB_LAST__ = info;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(200);
    el.click();
    await sleep(700);
    return info;
  }

  function getCurrentCustomerName() {
    return text(document.querySelector('#pageCustomer .customer-name')) || text(document.querySelector('.copyable-text.customer-name')) || window.__PDB_LAST__?.name || '';
  }

  function getCurrentTags() {
    const last = window.__PDB_LAST__;
    if (last && Array.isArray(last.tags)) return last.tags;
    return [];
  }

  function findTagButtonByName(tagName) {
    const target = String(tagName || '').trim().toLowerCase();
    const buttons = Array.from(document.querySelectorAll('#listShowTags .btn-tag-item, .btn-tag-item'));
    return buttons.find((btn) => text(btn).toLowerCase() === target && visible(btn)) || null;
  }

  async function applyTagByName(tagName) {
    if (!tagName) return { ok: false, message: 'Thiếu tên tag' };
    const btn = findTagButtonByName(tagName);
    if (!btn) return { ok: false, message: `Không tìm thấy tag: ${tagName}` };
    btn.scrollIntoView({ block: 'nearest' });
    await sleep(180);
    btn.click();
    await sleep(500);
    return { ok: true, message: `Đã click tag: ${tagName}` };
  }

  function getReplyTextarea() {
    return document.querySelector('textarea#replyBoxComposer');
  }

  function setTextareaSelection(textarea, start, end = start) {
    if (!textarea || typeof textarea.setSelectionRange !== 'function') return false;
    try {
      textarea.setSelectionRange(start, end);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function setReplyText(value) {
    const safe = sanitizeOutgoingText(value);
    const textarea = await waitForSelector('textarea#replyBoxComposer', 8000);
    textarea.focus({ preventScroll: true });
    setNativeValue(textarea, safe);
    dispatchInput(textarea);
    setTextareaSelection(textarea, safe.length);
    await sleep(250);
    setTextareaSelection(textarea, safe.length);
    return { ok: true, value: safe };
  }

  async function clearReplyText() {
    const textarea = getReplyTextarea();
    if (!textarea) return { ok: false, message: 'Không thấy textarea' };
    textarea.value = '';
    dispatchInput(textarea);
    return { ok: true };
  }

  function findSendButton() {
    const candidates = Array.from(document.querySelectorAll('span.new-reply-box-btn, button, .new-reply-box-btn'))
      .filter(visible);
    // Máy bay màu xanh: path bắt đầu M240,127.89 hoặc svg fill #096DD9 trong vùng reply box.
    return candidates.find((el) => {
      const svg = el.querySelector('svg');
      const path = el.querySelector('path');
      const d = path?.getAttribute('d') || '';
      const fill = svg?.getAttribute('fill') || path?.getAttribute('fill') || '';
      const inReply = Boolean(el.closest('#reply_box') || el.closest('.reply-box-actions-container'));
      return inReply && (d.startsWith('M240,127.89') || d.includes('168,95.89') || fill.toLowerCase() === '#096dd9') && !d.includes('M234,80.12');
    }) || null;
  }

  async function clickSendButton() {
    await sleep(350);
    const btn = findSendButton();
    if (!btn) return { ok: false, message: 'Không tìm thấy nút gửi' };
    btn.click();
    await sleep(700);
    return { ok: true, message: 'Đã click gửi' };
  }

  function findMarkUnreadButton() {
    const candidates = Array.from(document.querySelectorAll('.conv-action-btn')).filter(visible);
    return candidates.find((el) => {
      const d = el.querySelector('path')?.getAttribute('d') || '';
      return d.startsWith('M14.5 7') || d.includes('M13.309 7.792') || d.includes('6.373V12.5');
    }) || null;
  }

  async function markCurrentConversationUnread() {
    const btn = findMarkUnreadButton();
    if (!btn) return { ok: false, message: 'Không tìm thấy nút mark unread' };
    btn.click();
    await sleep(500);
    return { ok: true, message: 'Đã click mark unread' };
  }

  function getDomHealthFromStatus(status) {
    const missing = [];
    if (!status.hasReplyBox) missing.push('reply_box');
    if (!status.hasSendButton) missing.push('send_button');
    if (!status.tagButtons.length) missing.push('tag_buttons');
    if (!status.hasMarkUnread) missing.push('mark_unread');
    const canTypeReply = Boolean(status.hasReplyBox);
    const canSend = Boolean(status.hasReplyBox && status.hasSendButton);
    const canTag = status.tagButtons.length > 0;
    const canMarkUnread = Boolean(status.hasMarkUnread);
    const level = canTypeReply ? (canSend && canTag ? 'OK' : 'WARN') : 'FAIL';
    return {
      level,
      canRead: true,
      canTypeReply,
      canSend,
      canTag,
      canMarkUnread,
      missing
    };
  }

  async function getDomStatus() {
    const status = {
      url: location.href,
      unreadCount: document.querySelectorAll('.conversation-list-item.unread').length,
      hasReplyBox: Boolean(document.querySelector('textarea#replyBoxComposer')),
      tagButtons: Array.from(document.querySelectorAll('#listShowTags .btn-tag-item')).map(text),
      customerName: getCurrentCustomerName(),
      last: window.__PDB_LAST__ || null,
      hasSendButton: Boolean(findSendButton()),
      hasMarkUnread: Boolean(findMarkUnreadButton())
    };
    status.health = getDomHealthFromStatus(status);
    return status;
  }

  async function getDomHealth() {
    return (await getDomStatus()).health;
  }

  // Read up to `limit` most recent messages in the open conversation.
  // Matches Pancake's real chat DOM: .message-list > .inbox-message-ele,
  // customer = .media-current-customer, admin/page = .media-current-user.
  // Skips ad/attachment blocks (no .message-text-ele) and ad-reply noise.
  function getRecentMessages(limit = 5) {
    const container = document.querySelector('.message-list');
    if (!container) return [];
    const nodes = Array.from(container.querySelectorAll('.inbox-message-ele'));
    const messages = [];
    for (const el of nodes) {
      const textEle = el.querySelector('.message-text-ele');
      if (!textEle) continue; // ad/photo/attachment block, not a text message
      const body = text(textEle);
      if (!body) continue;
      if (body.includes('đã trả lời một quảng cáo')) continue; // system noise
      const fromAdmin = el.classList.contains('media-current-user')
        || Boolean(el.querySelector('.media-message-from-page'));
      messages.push({ from: fromAdmin ? 'admin' : 'customer', text: body });
    }
    return messages.slice(-limit);
  }

  // Who sent the most recent message in the open conversation: 'admin' (the
  // page side — a human replying manually or the bot), 'customer', or '' when
  // unreadable. Unlike getRecentMessages this does NOT filter by text, so a
  // reply sent as a photo/sticker still counts as already-answered.
  function getLastMessageSender() {
    const container = document.querySelector('.message-list');
    if (!container) return '';
    const nodes = container.querySelectorAll('.inbox-message-ele');
    if (!nodes.length) return '';
    const last = nodes[nodes.length - 1];
    const fromAdmin = last.classList.contains('media-current-user')
      || Boolean(last.querySelector('.media-message-from-page'));
    return fromAdmin ? 'admin' : 'customer';
  }

  // Read the customer's order status from the info panel (right column).
  // Pancake shows "Đơn hàng (N)" and an order status breadcrumb. Used to tell
  // whether the customer has already purchased (after-sales vs new lead).
  function getCustomerOrderStatus() {
    const result = { orderCount: 0, hasOrdered: false, latestStatus: '' };
    try {
      // Order count: <a class="link-order-list">Đơn hàng <span>(2)</span></a>
      const link = document.querySelector('.link-order-list');
      if (link) {
        const m = text(link).match(/\((\d+)\)/);
        if (m) result.orderCount = Number(m[1]) || 0;
      }
      // Latest order status: the active (highlighted) breadcrumb item.
      const statuses = Array.from(document.querySelectorAll('.update-status .ant-breadcrumb-link .info-text'))
        .map(text)
        .filter(Boolean);
      if (statuses.length) result.latestStatus = statuses[statuses.length - 1];
      result.hasOrdered = result.orderCount > 0;
    } catch (_) { /* info panel not present -> defaults */ }
    return result;
  }

  window.__PDB__ = {
    sleep,
    waitForSelector,
    getUnreadConversations,
    getActiveConversationId,
    clickConversationById,
    getCurrentCustomerName,
    getCurrentTags,
    applyTagByName,
    getReplyTextarea: () => Boolean(getReplyTextarea()),
    setReplyText,
    clearReplyText,
    findSendButton: () => Boolean(findSendButton()),
    clickSendButton,
    findMarkUnreadButton: () => Boolean(findMarkUnreadButton()),
    markCurrentConversationUnread,
    sanitizeOutgoingText,
    getDomStatus,
    getDomHealth,
    getRecentMessages,
    getLastMessageSender,
    getCustomerOrderStatus
  };
  return true;
})();
