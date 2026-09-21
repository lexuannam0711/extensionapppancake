const { normalizeText, normalizeVietnameseText, classifyMessage } = require('./rules');
const { validateTopSuggestions } = require('./validators');

const intentKeywords = {
  GREETING: ['chào', 'hello', 'hi', 'alo', 'shop', 'tư vấn', 'còn hàng', 'còn không'],
  PRICE_QUESTION: ['giá', 'bao nhiêu', 'tiền', 'combo', 'báo giá', 'liệu trình'],
  SHIPPING_QUESTION: ['ship', 'vận chuyển', 'giao hàng', 'cod', 'phí ship', 'bao lâu'],
  BUY_INTENT_LOW: ['mua', 'đặt', 'lấy', 'chốt', 'xin số điện thoại', 'lên đơn'],
  REFUSAL: ['từ chối', 'chưa mua', 'không mua', 'để sau', 'cảm ơn', 'đắt'],
  COMPLAINT: ['khiếu nại', 'hoàn tiền', 'lỗi', 'sai hàng']
};

function shortcutRole(item) {
  const text = normalizeVietnameseText(searchableShortcut(item)).replace(/[^a-z0-9]+/g, ' ').trim();
  const hasPhone = /\b(?:sdt|so dien thoai|dien thoai)\b/.test(text);
  const hasAddress = /\b(?:dia chi|dia chi cu|thon xom|xa|huyen|tinh)\b/.test(text);
  if (/\b(?:dia chi cong ty|dia chi cty|nha thuoc|quay thuoc|cua hang|gui map|noi ban)\b/.test(text)) return 'STORE_LOCATION';
  if (hasPhone && hasAddress) return 'REQUEST_BOTH_CONTACTS';
  if (hasAddress && /\b(?:xin|gui|cho shop|nhan hang|dia chi cu)\b/.test(text)) return 'REQUEST_CUSTOMER_ADDRESS';
  if (hasPhone && /\b(?:xin|gui|cho shop)\b/.test(text)) return 'REQUEST_CUSTOMER_PHONE';
  return null;
}

function suggestByRole(intent, role, items, reason) {
  const item = items.find((candidate) => shortcutRole(candidate) === role);
  if (!item) {
    return {
      intent,
      action: 'SKIP',
      bestShortcut: null,
      confidence: 0,
      reason: `Không tìm thấy shortcut cho vai trò ${role}`,
      topSuggestions: [],
      shouldSend: false,
      shouldEscalate: false
    };
  }
  return {
    intent,
    action: 'SUGGEST_SHORTCUT',
    bestShortcut: item.shortcut,
    confidence: 1,
    reason,
    topSuggestions: [{ shortcut: item.shortcut, topic: item.topic || '', confidence: 1, reason }],
    shouldSend: false,
    shouldEscalate: false
  };
}

function searchableShortcut(item) {
  return normalizeText([
    item.shortcut,
    item.topic,
    item.quickReply,
    item.message,
    item.folders
  ].filter(Boolean).join(' '));
}

function scoreShortcut(customerMessage, item, intent) {
  const msg = normalizeText(customerMessage);
  const hay = searchableShortcut(item);
  let score = 0;

  const words = msg.split(/\s+/).filter((w) => w.length >= 2);
  for (const word of words) {
    if (hay.includes(word)) score += 0.08;
  }

  const keys = intentKeywords[intent] || [];
  for (const key of keys) {
    if (hay.includes(key)) score += 0.18;
    if (msg.includes(key) && hay.includes(key)) score += 0.1;
  }

  if (intent === 'PRICE_QUESTION' && /(giá|báo giá|combo|tiền)/.test(hay)) score += 0.4;
  if (intent === 'GREETING' && /(chào|khách mới|xin chào|tư vấn)/.test(hay)) score += 0.35;
  if (intent === 'SHIPPING_QUESTION' && /(ship|vận chuyển|giao hàng|cod)/.test(hay)) score += 0.35;
  if (intent === 'BUY_INTENT_LOW' && /(xin số|sđt|đặt|mua|lên đơn)/.test(hay)) score += 0.35;
  if (intent === 'REFUSAL' && /(từ chối|chăm sóc|tham khảo|để sau)/.test(hay)) score += 0.35;
  if (intent === 'COMPLAINT' && /(khiếu nại|xử lý|hoàn|lỗi)/.test(hay)) score += 0.35;

  return Math.min(0.99, score);
}

function findSimilarExamples(customerMessage, examples, limit = 6) {
  const items = Array.isArray(examples) ? examples : [];
  const msg = normalizeText(customerMessage);
  const msgWords = new Set(msg.split(/\s+/).filter((w) => w.length >= 2));
  if (!msgWords.size) return [];

  const scored = items.map((ex) => {
    const exWords = normalizeText(ex.message || '').split(/\s+/).filter((w) => w.length >= 2);
    let overlap = 0;
    for (const w of exWords) {
      if (msgWords.has(w)) overlap += 1;
    }
    const denom = Math.max(1, Math.min(msgWords.size, exWords.length));
    return { ex, score: overlap / denom };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.ex);
}

function keywordSuggest(customerMessage, shortcuts) {
  const items = Array.isArray(shortcuts) ? shortcuts : [];
  const cls = classifyMessage(customerMessage);
  if (cls.intent === 'NON_TEXT') {
    return {
      intent: 'NON_TEXT',
      action: 'SKIP',
      bestShortcut: null,
      confidence: 0,
      reason: 'Khách gửi sticker/nhãn dán/like/link, không phải tin nhắn text - bỏ qua',
      topSuggestions: [],
      shouldSend: false,
      shouldEscalate: false
    };
  }
  if (cls.contactState === 'COMPLETE') {
    return {
      intent: cls.intent,
      action: 'TAG_BUY_AND_MARK_UNREAD',
      bestShortcut: null,
      confidence: 1,
      reason: 'Khách có SĐT và địa chỉ đủ ba cấp, cần chủ shop xử lý',
      topSuggestions: [],
      shouldSend: false,
      shouldEscalate: true
    };
  }
  if (cls.intent === 'COMPLAINT') {
    return { intent: cls.intent, action: 'SKIP', bestShortcut: null, confidence: 0, reason: 'Complaint requires manual handling', topSuggestions: [], shouldSend: false, shouldEscalate: false };
  }
  if (cls.addressRole === 'STORE_LOCATION_REQUEST') {
    return suggestByRole(cls.intent, 'STORE_LOCATION', items, 'Khách hỏi địa chỉ hoặc vị trí nhà thuốc');
  }
  if (cls.contactState === 'INCOMPLETE_CONTACT') {
    return { intent: cls.intent, action: 'SKIP', bestShortcut: null, confidence: 0, reason: 'Contact labels are incomplete', topSuggestions: [], shouldSend: false, shouldEscalate: false };
  }
  if (cls.contactState === 'PHONE_ONLY') {
    return suggestByRole(cls.intent, 'REQUEST_CUSTOMER_ADDRESS', items, 'Khách đã có SĐT, cần xin địa chỉ nhận hàng đầy đủ');
  }
  if (cls.contactState === 'ADDRESS_ONLY') {
    return suggestByRole(cls.intent, 'REQUEST_CUSTOMER_PHONE', items, 'Khách đã có địa chỉ đủ, cần xin SĐT');
  }
  if (cls.contactState === 'INCOMPLETE_ADDRESS') {
    const role = cls.hasPhone ? 'REQUEST_CUSTOMER_ADDRESS' : 'REQUEST_BOTH_CONTACTS';
    return suggestByRole(cls.intent, role, items, 'Thông tin nhận hàng còn thiếu');
  }

  const scored = items
    .map((item) => ({
      shortcut: item.shortcut,
      topic: item.topic || '',
      confidence: scoreShortcut(customerMessage, item, cls.intent),
      reason: `Khớp ${cls.intent}: ${item.topic || item.shortcut}`
    }))
    .filter((x) => x.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);

  const topSuggestions = validateTopSuggestions(scored, items);
  const best = topSuggestions[0] || null;
  return {
    intent: cls.intent,
    action: best ? 'SUGGEST_SHORTCUT' : 'SKIP',
    bestShortcut: best ? best.shortcut : null,
    confidence: best ? best.confidence : 0,
    reason: best ? best.reason : 'Không tìm thấy shortcut phù hợp bằng keyword matcher',
    topSuggestions,
    shouldSend: false,
    shouldEscalate: false
  };
}

module.exports = { keywordSuggest, scoreShortcut, findSimilarExamples };
