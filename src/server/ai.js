const {
  classifyMessage,
  extractContactInfo,
  normalizeVietnameseText,
  sanitizeCustomerTags,
  getEligibleReturningCustomerTags,
  getRepurchaseBlocker,
  detectExplicitRepurchase
} = require('./rules');
const { keywordSuggest } = require('./shortcutMatcher');
const { validateShortcutOnly, validateTopSuggestions } = require('./validators');
const { requestJsonCompat } = require('./httpClient');

function pickConfiguredValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizeChatUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return 'https://api.openai.com/v1/chat/completions';
  const clean = raw.replace(/\/+$/, '');
  if (clean.endsWith('/chat/completions')) return clean;
  if (clean.endsWith('/v1')) return `${clean}/chat/completions`;
  // Bare host (e.g. https://9router.com/api) -> append the standard path.
  return `${clean}/chat/completions`;
}

function maskSecret(secret) {
  const raw = String(secret || '');
  if (!raw) return '';
  if (raw.length <= 8) return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
  return `${raw.slice(0, 4)}***${raw.slice(-4)}`;
}

function resolveAIConfig(settings = {}, overrides = {}) {
  const storedBaseUrl = pickConfiguredValue(overrides.aiBaseUrl, settings.aiBaseUrl);
  const storedApiKey = pickConfiguredValue(overrides.aiApiKey, settings.aiApiKey);
  const storedModel = pickConfiguredValue(overrides.aiModel, settings.aiModel);
  const envBaseUrl = pickConfiguredValue(process.env.AI_BASE_URL, process.env.OPENAI_BASE_URL, 'https://api.openai.com/v1');
  const envApiKey = pickConfiguredValue(process.env.AI_API_KEY, process.env.OPENAI_API_KEY);
  const envModel = pickConfiguredValue(process.env.AI_MODEL, process.env.OPENAI_MODEL, 'gpt-5-mini');

  const baseUrl = pickConfiguredValue(storedBaseUrl, envBaseUrl);
  const apiKey = pickConfiguredValue(storedApiKey, envApiKey);
  const model = pickConfiguredValue(storedModel, envModel);

  return {
    baseUrl,
    apiKey,
    model,
    chatUrl: normalizeChatUrl(baseUrl),
    source: {
      baseUrl: storedBaseUrl ? 'settings' : 'env',
      apiKey: storedApiKey ? 'settings' : 'env',
      model: storedModel ? 'settings' : 'env'
    }
  };
}

function summarizeAIConfig(settings = {}, overrides = {}) {
  const config = resolveAIConfig(settings, overrides);
  return {
    aiBaseUrl: config.baseUrl,
    aiApiKeyMasked: maskSecret(config.apiKey),
    aiModel: config.model,
    resolvedResponsesUrl: config.chatUrl,
    source: config.source
  };
}

function safeJsonParse(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }
  return null;
}

function selectLastCustomerText(history, fallback = '') {
  const latestSnippet = String(fallback || '').trim();
  if (latestSnippet) return latestSnippet;
  const recent = Array.isArray(history) ? history.slice(-5) : [];
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const item = recent[index];
    if (item && item.from === 'customer') {
      const text = String(item.text || '').trim();
      if (text) return text;
    }
  }
  return latestSnippet;
}

function buildPrompt(customerMessage, shortcuts, context, examples = [], history = []) {
  const safeContext = {
    ...(context && typeof context === 'object' ? context : {}),
    currentTags: sanitizeCustomerTags(context?.currentTags)
  };
  const compactShortcuts = shortcuts.map((s) => ({
    shortcut: s.shortcut,
    topic: s.topic || '',
    quickReply: s.quickReply || '',
    message: s.message || '',
    folders: s.folders || ''
  }));

  const learnedBlock = (Array.isArray(examples) && examples.length)
    ? `\n\nVÍ DỤ ĐÃ HỌC (tin khách trước đây và shortcut shop đã chọn đúng - ưu tiên bắt chước nếu tin mới tương tự):\n${JSON.stringify(examples.map((e) => ({ message: e.message, shortcut: e.shortcut })))}`
    : '';

  const recentHistory = Array.isArray(history) ? history.slice(-5) : [];
  const historyBlock = recentHistory.length
    ? `\n\nLỊCH SỬ HỘI THOẠI (cũ → mới, "admin" là shop, "customer" là khách). Dùng để hiểu ngữ cảnh và giai đoạn của khách:\n${JSON.stringify(recentHistory)}`
    : '';

  // Order status (from Pancake info panel) — tells whether the customer bought.
  const order = safeContext.orderStatus;
  const orderBlock = (order && order.hasOrdered)
    ? `\n\nTRẠNG THÁI ĐƠN HÀNG: Khách ĐÃ CÓ ${order.orderCount} đơn (trạng thái mới nhất: ${order.latestStatus || 'không rõ'}). Đây là khách ĐÃ MUA — ưu tiên chăm sóc sau bán (hỏi tình trạng sử dụng, hướng dẫn dùng, giải đáp), KHÔNG tư vấn/chốt đơn lại từ đầu.`
    : '';

  const returningTags = getEligibleReturningCustomerTags(safeContext.currentTags);
  const validIntents = returningTags.length
    ? 'GREETING, PRICE_QUESTION, PRODUCT_QUESTION, SHIPPING_QUESTION, STORE_LOCATION_QUESTION, USAGE_QUESTION, BUY_INTENT_LOW, BUY_INTENT_HIGH, RETURNING_CUSTOMER_FOLLOWUP, PHONE_DETECTED, ADDRESS_DETECTED, ADDRESS_INCOMPLETE, REFUSAL, COMPLAINT, OUT_OF_SCOPE, UNKNOWN'
    : 'GREETING, PRICE_QUESTION, PRODUCT_QUESTION, SHIPPING_QUESTION, STORE_LOCATION_QUESTION, USAGE_QUESTION, BUY_INTENT_LOW, BUY_INTENT_HIGH, PHONE_DETECTED, ADDRESS_DETECTED, ADDRESS_INCOMPLETE, REFUSAL, COMPLAINT, OUT_OF_SCOPE, UNKNOWN';
  const returningPolicyBlock = returningTags.length
    ? `\n\nCHÍNH SÁCH KHÁCH CŨ (chỉ áp dụng vì khách có nhãn đủ điều kiện: ${JSON.stringify(returningTags)}):
- Ưu tiên an toàn theo đúng thứ tự: NON_TEXT hoặc COMPLAINT hoặc REFUSAL hoặc số điện thoại/địa chỉ -> không gợi ý shortcut chăm sóc.
- Không tự kết luận REPURCHASE_INTENT. Rule máy chủ đã xử lý trước các câu mua/gửi tiếp, số lượng cần mua, địa chỉ cũ, hoặc xác nhận ngắn như "ok", "ok em", "oke", "oki", "em gửi đi" trước khi gọi AI.
- RETURNING_CUSTOMER_FOLLOWUP + SUGGEST_SHORTCUT + bestShortcut="/32": máy chủ chọn trực tiếp cho nội dung an toàn của khách cũ không có nhu cầu mua lại rõ ràng.
- Khi /32 không có trong DANH SÁCH SHORTCUT: action=WAITING_REVIEW, bestShortcut=null.
- Không được bịa shortcut; tuyệt đối không trả shortcut nào ngoài danh sách, và chính sách khách cũ không được dùng shortcut khác /32.`
    : '';
  const returningAIGate = returningTags.length
    ? '\n\nAI GATE: The server has already handled explicit repeat-purchase messages before this prompt, including short confirmations and old-address or quantity repeat orders. For any remaining safe non-purchase follow-up from an eligible returning customer, return RETURNING_CUSTOMER_FOLLOWUP with SUGGEST_SHORTCUT and bestShortcut="/32". If the message is unclear or unsafe, return WAITING_REVIEW with bestShortcut=null. Do not return REPURCHASE_INTENT from this AI gate.'
    : '';

  return `Bạn là bộ phân tích tin nhắn khách hàng và chọn shortcut cho Pancake.

QUY TẮC TUYỆT ĐỐI:
- Chỉ chọn shortcut có trong danh sách.
- Không bịa shortcut mới.
- Không viết câu trả lời gửi khách.
- Trả về JSON hợp lệ, không markdown.
- Nhắc tới hoặc hỏi địa chỉ shop/nhà thuốc không phải là cung cấp địa chỉ nhận hàng.
- Chỉ dùng action=TAG_BUY_AND_MARK_UNREAD khi khách có cả SĐT hợp lệ và địa chỉ nhận hàng đủ xã/phường, huyện/quận, tỉnh/thành phố.
- Thiếu SĐT hoặc thiếu địa chỉ đủ ba cấp: chọn shortcut xin thông tin còn thiếu; không gắn Mua hàng.

CÁCH PHÂN TÍCH (suy luận theo thứ tự rồi mới chọn):
1. Đọc LỊCH SỬ HỘI THOẠI để hiểu khách đã hỏi gì, shop đã trả gì.
2. Xác định giai đoạn của khách: MỚI (chưa hỏi gì) / ĐANG CÂN NHẮC (đã hỏi giá/sản phẩm) / SẮP MUA (hỏi cách đặt, để lại thông tin).
3. Chọn shortcut khớp với TIN MỚI NHẤT và giai đoạn đó, tránh lặp lại shortcut shop vừa gửi.

INTENT hợp lệ: ${validIntents}.

SCHEMA JSON:
{
  "intent": "PRICE_QUESTION",
  "action": "SUGGEST_SHORTCUT",
  "bestShortcut": "/2 hoặc null",
  "confidence": 0.0,
  "reason": "lý do ngắn",
  "topSuggestions": [
    {"shortcut":"/2","topic":"báo giá","confidence":0.9,"reason":"..."}
  ],
  "shouldSend": false,
  "shouldEscalate": false
}
${historyBlock}${orderBlock}${returningPolicyBlock}${returningAIGate}${learnedBlock}

TIN KHÁCH (mới nhất): ${JSON.stringify(customerMessage)}
CONTEXT: ${JSON.stringify(safeContext)}
DANH SÁCH SHORTCUT: ${JSON.stringify(compactShortcuts)}`;
}

function extractResponseText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  // Chat Completions format: choices[0].message.content
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    const content = choice?.message?.content;
    if (typeof content === 'string' && content.trim()) return content.trim();
    // Some providers return content as an array of parts.
    if (Array.isArray(content)) {
      const joined = content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('').trim();
      if (joined) return joined;
    }
  }
  // Fallback: legacy Responses API field (in case base URL points to OpenAI /responses).
  if (typeof payload.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  return '';
}

async function callAI(prompt, settings = {}, overrides = {}, transportOptions = {}) {
  const config = resolveAIConfig(settings, overrides);
  if (!config.apiKey) throw new Error('Thiếu AI API key');
  if (!config.baseUrl) throw new Error('Thiếu AI base URL');
  if (!config.model) throw new Error('Thiếu AI model');

  let res;
  try {
    res = await requestJsonCompat(config.chatUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 700,
        temperature: 0.2
      })
    }, transportOptions);
  } catch (error) {
    const wrapped = new Error(`Không thể kết nối AI: ${error.message}`);
    wrapped.code = 'AI_NETWORK_ERROR';
    wrapped.cause = error;
    throw wrapped;
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.error?.message || payload?.error || `${res.status} ${res.statusText}`;
    const error = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    error.code = 'AI_PROVIDER_ERROR';
    error.upstreamStatus = res.status;
    throw error;
  }

  const text = extractResponseText(payload);
  if (!text) throw new Error('AI không trả về nội dung (choices[].message.content rỗng)');
  return text;
}

async function testAIConnection(settings = {}, overrides = {}, transportOptions = {}) {
  const text = await callAI('Trả về đúng JSON này và không thêm gì khác: {"ok":true}', settings, overrides, transportOptions);
  const parsed = safeJsonParse(text);
  if (!parsed?.ok) throw new Error(`AI test trả về không hợp lệ: ${text}`);
  return {
    ok: true,
    message: 'Kết nối AI thành công',
    config: summarizeAIConfig(settings, overrides)
  };
}

function returningWaitingResult(reason, intent = 'RETURNING_CUSTOMER_FOLLOWUP') {
  return {
    intent,
    action: 'WAITING_REVIEW',
    bestShortcut: null,
    confidence: 0,
    reason,
    topSuggestions: [],
    shouldSend: false,
    shouldEscalate: true
  };
}

function returningSafetyResult(intent) {
  if (intent === 'COMPLAINT') {
    return returningWaitingResult('Khách cũ có dấu hiệu khiếu nại, cần người xử lý', intent);
  }
  return {
    intent: 'REFUSAL',
    action: 'SKIP',
    bestShortcut: null,
    confidence: 1,
    reason: 'Khách từ chối hoặc hủy, không áp dụng chính sách mua lại',
    topSuggestions: [],
    shouldSend: false,
    shouldEscalate: false
  };
}

function explicitRepurchaseResult(matchedTags) {
  return {
    intent: 'REPURCHASE_INTENT',
    action: 'TAG_BUY_AND_MARK_UNREAD',
    bestShortcut: null,
    confidence: 1,
    reason: 'Khách cũ thể hiện rõ ý định mua lại',
    topSuggestions: [],
    shouldSend: false,
    shouldEscalate: true,
    repurchase: { matchedTags, evidence: 'explicit_rule' }
  };
}

function returningFollowUpResult(items) {
  const validated = validateShortcutOnly({
    shortcut: '/32',
    confidence: 1,
    reason: 'Câu sale mời khách cũ mua tiếp'
  }, items);
  if (validated.shortcut !== '/32') {
    return returningWaitingResult('Thiếu shortcut /32 trong danh sách đã cấu hình');
  }
  return {
    intent: 'RETURNING_CUSTOMER_FOLLOWUP',
    action: 'SUGGEST_SHORTCUT',
    bestShortcut: '/32',
    confidence: 1,
    reason: validated.reason,
    topSuggestions: [],
    shouldSend: false,
    shouldEscalate: false
  };
}

function returningSkipResult(intent, reason) {
  return {
    intent,
    action: 'SKIP',
    bestShortcut: null,
    confidence: 1,
    reason,
    topSuggestions: [],
    shouldSend: false,
    shouldEscalate: false
  };
}

function returningFallbackResult(items) {
  const followUp = returningFollowUpResult(items);
  return followUp.action === 'WAITING_REVIEW'
    ? returningSkipResult('RETURNING_CUSTOMER_FOLLOWUP', 'Thiếu shortcut /32 nên bỏ qua')
    : followUp;
}

function returningAIDecision(items, parsed, minimumConfidence) {
  const confidence = Number(parsed?.confidence);
  const validated = validateShortcutOnly({
    shortcut: parsed?.bestShortcut || parsed?.shortcut,
    confidence,
    reason: parsed?.reason
  }, items);
  const safeFollowUp = parsed?.intent === 'RETURNING_CUSTOMER_FOLLOWUP' &&
    parsed?.action === 'SUGGEST_SHORTCUT' &&
    Number.isFinite(confidence) &&
    confidence >= minimumConfidence &&
    validated.shortcut === '/32';

  if (!safeFollowUp) return returningWaitingResult('AI response is not a safe configured /32 follow-up');

  return {
    intent: 'RETURNING_CUSTOMER_FOLLOWUP',
    action: 'SUGGEST_SHORTCUT',
    bestShortcut: '/32',
    confidence: validated.confidence,
    reason: validated.reason,
    topSuggestions: [],
    shouldSend: false,
    shouldEscalate: false
  };
}

function isShortRepurchaseConfirmation(text) {
  const normalized = normalizeVietnameseText(text).replace(/[^a-z0-9]+/g, ' ').trim();
  return /^(?:ok|oke|oki|okay)(?:\s+(?:em|nhe))?(?:\s+(?:gui|ship|giao)\s+di)?$/.test(normalized);
}

async function analyzeMessageWithAI({ customerMessage, shortcuts, context = {}, settings = {}, examples = [], history = [] }) {
  const items = Array.isArray(shortcuts) ? shortcuts : [];
  const hard = classifyMessage(customerMessage);
  const matchedTags = getEligibleReturningCustomerTags(context?.currentTags);

  // Non-text events (sticker, like, photo, pure link, empty): do nothing.
  // Never tag/escalate — wait for a real text message from the customer.
  if (!matchedTags.length && hard.intent === 'NON_TEXT') {
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

  if (['STORE_LOCATION_QUESTION', 'SHIPPING_QUESTION'].includes(hard.intent)) {
    return keywordSuggest(customerMessage, items);
  }

  if (!matchedTags.length && hard.contactState === 'COMPLETE') {
    // Parse clean contact data (offline, no geocoding) to attach for the admin.
    const contactInfo = extractContactInfo(customerMessage);
    const bits = [];
    if (contactInfo.phone) bits.push(`SĐT: ${contactInfo.phone}`);
    if (contactInfo.address) bits.push(`Địa chỉ: ${contactInfo.address}`);
    const detail = bits.length ? ` (${bits.join(' | ')})` : '';
    return {
      intent: hard.intent,
      action: 'TAG_BUY_AND_MARK_UNREAD',
      bestShortcut: null,
      confidence: 1,
      reason: `Khách gửi SĐT/địa chỉ, cần chủ shop xử lý${detail}`,
      contactInfo,
      topSuggestions: [],
      shouldSend: false,
      shouldEscalate: true
    };
  }

  if (!matchedTags.length && ['PHONE_ONLY', 'ADDRESS_ONLY', 'INCOMPLETE_ADDRESS'].includes(hard.contactState)) {
    return keywordSuggest(customerMessage, items);
  }

  if (matchedTags.length) {
    const policyMessage = selectLastCustomerText(history, customerMessage);
    const policyHard = classifyMessage(policyMessage);
    if (policyHard.intent === 'NON_TEXT') {
      return {
        intent: 'NON_TEXT',
        action: 'SKIP',
        bestShortcut: null,
        confidence: 0,
        reason: 'Khách gửi nội dung không phải văn bản - bỏ qua',
        topSuggestions: [],
        shouldSend: false,
        shouldEscalate: false
      };
    }
    const explicitCandidate = detectExplicitRepurchase(policyMessage);
    const blocker = getRepurchaseBlocker(policyMessage, { ignoreCourtesy: explicitCandidate });
    if (blocker) {
      return returningSkipResult(blocker, 'Khách khiếu nại hoặc từ chối, không gửi sale');
    }
    if (['BUY_INTENT_HIGH', 'PHONE_DETECTED', 'ADDRESS_DETECTED', 'ADDRESS_INCOMPLETE'].includes(policyHard.intent)) {
      return returningSkipResult(policyHard.intent, 'Khách gửi thông tin liên hệ nhưng chưa xác nhận mua lại');
    }

    const ruleCandidate = explicitCandidate || isShortRepurchaseConfirmation(policyMessage);
    if (ruleCandidate) {
      return explicitRepurchaseResult(matchedTags);
    }

    const configuredMinimum = Number(settings.minConfidence);
    const minimumConfidence = Number.isFinite(configuredMinimum) ? configuredMinimum : 0.75;

    try {
      const text = await callAI(buildPrompt(policyMessage, items, context, examples, history), settings);
      const parsed = safeJsonParse(text);
      if (!parsed) throw new Error('AI returned invalid JSON');

      const aiFollowUp = returningAIDecision(items, parsed, minimumConfidence);
      return aiFollowUp.action === 'SUGGEST_SHORTCUT'
        ? aiFollowUp
        : returningFallbackResult(items);
    } catch (error) {
      return returningFallbackResult(items);
    }

  }

  if (!items.length) {
    return {
      intent: hard.intent,
      action: 'WAITING_REVIEW',
      bestShortcut: null,
      confidence: 0,
      reason: 'Chưa có shortcut trong shortcuts.json',
      topSuggestions: [],
      shouldSend: false,
      shouldEscalate: true
    };
  }

  const fallback = keywordSuggest(customerMessage, items);
  try {
    const text = await callAI(buildPrompt(customerMessage, items, context, examples, history), settings);
    const parsed = safeJsonParse(text);
    if (!parsed) throw new Error('OpenAI trả JSON không hợp lệ');

    const shortcutValidation = validateShortcutOnly({
      shortcut: parsed.bestShortcut || parsed.shortcut,
      confidence: parsed.confidence,
      reason: parsed.reason
    }, items);

    const topSuggestions = validateTopSuggestions(parsed.topSuggestions || [], items);
    const bestShortcut = shortcutValidation.shortcut;
    const confidence = shortcutValidation.shortcut ? shortcutValidation.confidence : 0;

    if (parsed.action === 'TAG_BUY_AND_MARK_UNREAD' && hard.contactState !== 'COMPLETE') {
      return { ...fallback, reason: `${fallback.reason} | AI action bị chặn vì thông tin nhận hàng chưa đầy đủ` };
    }

    const action = parsed.action
      ? parsed.action === 'SUGGEST_SHORTCUT' && bestShortcut ? 'SUGGEST_SHORTCUT' : 'WAITING_REVIEW'
      : bestShortcut ? 'SUGGEST_SHORTCUT' : 'WAITING_REVIEW';
    const allowedShortcut = action === 'SUGGEST_SHORTCUT' ? bestShortcut : null;

    return {
      intent: parsed.intent || hard.intent || 'UNKNOWN',
      action,
      bestShortcut: allowedShortcut,
      confidence: allowedShortcut ? confidence : 0,
      reason: shortcutValidation.reason || parsed.reason || fallback.reason,
      topSuggestions: topSuggestions.length ? topSuggestions : fallback.topSuggestions,
      shouldSend: false,
      shouldEscalate: Boolean(parsed.shouldEscalate) || !allowedShortcut
    };
  } catch (error) {
    return { ...fallback, reason: `${fallback.reason} | OpenAI lỗi/fallback: ${error.message}` };
  }
}

module.exports = {
  analyzeMessageWithAI,
  buildPrompt,
  selectLastCustomerText,
  safeJsonParse,
  extractResponseText,
  resolveAIConfig,
  summarizeAIConfig,
  testAIConnection
};
