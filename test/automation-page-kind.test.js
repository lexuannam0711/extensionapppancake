const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pancakeDom = require('../src/renderer/pancakeDom');
const pancakeUrlPolicy = require('../src/renderer/pancakeUrlPolicy');

function loadAutomationAtPancakeRoot({ documentOverride } = {}) {
  const chatShellSelector = '.conversation-list-item, #messageCol, .message-list, textarea#replyBoxComposer';
  const document = documentOverride || {
    querySelector(selector) {
      if (selector === chatShellSelector || selector === 'textarea#replyBoxComposer') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    }
  };
  const window = {
    PDBPancakeDom: pancakeDom,
    PDBPancakeUrlPolicy: pancakeUrlPolicy
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../src/renderer/automation.js'), 'utf8'),
    {
      window,
      document,
      location: { href: 'https://pancake.vn/' },
      URL,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      setTimeout,
      Event: class Event {},
      KeyboardEvent: class KeyboardEvent {},
      HTMLTextAreaElement: class HTMLTextAreaElement {},
      HTMLInputElement: class HTMLInputElement {},
      console
    }
  );
  return window.__PDB__;
}

test('automation status uses the shared DOM classifier for the Pancake root chat shell', async () => {
  const status = await loadAutomationAtPancakeRoot().getDomStatus();

  assert.equal(status.pageKind, 'chat');
  assert.equal(status.isChatPage, true);
  assert.notEqual(status.health.level, 'FAIL');
  assert.doesNotMatch(status.health.missing.join(','), /wrong_page/);
});

test('finds Pancake new Mail Unread action button', () => {
  let clicks = 0;
  const path = { getAttribute: (name) => name === 'd' ? 'M17.1591 7.47782' : '' };
  const button = {
    getBoundingClientRect: () => ({ width: 20, height: 20 }),
    querySelector: (selector) => selector === 'path' ? path : null,
    click: () => { clicks += 1; }
  };
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector) => selector === '.conv-action-btn' ? [button] : [],
    getElementById: () => null
  };
  const automation = loadAutomationAtPancakeRoot({ documentOverride: document });

  assert.equal(automation.findMarkUnreadButton(), true);
  return automation.markCurrentConversationUnread().then((result) => {
    assert.equal(result.ok, true);
    assert.equal(clicks, 1);
  });
});
