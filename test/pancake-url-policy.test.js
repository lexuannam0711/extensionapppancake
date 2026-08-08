const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PANCAKE_CHAT_URL,
  PANCAKE_MULTI_PAGES_URL,
  PANCAKE_LOGIN_URL,
  DEFAULT_PANCAKE_URL,
  classifyPancakeUrl,
  isAllowedAutomationUrl,
  normalizeBotUrl,
  resolveChatEntryUrl,
  resolvePreferredPancakeUrl
} = require('../src/renderer/pancakeUrlPolicy');

test('classifies only exact HTTPS default-port Pancake app hosts as app', () => {
  for (const url of [
    'https://pancake.vn/',
    'https://pancake.vn:443/',
    'https://www.pancake.vn/multi_pages?tab=inbox#latest',
    'https://pages.fm/inbox',
    'https://www.pages.fm/'
  ]) assert.equal(classifyPancakeUrl(url), 'app', url);
});

test('classifies exact login-provider hosts as auth without granting automation', () => {
  for (const url of [
    'https://account.pancake.vn/login',
    'https://facebook.com/login',
    'https://www.facebook.com/dialog/oauth'
  ]) {
    assert.equal(classifyPancakeUrl(url), 'auth', url);
    assert.equal(isAllowedAutomationUrl(url), false, url);
  }
});

test('rejects deceptive hosts, credentials, non-HTTPS URLs, and non-default ports', () => {
  for (const url of [
    'http://pancake.vn/',
    'https://pancake.vn:444/',
    'https://evil.pancake.vn/',
    'https://pancake.vn.evil.example/',
    'https://pancake.vn@evil.example/',
    'https://user:password@pancake.vn/',
    'file:///C:/secret.txt',
    'javascript:alert(1)',
    'not a url'
  ]) {
    assert.equal(classifyPancakeUrl(url), 'untrusted', url);
    assert.equal(isAllowedAutomationUrl(url), false, url);
  }
});

test('automation compatibility helper allows every app candidate and only app candidates', () => {
  assert.equal(isAllowedAutomationUrl('https://pancake.vn/'), true);
  assert.equal(isAllowedAutomationUrl('https://pancake.vn/dashboard'), true);
  assert.equal(isAllowedAutomationUrl('https://pages.fm/inbox'), true);
});

test('preserves every trusted Pancake/Pages.fm route for bot context', () => {
  assert.equal(PANCAKE_MULTI_PAGES_URL, 'https://pancake.vn/multi_pages');
  assert.equal(PANCAKE_CHAT_URL, PANCAKE_MULTI_PAGES_URL);
  assert.equal(normalizeBotUrl('https://pages.fm/'), 'https://pages.fm/');
  assert.equal(normalizeBotUrl('https://pancake.vn/dashboard'), 'https://pancake.vn/dashboard');
});

test('preserves app deep links and never promotes auth or untrusted URLs', () => {
  assert.equal(normalizeBotUrl('https://pages.fm/inbox?tab=unread'), 'https://pages.fm/inbox?tab=unread');
  assert.equal(normalizeBotUrl('https://pancake.vn/dashboard/settings'), 'https://pancake.vn/dashboard/settings');
  assert.equal(normalizeBotUrl('https://pancake.vn/multi_pages?tab=inbox'), 'https://pancake.vn/multi_pages?tab=inbox');
  assert.equal(normalizeBotUrl('https://www.pancake.vn/multi_pages/inbox'), 'https://www.pancake.vn/multi_pages/inbox');
  assert.equal(normalizeBotUrl('https://pancake.vn/custom'), 'https://pancake.vn/custom');
  assert.equal(normalizeBotUrl('https://account.pancake.vn/login'), '');
  assert.equal(normalizeBotUrl('https://facebook.com/login'), '');
  assert.equal(normalizeBotUrl('https://evil.example/phishing'), '');
  assert.equal(normalizeBotUrl('not a url'), '');
});

test('resolves every trusted app route to the Pancake multi-pages entry', () => {
  assert.equal(resolveChatEntryUrl('https://pages.fm/features'), PANCAKE_MULTI_PAGES_URL);
  assert.equal(resolveChatEntryUrl('https://www.pages.fm/dashboard'), PANCAKE_MULTI_PAGES_URL);
  assert.equal(resolveChatEntryUrl('https://pancake.vn/features'), PANCAKE_MULTI_PAGES_URL);
  assert.equal(resolveChatEntryUrl(PANCAKE_MULTI_PAGES_URL), PANCAKE_MULTI_PAGES_URL);
  assert.equal(resolveChatEntryUrl('https://account.pancake.vn/login'), '');
  assert.equal(resolveChatEntryUrl('https://evil.example/features'), '');
});

test('exposes the trusted Pancake login entry without promoting app pages', () => {
  assert.equal(PANCAKE_LOGIN_URL, 'https://account.pancake.vn/login');
  assert.equal(classifyPancakeUrl(PANCAKE_LOGIN_URL), 'auth');
});

test('uses Pancake multi-pages as the safe default app URL', () => {
  assert.equal(DEFAULT_PANCAKE_URL, PANCAKE_MULTI_PAGES_URL);
  assert.equal(resolvePreferredPancakeUrl(''), DEFAULT_PANCAKE_URL);
  assert.equal(resolvePreferredPancakeUrl(undefined), DEFAULT_PANCAKE_URL);
});

test('always selects Pancake multi-pages for the three browser tabs', () => {
  assert.equal(resolvePreferredPancakeUrl('https://pancake.vn/'), DEFAULT_PANCAKE_URL);
  assert.equal(resolvePreferredPancakeUrl('https://pages.fm/'), DEFAULT_PANCAKE_URL);
  assert.equal(resolvePreferredPancakeUrl('https://pages.fm/features'), DEFAULT_PANCAKE_URL);
  assert.equal(resolvePreferredPancakeUrl(PANCAKE_MULTI_PAGES_URL), DEFAULT_PANCAKE_URL);
  assert.equal(resolvePreferredPancakeUrl('http://pancake.vn/'), DEFAULT_PANCAKE_URL);
  assert.equal(resolvePreferredPancakeUrl('https://evil.example/'), DEFAULT_PANCAKE_URL);
});
