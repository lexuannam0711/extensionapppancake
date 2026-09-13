const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isBlankWebviewUrl,
  shouldLazyLoadWebview
} = require('../src/renderer/webviewTabNavigation');

test('blank webview URLs include empty values and about:blank', () => {
  assert.equal(isBlankWebviewUrl(''), true);
  assert.equal(isBlankWebviewUrl(null), true);
  assert.equal(isBlankWebviewUrl('about:blank'), true);
  assert.equal(isBlankWebviewUrl(' ABOUT:BLANK '), true);
  assert.equal(isBlankWebviewUrl('https://pancake.vn/multi_pages'), false);
});

test('an unloaded about:blank tab should lazy-load when activated', () => {
  const tab = {
    webview: {},
    loaded: false,
    loadState: 'idle'
  };

  assert.equal(shouldLazyLoadWebview(tab, 'about:blank'), true);
});

test('a currently loading tab is not lazy-loaded again', () => {
  const tab = {
    webview: { isLoading: () => true },
    loaded: false,
    loadState: 'loading'
  };

  assert.equal(shouldLazyLoadWebview(tab, 'about:blank'), false);
});

test('a loaded about:blank tab still lazy-loads when activated', () => {
  assert.equal(shouldLazyLoadWebview({
    webview: {},
    loaded: true,
    loadState: 'loaded'
  }, 'about:blank'), true);
});

test('a tab with a real URL is not lazy-loaded', () => {
  assert.equal(shouldLazyLoadWebview({
    webview: {},
    loaded: false,
    loadState: 'idle'
  }, 'https://pancake.vn/multi_pages'), false);
});
