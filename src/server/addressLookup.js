const { extractContactInfo } = require('./rules');

function stripPhoneFragments(text, phone = '') {
  let result = String(text || '');
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits) {
    const loose = digits.split('').join('[\\s.\\-]*');
    result = result.replace(new RegExp(loose, 'g'), ' ');
  }
  return result.replace(/0[35789][\d.\-\s]{8,}/g, ' ');
}

function hasVietnamHint(text) {
  return /\b(việt\s*nam|viet\s*nam|vn)\b/i.test(String(text || ''));
}

function normalizeAddressQuery(address, phone = '') {
  const withoutPhone = stripPhoneFragments(address, phone);
  const cleaned = withoutPhone
    .replace(/[|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return hasVietnamHint(cleaned) ? cleaned : `${cleaned}, Việt Nam`;
}

function buildGoogleMapsSearchUrl(query) {
  const q = String(query || '').trim();
  if (!q) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function resolveConfidence(rawAddress, addressValid) {
  const s = String(rawAddress || '').toLowerCase();
  const units = ['xã', 'phường', 'huyện', 'quận', 'tỉnh', 'thành phố', 'thị xã', 'thị trấn'];
  const unitHits = units.filter((unit) => s.includes(unit)).length;
  if (addressValid && unitHits >= 2) return 'high';
  if (addressValid || unitHits >= 1) return 'medium';
  return 'low';
}

function buildAddressLookup({ message = '', customerName = '', phone = '' } = {}) {
  const contact = extractContactInfo(message);
  const rawAddress = String(contact.address || '').trim();
  const resolvedPhone = String(phone || contact.phone || '').trim();
  const query = normalizeAddressQuery(rawAddress, resolvedPhone);
  const googleMapsUrl = buildGoogleMapsSearchUrl(query);
  const confidence = resolveConfidence(rawAddress, contact.addressValid);
  const note = confidence === 'high'
    ? 'Địa chỉ có đủ đơn vị hành chính, nên link Google Maps có khả năng gần đúng cao.'
    : confidence === 'medium'
      ? 'Địa chỉ có dấu hiệu hợp lệ; admin nên mở Google Maps để kiểm tra lại tên xã/phường mới.'
      : 'Địa chỉ còn thiếu thông tin; link Google Maps chỉ dùng để tìm kiếm nhanh.';

  return {
    rawAddress,
    query,
    googleMapsUrl,
    confidence,
    note,
    customerName: String(customerName || '').trim(),
    phone: resolvedPhone
  };
}

module.exports = {
  normalizeAddressQuery,
  buildGoogleMapsSearchUrl,
  buildAddressLookup
};
