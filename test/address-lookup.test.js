const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAddressQuery,
  buildGoogleMapsSearchUrl,
  buildAddressLookup
} = require('../src/server/addressLookup');

test('address lookup: builds Google Maps URL for Vietnamese address text', () => {
  const result = buildAddressLookup({
    message: 'ship về phường 3 quận 8 thành phố hồ chí minh',
    customerName: 'Anh Nam'
  });

  assert.equal(result.rawAddress, 'phường 3 quận 8 thành phố hồ chí minh');
  assert.equal(result.query, 'phường 3 quận 8 thành phố hồ chí minh, Việt Nam');
  assert.equal(result.confidence, 'high');
  assert.match(result.googleMapsUrl, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  assert.ok(decodeURIComponent(result.googleMapsUrl).includes('phường 3 quận 8'));
});

test('address lookup: strips phone number from query', () => {
  const result = buildAddressLookup({
    message: 'mình lấy 1 hộp, sđt 0912345678, địa chỉ phường 3 quận 8',
    phone: '0912345678'
  });

  assert.equal(result.phone, '0912345678');
  assert.equal(result.rawAddress, 'địa chỉ phường 3 quận 8');
  assert.equal(result.query.includes('0912345678'), false);
  assert.equal(result.googleMapsUrl.includes('0912345678'), false);
});

test('address lookup: weak address still returns low confidence search URL', () => {
  const query = normalizeAddressQuery('gần chợ trung tâm', '');
  const url = buildGoogleMapsSearchUrl(query);

  assert.equal(query, 'gần chợ trung tâm, Việt Nam');
  assert.match(url, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
});
