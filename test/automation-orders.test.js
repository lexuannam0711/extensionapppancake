const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAutomation(orderLink, isAllowedAutomationUrl = () => true) {
  const document = {
    querySelector(selector) {
      if (selector === '.link-order-list') return orderLink;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const window = {
    PDBPancakeDom: {
      classifyPancakePage: () => ({ kind: 'chat', isChatPage: true }),
      collectUnreadConversations: () => ({ rawCount: 0, items: [], malformedCount: 0, degraded: false }),
      findConversationElementById: () => null,
      clickConversationById: () => ({ ok: false })
    },
    PDBPancakeUrlPolicy: { isAllowedAutomationUrl }
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../src/renderer/automation.js'), 'utf8'),
    {
      window,
      document,
      location: { href: 'https://pancake.vn/multi_pages' },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      setTimeout,
      Event: class Event {},
      KeyboardEvent: class KeyboardEvent {},
      HTMLTextAreaElement: class Event {},
      HTMLInputElement: class Event {},
      console
    }
  );
  return window.__PDB__;
}

function orderLink({ href = '', textContent = 'Đơn hàng (2)', click = () => {} } = {}) {
  return {
    href,
    textContent,
    click,
    getBoundingClientRect: () => ({ width: 120, height: 24 })
  };
}

test('openCustomerOrders returns the trusted order URL without clicking an unrelated control', () => {
  let clicks = 0;
  const automation = loadAutomation(orderLink({
    href: 'https://pancake.vn/orders/customer-1',
    click: () => { clicks += 1; }
  }));

  assert.deepEqual(JSON.parse(JSON.stringify(automation.openCustomerOrders())), {
    ok: true,
    mode: 'url',
    url: 'https://pancake.vn/orders/customer-1',
    orderCount: 2
  });
  assert.equal(clicks, 0);
});

test('openCustomerOrders clicks the order panel when Pancake exposes no URL', () => {
  let clicks = 0;
  const automation = loadAutomation(orderLink({ click: () => { clicks += 1; } }));

  assert.deepEqual(JSON.parse(JSON.stringify(automation.openCustomerOrders())), {
    ok: true,
    mode: 'panel',
    url: '',
    orderCount: 2
  });
  assert.equal(clicks, 1);
});

test('openCustomerOrders fails closed when the customer order control is absent', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(loadAutomation(null).openCustomerOrders())), {
    ok: false,
    code: 'ORDER_CONTROL_NOT_FOUND',
    orderCount: 0
  });
});

test('openCustomerOrders does not click or return an untrusted order URL', () => {
  let clicks = 0;
  const automation = loadAutomation(
    orderLink({ href: 'https://evil.example/orders', click: () => { clicks += 1; } }),
    () => false
  );

  assert.deepEqual(JSON.parse(JSON.stringify(automation.openCustomerOrders())), {
    ok: false,
    code: 'ORDER_URL_UNTRUSTED',
    orderCount: 2
  });
  assert.equal(clicks, 0);
});
