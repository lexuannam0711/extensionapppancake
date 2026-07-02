const { classifyMessage, extractContactInfo } = require('./rules');
const { keywordSuggest } = require('./shortcutMatcher');
const { validateShortcutOnly, validateTopSuggestions } = require('./validators');

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
    aiApiKey: pickConfiguredValue(overrides.aiApiKey, settings.aiApiKey, process.env.AI_API_KEY, process.env.OPENAI_API_KEY),
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

function buildPrompt(customerMessage, shortcuts, context, examples = [], history = []) {
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

  const historyBlock = (Array.isArray(history) && history.length)
    ? `\n\nLỊCH SỬ HỘI THOẠI (cũ → mới, "admin" là shop, "customer" là khách). Dùng để hiểu ngữ cảnh và giai đoạn của khách:\n${JSON.stringify(history)}`
    : '';

  // Order status (from Pancake info panel) — tells whether the customer bought.
  const order = context && context.orderStatus;
  const orderBlock = (order && order.hasOrdered)
    ? `\n\nTRẠNG THÁI ĐƠN HÀNG: Khách ĐÃ CÓ ${order.orderCount} đơn (trạng thái mới nhất: ${order.latestStatus || 'không rõ'}). Đây là khách ĐÃ MUA — ưu tiên chăm sóc sau bán (hỏi tình trạng sử dụng, hướng dẫn dùng, giải đáp), KHÔNG tư vấn/chốt đơn lại từ đầu.`
    : '';

  return `Bạn là bộ phân tích tin nhắn khách hàng và chọn shortcut cho Pancake.

QUY TẮC TUYỆT ĐỐI:
- Chỉ chọn shortcut có trong danh sách.
- Không bịa shortcut mới.
- Không viết câu trả lời gửi khách.
- Trả về JSON hợp lệ, không markdown.
- Nếu có số điện thoại hoặc địa chỉ: bestShortcut=null, shouldEscalate=true, action=TAG_BUY_AND_MARK_UNREAD.

CÁCH PHÂN TÍCH (suy luận theo thứ tự rồi mới chọn):
1. Đọc LỊCH SỬ HỘI THOẠI để hiểu khách đã hỏi gì, shop đã trả gì.
2. Xác định giai đoạn của khách: MỚI (chưa hỏi gì) / ĐANG CÂN NHẮC (đã hỏi giá/sản phẩm) / SẮP MUA (hỏi cách đặt, để lại thông tin).
3. Chọn shortcut khớp với TIN MỚI NHẤT và giai đoạn đó, tránh lặp lại shortcut shop vừa gửi.

INTENT hợp lệ: GREETING, PRICE_QUESTION, PRODUCT_QUESTION, SHIPPING_QUESTION, USAGE_QUESTION, BUY_INTENT_LOW, BUY_INTENT_HIGH, PHONE_DETECTED, ADDRESS_DETECTED, REFUSAL, COMPLAINT, OUT_OF_SCOPE, UNKNOWN.

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
${historyBlock}${orderBlock}${learnedBlock}

TIN KHÁCH (mới nhất): ${JSON.stringify(customerMessage)}
CONTEXT: ${JSON.stringify(context || {})}
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

async function callAI(prompt, settings = {}, overrides = {}) {
  const config = resolveAIConfig(settings, overrides);
  if (!config.apiKey) throw new Error('Thiếu AI API key');
  if (!config.baseUrl) throw new Error('Thiếu AI base URL');
  if (!config.model) throw new Error('Thiếu AI model');

  const res = await fetch(config.chatUrl, {
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
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload?.error?.message || payload?.error || `${res.status} ${res.statusText}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  const text = extractResponseText(payload);
  if (!text) throw new Error('AI không trả về nội dung (choices[].message.content rỗng)');
  return text;
}

async function testAIConnection(settings = {}, overrides = {}) {
  const text = await callAI('Trả về đúng JSON này và không thêm gì khác: {"ok":true}', settings, overrides);
  const parsed = safeJsonParse(text);
  if (!parsed?.ok) throw new Error(`AI test trả về không hợp lệ: ${text}`);
  return {
    ok: true,
    message: 'Kết nối AI thành công',
    config: summarizeAIConfig(settings, overrides)
  };
}

async function analyzeMessageWithAI({ customerMessage, shortcuts, context = {}, settings = {}, examples = [], history = [] }) {
  const items = Array.isArray(shortcuts) ? shortcuts : [];
  const hard = classifyMessage(customerMessage);

  // Non-text events (sticker, like, photo, pure link, empty): do nothing.
  // Never tag/escalate — wait for a real text message from the customer.
  if (hard.intent === 'NON_TEXT') {
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

  if (['BUY_INTENT_HIGH', 'PHONE_DETECTED', 'ADDRESS_DETECTED'].includes(hard.intent)) {
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

    return {
      intent: parsed.intent || hard.intent || 'UNKNOWN',
      action: parsed.action || (bestShortcut ? 'SUGGEST_SHORTCUT' : 'WAITING_REVIEW'),
      bestShortcut,
      confidence,
      reason: shortcutValidation.reason || parsed.reason || fallback.reason,
      topSuggestions: topSuggestions.length ? topSuggestions : fallback.topSuggestions,
      shouldSend: false,
      shouldEscalate: Boolean(parsed.shouldEscalate) || !bestShortcut
    };
  } catch (error) {
    return { ...fallback, reason: `${fallback.reason} | OpenAI lỗi/fallback: ${error.message}` };
  }
}

module.exports = {
  analyzeMessageWithAI,
  buildPrompt,
  safeJsonParse,
  extractResponseText,
  resolveAIConfig,
  summarizeAIConfig,
  testAIConnection
};
