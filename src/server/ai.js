const {
  classifyMessage,
  extractContactInfo
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

function normalizeAIProtocol(value, baseUrl = '') {
  const requested = String(value || '').trim().toLowerCase();
  if (requested === 'openai' || requested === 'gemini' || requested === 'antigravity') return requested;
  const rawUrl = String(baseUrl || '').toLowerCase();
  if (/\/interactions(?:\/|$)/.test(rawUrl) || /cloudcode-pa|v1internal/.test(rawUrl)) return 'antigravity';
  if (/generatecontent|generativelanguage\.googleapis\.com/.test(rawUrl)) return 'gemini';
  return 'openai';
}

function normalizeInteractionsUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return 'https://generativelanguage.googleapis.com/v1beta/interactions';
  const clean = raw.replace(/\/+$/, '');
  if (/\/interactions$/i.test(clean)) return clean;
  if (/\/v\d+(?:beta\d*)?$/i.test(clean)) return `${clean}/interactions`;
  return `${clean}/v1beta/interactions`;
}

function normalizeGeminiUrl(baseUrl, model, protocol) {
  const raw = String(baseUrl || '').trim();
  if (!raw) throw new Error('Thiếu AI base URL');
  const clean = raw.replace(/\/+$/, '');
  if (/:generatecontent$/i.test(clean)) return clean;
  if (/\/v1internal$/i.test(clean)) return `${clean}:generateContent`;
  if (protocol === 'antigravity' && !/\/v\d/.test(clean)) return `${clean}/v1internal:generateContent`;
  if (/\/models\/[^/]+$/i.test(clean)) return `${clean}:generateContent`;
  return `${clean}/models/${encodeURIComponent(model)}:generateContent`;
}

function isLegacyAntigravityUrl(baseUrl) {
  return /cloudcode-pa|\/v1internal|:generatecontent/i.test(String(baseUrl || ''));
}

function isNativeAntigravityUrl(baseUrl) {
  return /generativelanguage\.googleapis\.com|\/interactions(?:\/|$)/i.test(String(baseUrl || ''));
}

function isAntigravityAgentId(model) {
  return /^(?:antigravity|deep-research)-/i.test(String(model || '').trim());
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
  const storedProtocol = pickConfiguredValue(overrides.aiProtocol, settings.aiProtocol);
  const envProtocol = pickConfiguredValue(process.env.AI_PROTOCOL, 'auto');
  const protocolHint = pickConfiguredValue(storedProtocol, envProtocol);
  const envBaseUrl = pickConfiguredValue(
    process.env.AI_BASE_URL,
    protocolHint === 'openai' || protocolHint === 'auto' ? process.env.OPENAI_BASE_URL : ''
  );
  const protocol = normalizeAIProtocol(protocolHint, pickConfiguredValue(storedBaseUrl, envBaseUrl));
  const baseUrl = pickConfiguredValue(
    storedBaseUrl,
    envBaseUrl,
    protocol === 'antigravity' ? 'https://generativelanguage.googleapis.com/v1beta' :
      protocol === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' :
        'https://api.openai.com/v1'
  );
  const apiKey = pickConfiguredValue(
    storedApiKey,
    process.env.AI_API_KEY,
    protocol === 'gemini' || protocol === 'antigravity' ? process.env.GEMINI_API_KEY : process.env.OPENAI_API_KEY
  );
  const model = pickConfiguredValue(
    storedModel,
    process.env.AI_MODEL,
    protocol === 'gemini' || protocol === 'antigravity' ? process.env.GEMINI_MODEL : process.env.OPENAI_MODEL,
    protocol === 'antigravity' ? 'antigravity-preview-09-2026' :
      protocol === 'gemini' ? 'gemini-2.5-flash' : 'gpt-5-mini'
  );
  const transport = protocol === 'antigravity'
    ? (isLegacyAntigravityUrl(baseUrl)
      ? 'generate-content'
      : isNativeAntigravityUrl(baseUrl) || !/\/v\d+(?:beta\d*)?(?:\/|$)/i.test(baseUrl)
        ? 'interactions'
        : 'openai-chat')
    : protocol === 'gemini' ? 'generate-content' : 'openai-chat';

  return {
    baseUrl,
    apiKey,
    model,
    protocol,
    transport,
    chatUrl: transport === 'openai-chat'
      ? normalizeChatUrl(baseUrl)
      : transport === 'interactions'
        ? normalizeInteractionsUrl(baseUrl)
        : normalizeGeminiUrl(baseUrl, model, protocol),
    source: {
      baseUrl: storedBaseUrl ? 'settings' : 'env',
      apiKey: storedApiKey ? 'settings' : 'env',
      model: storedModel ? 'settings' : 'env',
      protocol: storedProtocol ? 'settings' : 'env'
    }
  };
}

function summarizeAIConfig(settings = {}, overrides = {}) {
  const config = resolveAIConfig(settings, overrides);
  return {
    aiBaseUrl: config.baseUrl,
    aiApiKeyMasked: maskSecret(config.apiKey),
    aiModel: config.model,
    aiProtocol: config.protocol,
    aiTransport: config.transport,
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
  const { currentTags: _currentTags, ...safeContext } =
    context && typeof context === 'object' ? context : {};
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

  const validIntents = 'GREETING, PRICE_QUESTION, PRODUCT_QUESTION, SHIPPING_QUESTION, STORE_LOCATION_QUESTION, USAGE_QUESTION, BUY_INTENT_LOW, BUY_INTENT_HIGH, PHONE_DETECTED, ADDRESS_DETECTED, ADDRESS_INCOMPLETE, REFUSAL, COMPLAINT, OUT_OF_SCOPE, UNKNOWN';

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
  ${historyBlock}${learnedBlock}

TIN KHÁCH (mới nhất): ${JSON.stringify(customerMessage)}
CONTEXT: ${JSON.stringify(safeContext)}
DANH SÁCH SHORTCUT: ${JSON.stringify(compactShortcuts)}`;
}

function readResponseText(value, depth = 0) {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const finalParts = value.filter((item) => !(item && typeof item === 'object' && (item.thought === true || item.type === 'thought')));
    const parts = finalParts.length ? finalParts : value;
    return parts.map((item) => readResponseText(item, depth + 1)).filter(Boolean).join('').trim();
  }
  if (typeof value !== 'object') return '';
  if (value.thought === true || value.type === 'thought') return '';

  for (const key of [
    'text', 'content', 'output_text', 'output', 'outputs', 'reasoning_content',
    'reasoning', 'reasoningContent', 'parts', 'steps', 'message', 'result',
    'data', 'interaction', 'choices', 'candidates', 'response'
  ]) {
    const text = readResponseText(value[key], depth + 1);
    if (text) return text;
  }
  return '';
}

function extractResponseText(payload) {
  if (!payload || typeof payload !== 'object') return '';

  // OpenAI-compatible chat responses, including gateways that put the answer
  // in reasoning_content when message.content is empty.
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    for (const candidate of [
      choice?.message?.content,
      choice?.message?.reasoning_content,
      choice?.message?.reasoningContent,
      choice?.text,
      choice?.delta?.content
    ]) {
      const text = readResponseText(candidate);
      if (text) return text;
    }
  }

  // Gemini-compatible responses used by some model gateways.
  const candidates = [
    ...(Array.isArray(payload.candidates) ? payload.candidates : []),
    ...(Array.isArray(payload.response?.candidates) ? payload.response.candidates : [])
  ];
  for (const candidate of candidates) {
    const text = readResponseText(candidate?.content || candidate?.text);
    if (text) return text;
  }

  // Antigravity Interactions responses expose assistant output in steps.
  const steps = [
    ...(Array.isArray(payload.steps) ? payload.steps : []),
    ...(Array.isArray(payload.response?.steps) ? payload.response.steps : [])
  ];
  for (const step of steps.slice().reverse()) {
    if (step?.type && !['model_output', 'assistant', 'response'].includes(step.type)) continue;
    const text = readResponseText(step?.content || step?.output || step?.text);
    if (text) return text;
  }

  // Interactions outputs and Responses API-compatible gateways.
  for (const candidate of [
    payload.outputs,
    payload.output_text,
    payload.output,
    payload.response?.outputs,
    payload.response,
    payload.interaction,
    payload.data,
    payload.result,
    payload.message,
    payload.content,
    payload.text
  ]) {
    const text = readResponseText(candidate);
    if (text) return text;
  }
  return '';
}

async function callAI(prompt, settings = {}, overrides = {}, transportOptions = {}) {
  const config = resolveAIConfig(settings, overrides);
  if (!config.apiKey) throw new Error('Thiếu AI API key');
  if (!config.baseUrl) throw new Error('Thiếu AI base URL');
  if (!config.model) throw new Error('Thiếu AI model');

  let res;
  try {
    const isOpenAI = config.transport === 'openai-chat';
    const isInteractions = config.transport === 'interactions';
    const isAntigravityAgent = isInteractions && isAntigravityAgentId(config.model);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    const body = isOpenAI
      ? {
          model: config.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 700,
          temperature: 0.2,
          stream: false
        }
      : isInteractions
        ? {
            ...(isAntigravityAgent ? { agent: config.model, environment: 'remote' } : { model: config.model }),
            input: prompt,
            store: false,
            stream: false
          }
      : {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 700,
            temperature: 0.2
          }
        };

    if (isOpenAI) headers.Authorization = `Bearer ${config.apiKey}`;
    else if (isInteractions || config.protocol === 'gemini') headers['x-goog-api-key'] = config.apiKey;
    else headers.Authorization = `Bearer ${config.apiKey}`;

    res = await requestJsonCompat(config.chatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(isOpenAI || isInteractions ? body : config.protocol === 'antigravity' ? { model: config.model, ...body } : body)
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
  if (!text) {
    const responseKeys = payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : [];
    const suffix = responseKeys.length ? ` (fields: ${responseKeys.join(', ')})` : '';
    const error = new Error(`AI không trả về nội dung trong response${suffix}`);
    error.code = 'AI_EMPTY_RESPONSE';
    error.upstreamStatus = res.status;
    error.responseKeys = responseKeys;
    throw error;
  }
  if (!safeJsonParse(text)) {
    const error = new Error('AI trả về nội dung không phải JSON hợp lệ');
    error.code = 'AI_INVALID_RESPONSE';
    error.upstreamStatus = res.status;
    throw error;
  }
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

  if (['STORE_LOCATION_QUESTION', 'SHIPPING_QUESTION'].includes(hard.intent)) {
    return keywordSuggest(customerMessage, items);
  }

  if (hard.contactState === 'COMPLETE') {
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

  if (['PHONE_ONLY', 'ADDRESS_ONLY', 'INCOMPLETE_ADDRESS', 'INCOMPLETE_CONTACT'].includes(hard.contactState)) {
    return keywordSuggest(customerMessage, items);
  }

  if (!items.length) {
    return {
      intent: hard.intent,
      action: 'SKIP',
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
    if (!parsed) throw new Error('AI trả JSON không hợp lệ');

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

    const action = parsed.action === 'SUGGEST_SHORTCUT' && bestShortcut
      ? 'SUGGEST_SHORTCUT'
      : 'SKIP';
    const allowedShortcut = action === 'SUGGEST_SHORTCUT' ? bestShortcut : null;

    return {
      intent: parsed.intent || hard.intent || 'UNKNOWN',
      action,
      bestShortcut: allowedShortcut,
      confidence: allowedShortcut ? confidence : 0,
      reason: shortcutValidation.reason || parsed.reason || fallback.reason,
      topSuggestions: topSuggestions.length ? topSuggestions : fallback.topSuggestions,
      shouldSend: false,
      shouldEscalate: action === 'SUGGEST_SHORTCUT' && Boolean(parsed.shouldEscalate)
    };
  } catch (error) {
    return { ...fallback, reason: `${fallback.reason} | AI lỗi/fallback: ${error.message}` };
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
