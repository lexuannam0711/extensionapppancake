const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pancakeDom = require('../src/renderer/pancakeDom');
const pancakeUrlPolicy = require('../src/renderer/pancakeUrlPolicy');

function loadAutomationAtPancakeRoot() {
  const chatShellSelector = '.conversation-list-item, #messageCol, .message-list, textarea#replyBoxComposer';
  const document = {
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
