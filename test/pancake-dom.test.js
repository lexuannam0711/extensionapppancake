const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyPancakePage,
  collectUnreadConversations,
  findConversationElementById,
  clickConversationById,
  readActiveTagNames
} = require('../src/renderer/pancakeDom');

function textNode(textContent) {
  return { textContent };
}

function conversationRow({
  id,
  name = '',
  snippet = '',
  tags = [],
  connected = true,
  display = 'block',
  visibility = 'visible',
  width = 320,
  height = 64,
  parseError = null
}) {
  const tagNodes = tags.map(textNode);
  const calls = { click: 0, scroll: 0 };
  const row = {
    id,
    isConnected: connected,
    __style: { display, visibility },
    __calls: calls,
    getBoundingClientRect() {
      return { width, height };
    },
    querySelector(selector) {
      if (parseError) throw parseError;
      if (selector === '.name-text') return textNode(name);
      if (selector === '.snippet-text') return textNode(snippet);
      return null;
    },
    querySelectorAll(selector) {
      if (parseError) throw parseError;
      if (selector === '.list-tags-conv .conversation_tags_item') return tagNodes;
      return [];
    },
    closest(selector) {
      return selector === '[id]' && id ? row : null;
    },
    scrollIntoView() {
      calls.scroll += 1;
    },
    click() {
      calls.click += 1;
    }
  };
  return row;
}

function fakeDocument(rows) {
  return {
    querySelectorAll(selector) {
      assert.equal(selector, '.conversation-list-item.unread');
      return rows;
    },
    getElementById(id) {
      return rows.find((row) => row.id === id) || null;
    },
    querySelector(selector) {
      if (!selector.startsWith('#')) return null;
      const id = selector.slice(1).replace(/\\(.)/g, '$1');
      return rows.find((row) => row.id === id) || null;
    }
  };
}

const domOptions = {
  getComputedStyle: (element) => element.__style
};

function pageDocument({ hasChatShell = false, forbidQuery = false } = {}) {
  const calls = [];
  return {
    calls,
    querySelector(selector) {
      if (forbidQuery) throw new Error('DOM must not be queried for this URL role');
      calls.push(selector);
      return hasChatShell ? {} : null;
    }
  };
}

function tagButton({
  name,
  active = false,
  display = 'block',
  visibility = 'visible',
  opacity = '1',
  width = 120,
  height = 32
}) {
  return {
    textContent: name,
    __style: { display, visibility, opacity },
    getBoundingClientRect() {
      return { width, height };
    },
    querySelector(selector) {
      return selector === '.ellipse' && active ? {} : null;
    }
  };
}

function tagDocument(buttons) {
  return {
    querySelectorAll(selector) {
      assert.equal(selector, '#listShowTags .btn-tag-item, .btn-tag-item');
      return buttons;
    }
  };
}

test('maps connected unread rows and reports raw, usable, malformed and degraded state', () => {
  const rows = [
    conversationRow({
      id: 'conv-1',
      name: '  Alice   Example ',
      snippet: ' Xin  chao ',
      tags: [' New ', 'Priority']
    }),
    conversationRow({ id: 'conv-2', name: 'Bob', snippet: 'Need help' })
  ];

  const result = collectUnreadConversations(fakeDocument(rows), domOptions);

  assert.deepEqual(result, {
    rawCount: 2,
    items: [
      {
        index: 0,
        id: 'conv-1',
        name: 'Alice Example',
        snippet: 'Xin chao',
        tags: ['New', 'Priority'],
        hasTags: true
      },
      {
        index: 1,
        id: 'conv-2',
        name: 'Bob',
        snippet: 'Need help',
        tags: [],
        hasTags: false
      }
    ],
    malformedCount: 0,
    degraded: false
  });
});

test('skips rows hidden by Pancake while retaining them in raw unread count', () => {
  const hidden = conversationRow({ id: 'hidden-conv', display: 'none' });

  const result = collectUnreadConversations(fakeDocument([hidden]), domOptions);

  assert.equal(result.rawCount, 1);
  assert.deepEqual(result.items, []);
  assert.equal(result.malformedCount, 0);
  assert.equal(result.degraded, true);
});

test('isolates detached and malformed rows instead of failing the whole scan', () => {
  const valid = conversationRow({ id: 'valid', name: 'Still available' });
  const detached = conversationRow({ id: 'detached', connected: false });
  const malformed = conversationRow({ id: 'broken', parseError: new Error('bad row DOM') });

  const result = collectUnreadConversations(
    fakeDocument([detached, malformed, valid]),
    domOptions
  );

  assert.equal(result.rawCount, 2);
  assert.equal(result.malformedCount, 2);
  assert.deepEqual(result.items.map((item) => item.id), ['valid']);
  assert.equal(result.degraded, false);
});

test('a stale conversation id never falls back to or clicks the first unread row', async () => {
  const live = conversationRow({ id: 'live-conv', name: 'Do not click me' });
  const document = fakeDocument([live]);

  assert.equal(findConversationElementById(document, 'stale-conv'), null);
  const result = await clickConversationById(document, 'stale-conv');

  assert.deepEqual(result, { ok: false, code: 'STALE_CONVERSATION' });
  assert.equal(live.__calls.scroll, 0);
  assert.equal(live.__calls.click, 0);
});

test('click revalidates the exact id, scrolls and clicks once, and does not sleep in guest', async () => {
  const target = conversationRow({
    id: 'conv:target',
    name: 'Target customer',
    snippet: 'Latest message',
    tags: ['VIP']
  });
  const other = conversationRow({ id: 'other', name: 'Other customer' });
  const document = fakeDocument([other, target]);
  const originalSetTimeout = global.setTimeout;
  let timerCalls = 0;
  global.setTimeout = () => {
    timerCalls += 1;
    throw new Error('guest click must not schedule a sleep');
  };

  try {
    const result = await clickConversationById(document, 'conv:target');

    assert.deepEqual(result, {
      ok: true,
      info: {
        id: 'conv:target',
        name: 'Target customer',
        snippet: 'Latest message',
        tags: ['VIP'],
        hasTags: true
      }
    });
    assert.equal(target.__calls.scroll, 1);
    assert.equal(target.__calls.click, 1);
    assert.equal(other.__calls.click, 0);
    assert.equal(timerCalls, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('reads only visible active tag names marked with an ellipse', () => {
  const result = readActiveTagNames(tagDocument([
    tagButton({ name: '  Returning customer  ', active: true }),
    tagButton({ name: 'Translucent inactive', active: false, opacity: '0.5' }),
    tagButton({ name: 'Invisible active', active: true, visibility: 'hidden' })
  ]), domOptions);

  assert.deepEqual(result, ['Returning customer']);
});

test('returns an empty active-tag list for an empty rendered panel', () => {
  assert.deepEqual(readActiveTagNames(tagDocument([]), domOptions), []);
});

test('classifies trusted app pages with a real chat shell as chat', () => {
  const document = pageDocument({ hasChatShell: true });

  const result = classifyPancakePage(document, 'https://pancake.vn/');

  assert.deepEqual(result, { kind: 'chat', isChatPage: true });
  assert.deepEqual(document.calls, [
    '.conversation-list-item, #messageCol, .message-list, textarea#replyBoxComposer'
  ]);
  assert.equal(Object.isFrozen(result), true);
});

test('classifies auth origins before touching their DOM', () => {
  const document = pageDocument({ forbidQuery: true });

  assert.deepEqual(
    classifyPancakePage(document, 'https://account.pancake.vn/login'),
    { kind: 'auth', isChatPage: false }
  );
});

test('classifies app login and root pages without a chat shell as auth', () => {
  assert.deepEqual(
    classifyPancakePage(pageDocument(), 'https://pancake.vn/'),
    { kind: 'auth', isChatPage: false }
  );
  assert.deepEqual(
    classifyPancakePage(pageDocument(), 'https://pages.fm/login'),
    { kind: 'auth', isChatPage: false }
  );
});

test('fails closed when a trusted app document cannot be queried', () => {
  assert.deepEqual(
    classifyPancakePage(pageDocument({ forbidQuery: true }), 'https://pancake.vn/multi_pages'),
    { kind: 'wrong_page', isChatPage: false }
  );
});

test('classifies other trusted app paths without a chat shell as wrong_page', () => {
  assert.deepEqual(
    classifyPancakePage(pageDocument(), 'https://pancake.vn/multi_pages'),
    { kind: 'wrong_page', isChatPage: false }
  );
});

test('classifies untrusted URLs before touching their DOM', () => {
  const document = pageDocument({ forbidQuery: true });

  assert.deepEqual(
    classifyPancakePage(document, 'https://pancake.vn.evil.example/'),
    { kind: 'untrusted', isChatPage: false }
  );
});

test('returns a new immutable page classification for every call', () => {
  const first = classifyPancakePage(pageDocument(), 'https://pancake.vn/');
  const second = classifyPancakePage(pageDocument(), 'https://pancake.vn/');

  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(second), true);
});
