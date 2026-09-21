function normalizeText(text) {
  return String(text || '').toLowerCase().normalize('NFC').trim();
}

function foldVietnameseText(text) {
  return normalizeText(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');
}

function normalizeVietnameseText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function includesVietnameseKeyword(text, keywords) {
  const normalized = normalizeText(text);
  const folded = foldVietnameseText(text);
  return keywords.some((keyword) => normalized.includes(keyword) || folded.includes(foldVietnameseText(keyword)));
}

const ADDRESS_MAIN_MARKERS = ['thôn', 'xã', 'phường', 'thị trấn', 'huyện', 'quận', 'thị xã', 'tỉnh', 'thành phố'];
const ADDRESS_EXPLICIT_MARKERS = ['địa chỉ', 'đ/c', 'đc '];
const ADDRESS_CITY_ABBREVIATIONS = ['hn', 'hcm', 'tphcm', 'sg', 'hp'];
const CENTRAL_CITY_NAMES = ['ha noi', 'ho chi minh', 'hai phong', 'da nang', 'can tho'];
const PHONE_LABEL_MARKERS = ['số điện thoại', 'sđt', 'sdt'];
const ADDRESS_LABEL_MARKERS = ['địa chỉ'];

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasAddressCityAbbreviation(text) {
  const folded = foldVietnameseText(text);
  return ADDRESS_CITY_ABBREVIATIONS.some((abbr) => new RegExp(`(^|[^a-z0-9])${escapeRegex(abbr)}($|[^a-z0-9])`).test(folded));
}

function getMainAddressMarkerHits(text) {
  return ADDRESS_MAIN_MARKERS.filter((marker) => includesVietnameseKeyword(text, [marker]));
}

function hasLabeledPhrase(text, phrases) {
  const normalized = normalizeVietnameseText(stripUrls(text)).replace(/[^a-z0-9]+/g, ' ').trim();
  return phrases.some((phrase) => ` ${normalized} `.includes(` ${normalizeVietnameseText(phrase)} `));
}

function hasPhoneLabel(text) {
  return hasLabeledPhrase(text, PHONE_LABEL_MARKERS);
}

function hasAddressLabel(text) {
  return hasLabeledPhrase(text, ADDRESS_LABEL_MARKERS);
}

function hasExplicitAddressMarker(text) {
  return includesVietnameseKeyword(text, ADDRESS_EXPLICIT_MARKERS);
}

function detectStoreLocationRequest(text) {
  const s = normalizeVietnameseText(stripUrls(text)).replace(/[^a-z0-9]+/g, ' ').trim();
  const locationCue = /\b(?:dia chi|vi tri|map|o dau|cho nao|noi ban|qua mua truc tiep)\b/.test(s);
  const storeCue = /\b(?:shop|nha thuoc|quay thuoc|cua hang|cong ty|cty|ben em)\b/.test(s);
  const requestCue = /\b(?:xin|cho|gui|o dau|cho nao|qua mua truc tiep)\b/.test(s);
  const customerSupply = /\bdia chi cua (?:em|anh|chi|minh)\b/.test(s) || hasCompleteAdministrativeAddress(text);
  return !customerSupply && locationCue && requestCue &&
    (storeCue || /\b(?:vi tri|map|o dau|cho nao|qua mua truc tiep)\b/.test(s));
}

function detectAddressMention(text) {
  const raw = stripUrls(text);
  const s = normalizeVietnameseText(raw).replace(/[^a-z0-9]+/g, ' ').trim();
  if (/\b(?:chua gui|khong co|chua co)\s+dia chi\b/.test(s)) return false;
  return hasExplicitAddressMarker(raw) || getMainAddressMarkerHits(raw).length > 0;
}

function hasCompleteAdministrativeAddress(text) {
  const s = normalizeVietnameseText(stripUrls(text)).replace(/[^a-z0-9]+/g, ' ').trim();
  if (!s) return false;
  const markerValue = '(?!(?:xa|phuong|thi tran|huyen|quan|thi xa|tinh|thanh pho|dia chi|sdt|so dien thoai|day du)\\b)[a-z0-9]+';
  const hasWard = new RegExp(`\\b(?:xa|phuong|thi tran)\\s+${markerValue}\\b`).test(s);
  const hasDistrict = new RegExp(`\\b(?:huyen|quan|thi xa)\\s+${markerValue}\\b`).test(s) ||
    new RegExp(`\\bthanh pho\\s+${markerValue}.*\\btinh\\s+${markerValue}\\b`).test(s);
  const hasProvince = new RegExp(`\\btinh\\s+${markerValue}\\b`).test(s) || hasAddressCityAbbreviation(s) ||
    CENTRAL_CITY_NAMES.some((city) => new RegExp(`\\b(?:thanh pho\\s+)?${city}\\b`).test(s));
  return hasWard && hasDistrict && hasProvince;
}

// Detect messages that are NOT real customer text: empty, stickers, likes,
// reactions, photos/files-only, or pure links. These must never be treated as
// an address/phone (which would wrongly tag "Mua hàng" + mark unread).
function isNonTextMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;

  const s = normalizeText(raw);

  // Pancake/Facebook system snippets for non-text events.
  const systemSnippets = [
    'đã gửi một nhãn dán', 'da gui mot nhan dan', 'nhãn dán', 'nhan dan', 'sticker',
    'đã gửi một biểu tượng', 'biểu tượng cảm xúc', 'đã bày tỏ cảm xúc', 'bay to cam xuc',
    'đã gửi một ảnh', 'đã gửi ảnh', 'da gui anh', 'đã gửi một video', 'đã gửi video',
    'đã gửi một tệp', 'đã gửi tệp', 'đã gửi một file', 'gửi một đính kèm', 'đính kèm',
    'đã thích', 'đã thả tim', 'đã bày tỏ', 'sent a sticker', 'sent a photo',
    'sent an attachment', 'liked a message', 'reacted to'
  ];
  if (systemSnippets.some((k) => s.includes(k))) return true;

  // Pure emoji / icon only (no letters or digits at all).
  if (!/[a-z0-9à-ỹ]/i.test(raw)) return true;

  // A single "like" thumbs-up or short reaction.
  if (/^(👍|❤️|😂|😍|😮|😢|😡|\+1|like)$/i.test(raw)) return true;

  // Pure link: the whole message is essentially just a URL.
  const withoutUrls = raw.replace(/https?:\/\/\S+|www\.\S+/gi, '').trim();
  if (raw !== withoutUrls && withoutUrls.length === 0) return true;

  return false;
}

// Strip URLs out before phone/address detection so digits inside links
// (IDs, timestamps) don't get misread as a phone number.
function stripUrls(text) {
  return String(text || '').replace(/https?:\/\/\S+|www\.\S+/gi, ' ');
}

function detectPhoneNumber(text) {
  const raw = stripUrls(text);
  const compact = raw.replace(/[^0-9]/g, '');
  const compactHit = /(?:^|[^0-9])(03|05|07|08|09)[0-9]{8}(?:$|[^0-9])/.test(compact);
  const separatedHit = /(?:^|\D)(0\s*[35789](?:[\s.\-]*\d){8})(?:\D|$)/.test(raw);
  return compactHit || separatedHit;
}

function detectAddress(text) {
  return detectAddressMention(text);
}

function detectPriceQuestion(text) {
  const s = normalizeText(text);
  return ['giá', 'bao nhiêu', 'nhiêu tiền', 'bn tiền', 'tiền', 'combo', 'liệu trình', 'mấy hộp'].some((k) => s.includes(k));
}

function detectGreeting(text) {
  const s = normalizeText(text);
  return /\b(hi|hello|chào|alo|shop|còn không|có không|tư vấn)\b/.test(s);
}

function detectShippingQuestion(text) {
  const s = normalizeText(text);
  return ['ship', 'vận chuyển', 'giao hàng', 'có giao', 'giao về', 'giao tới', 'bao lâu', 'phí giao', 'phí ship', 'cod'].some((k) => s.includes(k));
}

function detectDeliveryQuestion(text) {
  if (!detectShippingQuestion(text)) return false;
  const s = normalizeVietnameseText(text).replace(/[^a-z0-9]+/g, ' ').trim();
  return /\b(?:co giao|giao duoc khong|ship duoc khong|bao lau|phi giao|phi ship|mat may ngay|van chuyen|cod)\b/.test(s);
}

function detectBuyIntent(text) {
  const s = normalizeText(text);
  return ['đặt', 'mua', 'lấy', 'chốt', 'lên đơn', 'gửi hàng', 'ship cho', 'đơn hàng', 'muốn dùng'].some((k) => s.includes(k));
}

function detectRefusal(text) {
  const s = normalizeText(text);
  if (['không mua', 'chưa mua', 'để sau', 'không cần', 'đắt', 'suy nghĩ'].some((k) => s.includes(k))) return true;
  const folded = normalizeVietnameseText(text).replace(/[^a-z0-9]+/g, ' ').trim();
  return /^(?:da\s+)?cam on(?:\s+(?:shop|em|anh|chi))?(?:\s+nhe)?$/.test(folded);
}

function detectComplaint(text) {
  const s = normalizeText(text);
  return ['khiếu nại', 'lừa', 'hoàn tiền', 'không nhận', 'bực', 'tệ', 'chửi', 'sai hàng'].some((k) => s.includes(k));
}

// Extract a Vietnamese phone number, returning the digits or null.
function extractPhone(text) {
  const raw = stripUrls(text).replace(/[.\-\s]/g, '');
  const m = raw.match(/(0[35789]\d{8})/);
  return m ? m[1] : null;
}

// Extract a likely address span from free text. Heuristic + offline only:
// finds the segment around the first strong address keyword. Returns null if
// nothing address-like is present.
function extractAddress(text) {
  const cleaned = stripUrls(String(text || '')).replace(/\s+/g, ' ').trim();
  if (!cleaned || !detectAddress(cleaned)) return null;
  const lower = cleaned.toLowerCase();
  const folded = foldVietnameseText(cleaned);
  const markers = [...ADDRESS_EXPLICIT_MARKERS, ...ADDRESS_MAIN_MARKERS];
  let idx = -1;
  for (const mk of markers) {
    const at = lower.indexOf(mk);
    const foldedAt = folded.indexOf(foldVietnameseText(mk));
    const markerIdx = at >= 0 ? at : foldedAt;
    if (markerIdx >= 0 && (idx === -1 || markerIdx < idx)) idx = markerIdx;
  }
  if (idx === -1) return null;
  // Take from the marker to the end, trimmed; strip a trailing phone if present.
  let span = cleaned.slice(idx).replace(/0[35789][\d.\-\s]{8,}/g, '').trim();
  return span || null;
}

// Validate that an address span looks real (offline, no geocoding):
// it should contain at least one administrative-unit keyword that indicates
// a Vietnamese locality. Returns true/false.
function looksLikeRealAddress(address) {
  const s = normalizeText(address);
  if (!s || s.length < 6) return false;
  return hasCompleteAdministrativeAddress(address);
}

// Parse contact info out of a message: phone + address, with offline validity
// flags. Used to attach clean data when escalating to admin (no geocoding).
function extractContactInfo(text) {
  const phone = extractPhone(text);
  const address = extractAddress(text);
  const phoneLabel = hasPhoneLabel(text);
  const addressLabel = hasAddressLabel(text);
  const phoneValid = Boolean(phone);
  const addressValid = looksLikeRealAddress(address);
  return {
    phone,
    address,
    phoneValid,
    addressValid,
    phoneLabel,
    addressLabel,
    hasCompleteContact: phoneValid && addressValid && phoneLabel && addressLabel,
    hasContact: Boolean(phone || address)
  };
}

function classifyMessage(text) {
  // Non-text events (sticker, like, photo-only, pure link, empty) must NOT be
  // misread as address/phone. Return a dedicated intent and skip detection.
  if (isNonTextMessage(text)) {
    return { intent: 'NON_TEXT', hasPhone: false, hasAddress: false, addressRole: 'NONE', contactState: 'NONE' };
  }
  if (detectComplaint(text)) return { intent: 'COMPLAINT', hasPhone: false, hasAddress: false, addressRole: 'NONE', contactState: 'NONE' };
  if (detectRefusal(text)) return { intent: 'REFUSAL', hasPhone: false, hasAddress: false, addressRole: 'NONE', contactState: 'NONE' };
  if (detectStoreLocationRequest(text)) {
    return { intent: 'STORE_LOCATION_QUESTION', hasPhone: false, hasAddress: false, addressRole: 'STORE_LOCATION_REQUEST', contactState: 'NONE' };
  }
  if (detectDeliveryQuestion(text)) {
    return { intent: 'SHIPPING_QUESTION', hasPhone: false, hasAddress: false, addressRole: 'DELIVERY_QUESTION', contactState: 'NONE' };
  }
  const hasPhone = detectPhoneNumber(text);
  const hasAddress = detectAddressMention(text);
  const phoneLabel = hasPhoneLabel(text);
  const addressLabel = hasAddressLabel(text);
  const addressValid = hasAddress && hasCompleteAdministrativeAddress(text);
  const addressRole = hasAddress ? 'CUSTOMER_ADDRESS' : 'NONE';
  const contactState = hasPhone && phoneLabel && addressValid && addressLabel
    ? 'COMPLETE'
    : hasAddress && !addressValid
      ? 'INCOMPLETE_ADDRESS'
      : hasPhone && hasAddress
        ? 'INCOMPLETE_CONTACT'
    : hasPhone
        ? 'PHONE_ONLY'
        : addressValid
          ? 'ADDRESS_ONLY'
          : 'NONE';
  const result = { hasPhone, hasAddress, phoneLabel, addressLabel, addressValid, addressRole, contactState };
  if (contactState === 'COMPLETE') return { intent: 'BUY_INTENT_HIGH', ...result };
  if (contactState === 'PHONE_ONLY') return { intent: 'PHONE_DETECTED', ...result };
  if (contactState === 'ADDRESS_ONLY') return { intent: 'ADDRESS_DETECTED', ...result };
  if (contactState === 'INCOMPLETE_CONTACT') return { intent: 'ADDRESS_INCOMPLETE', ...result };
  if (contactState === 'INCOMPLETE_ADDRESS') return { intent: 'ADDRESS_INCOMPLETE', ...result };
  if (detectPriceQuestion(text)) return { intent: 'PRICE_QUESTION', ...result };
  if (detectBuyIntent(text)) return { intent: 'BUY_INTENT_LOW', ...result };
  if (detectGreeting(text)) return { intent: 'GREETING', ...result };
  return { intent: 'UNKNOWN', ...result };
}

module.exports = {
  normalizeText,
  normalizeVietnameseText,
  isNonTextMessage,
  stripUrls,
  detectPhoneNumber,
  detectAddress,
  hasPhoneLabel,
  hasAddressLabel,
  detectStoreLocationRequest,
  hasCompleteAdministrativeAddress,
  extractPhone,
  extractAddress,
  looksLikeRealAddress,
  extractContactInfo,
  detectPriceQuestion,
  detectGreeting,
  detectShippingQuestion,
  detectDeliveryQuestion,
  detectBuyIntent,
  detectRefusal,
  detectComplaint,
  classifyMessage
};
