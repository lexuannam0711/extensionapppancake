const test = require('node:test');
const assert = require('node:assert/strict');

const { isAllowedGuestNavigation, resolveGuestNavigation } = require('../src/guestSecurity');

test('guest navigation allows only Pancake and Facebook HTTPS origins', () => {
  for (const url of [
    'https://pancake.vn/',
    'https://pancake.vn:443/',
    'https://pancake.vn/multi_pages',
    'https://pages.fm/inbox',
    'https://account.pancake.vn/login',
    'https://facebook.com/login',
    'https://www.facebook.com/dialog/oauth'
  ]) assert.equal(isAllowedGuestNavigation(url), true, url);

  for (const url of [
    'http://pancake.vn/multi_pages',
    'https://pancake.vn:444/',
    'https://evil.pancake.vn/',
    'https://account.pancake.vn.evil.example/login',
    'https://user:password@pancake.vn/',
    'https://evil.example/',
    'file:///C:/secret.txt',
    'javascript:alert(1)',
    'data:text/html,hello'
  ]) assert.equal(isAllowedGuestNavigation(url), false, url);
});

test('guest navigation keeps Pancake login in the same webview', () => {
  assert.deepEqual(resolveGuestNavigation('https://account.pancake.vn/login'), {
    action: 'same-webview', kind: 'pancake-auth'
  });
  assert.deepEqual(resolveGuestNavigation('https://pages.fm/login'), {
    action: 'same-webview', kind: 'pancake-auth'
  });
});

test('guest navigation opens Facebook auth as a popup', () => {
  assert.deepEqual(resolveGuestNavigation('https://www.facebook.com/dialog/oauth'), {
    action: 'popup', kind: 'external-auth'
  });
});
