const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isTransientGuestViewError,
  getRetryAttempts,
  isIdempotentActionMethod,
  waitForWebviewReady,
  DEFAULT_WEBVIEW_READY_TIMEOUT_MS,
  startTrackedNavigation,
  startGuestNavigationLoad,
  startTrackedReload,
  enqueueWebviewTask,
  executeWithRetry,
  _shouldAcceptWebviewLoad
} = require('../src/renderer/webviewAutomation');

class FakeWebview {
  constructor() {
    this.src = 'https://pancake.vn/multi_pages';
    this.loading = true;
    this.destroyed = false;
    this.listeners = new Map();
    this.reloadCalls = 0;
    this.reloadError = null;
  }

  addEventListener(name, callback) {
    const callbacks = this.listeners.get(name) || new Set();
    callbacks.add(callback);
    this.listeners.set(name, callbacks);
  }

  removeEventListener(name, callback) {
    this.listeners.get(name)?.delete(callback);
  }

  emit(name, event = {}) {
    for (const callback of this.listeners.get(name) || []) callback(event);
  }

  isLoading() {
    return this.loading;
  }

  isDestroyed() {
    return this.destroyed;
  }

  getURL() {
    return this.src;
  }

  reload() {
    this.reloadCalls += 1;
    if (this.reloadError) throw this.reloadError;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('detects transient guest view execution errors', () => {
  assert.equal(isTransientGuestViewError(new Error('GUEST_VIEW_MANAGER_CALL failed')), true);
  assert.equal(isTransientGuestViewError(new Error('Script failed to execute in guest view')), true);
  assert.equal(isTransientGuestViewError('[object Object]'), true);
  assert.equal(isTransientGuestViewError(new Error('ordinary validation error')), false);
});

test('queue continues after a rejected task', async () => {
  await assert.rejects(
    enqueueWebviewTask(async () => {
      throw new Error('first task failed');
    }, { tabId: 'bot1' }),
    /first task failed/
  );

  const result = await enqueueWebviewTask(async () => 'second task ok', { tabId: 'bot1' });
  assert.equal(result, 'second task ok');
});

test('tasks for the same tab run FIFO', async () => {
  const firstGate = deferred();
  const events = [];

  const first = enqueueWebviewTask(async () => {
    events.push('first:start');
    await firstGate.promise;
    events.push('first:end');
  }, { tabId: 'bot1' });
  const second = enqueueWebviewTask(async () => {
    events.push('second:start');
  }, { tabId: 'bot1' });

  await nextTurn();
  assert.deepEqual(events, ['first:start']);

  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start']);
});

test('tasks for different tabs run concurrently', async () => {
  const bot1Gate = deferred();
  const bot2Started = deferred();

  const bot1 = enqueueWebviewTask(async () => {
    await bot1Gate.promise;
  }, { tabId: 'bot1' });
  const bot2 = enqueueWebviewTask(async () => {
    bot2Started.resolve();
    return 'bot2-ready';
  }, { tabId: 'bot2' });

  const winner = await Promise.race([
    bot2Started.promise.then(() => 'bot2'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 30))
  ]);
  bot1Gate.resolve();
  await Promise.all([bot1, bot2]);

  assert.equal(winner, 'bot2');
});

test('a slow timeout on bot1 does not block bot2', async () => {
  const bot1Finished = deferred();
  const bot1 = executeWithRetry(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    bot1Finished.resolve();
    throw new Error('webview loading timed out');
  }, {
    tabId: 'bot1',
    method: 'getUnreadConversations',
    attempts: 1,
    baseDelayMs: 0
  });
  const bot1Rejected = assert.rejects(bot1, /timed out/);

  const bot2 = executeWithRetry(async () => 'bot2-readable', {
    tabId: 'bot2',
    method: 'getUnreadConversations',
    attempts: 1,
    baseDelayMs: 0
  });
  const winner = await Promise.race([
    bot2.then(() => 'bot2'),
    bot1Finished.promise.then(() => 'bot1')
  ]);

  assert.equal(winner, 'bot2');
  assert.equal(await bot2, 'bot2-readable');
  await bot1Rejected;
});

test('read methods retry up to three attempts', async () => {
  let attempts = 0;
  const result = await executeWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('GUEST_VIEW_MANAGER_CALL busy');
    return 'ok';
  }, { method: 'getUnreadConversations', baseDelayMs: 0 });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.equal(getRetryAttempts('getUnreadConversations'), 3);
});

test('getCurrentTags is classified as a retried read method', async () => {
  let attempts = 0;
  const result = await executeWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('GUEST_VIEW_MANAGER_CALL busy');
    return ['VIP'];
  }, { method: 'getCurrentTags', baseDelayMs: 0 });

  assert.deepEqual(result, ['VIP']);
  assert.equal(attempts, 3);
  assert.equal(getRetryAttempts('getCurrentTags'), 3);
});

test('read retries invalidate and reinject before each retry', async () => {
  let attempts = 0;
  let invalidations = 0;
  let reinjections = 0;

  const result = await executeWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('window.__PDB__ is missing');
      error.code = 'AUTOMATION_NOT_INJECTED';
      throw error;
    }
    return 'recovered';
  }, {
    tabId: 'bot1',
    method: 'getUnreadConversations',
    baseDelayMs: 0,
    onBeforeRetry: async ({ attempt, method }) => {
      assert.equal(method, 'getUnreadConversations');
      assert.ok(attempt === 2 || attempt === 3);
      invalidations += 1;
      reinjections += 1;
    }
  });

  assert.equal(result, 'recovered');
  assert.equal(attempts, 3);
  assert.equal(invalidations, 2);
  assert.equal(reinjections, 2);
});

test('waitForWebviewReady resolves after did-finish-load', async () => {
  const webview = new FakeWebview();
  const tab = { label: 'Bot 1', webview, loaded: false };
  const ready = waitForWebviewReady(tab, { label: 'clickConversationById', timeoutMs: 100 });

  setImmediate(() => {
    tab.loaded = true;
    webview.loading = false;
    webview.emit('did-finish-load');
  });

  assert.equal(await ready, true);
});

test('waitForWebviewReady resolves after dom-ready when finish event is missed', async () => {
  const webview = new FakeWebview();
  const tab = { label: 'Bot 2', webview, loaded: false };
  const ready = waitForWebviewReady(tab, { label: 'injectAutomation', timeoutMs: 100 });

  setImmediate(() => {
    tab.loaded = true;
    webview.loading = false;
    webview.emit('dom-ready');
  });

  assert.equal(await ready, true);
});

test('waitForWebviewReady resolves after did-stop-loading when finish event is missed', async () => {
  const webview = new FakeWebview();
  const tab = { label: 'Bot 2', webview, loaded: false };
  const ready = waitForWebviewReady(tab, { label: 'injectAutomation', timeoutMs: 100 });

  setImmediate(() => {
    tab.loaded = true;
    webview.loading = false;
    webview.emit('did-stop-loading');
  });

  assert.equal(await ready, true);
});

test('default readiness timeout is long enough for a slow Pancake navigation', () => {
  assert.equal(DEFAULT_WEBVIEW_READY_TIMEOUT_MS, 15000);
});

test('waitForWebviewReady accepts a slow load before the configured timeout', async () => {
  const webview = new FakeWebview();
  const tab = { label: 'Bot 1', webview, loaded: false };
  const ready = waitForWebviewReady(tab, { label: 'openPancakeChat', timeoutMs: 1000 });

  setTimeout(() => {
    tab.loaded = true;
    webview.loading = false;
    webview.emit('did-finish-load');
  }, 30);

  assert.equal(await ready, true);
});

test('waitForWebviewReady rejects on load failure', async () => {
  const webview = new FakeWebview();
  const tab = { label: 'Bot 1', webview, loaded: false };
  const ready = waitForWebviewReady(tab, { label: 'injectAutomation', timeoutMs: 100 });

  setImmediate(() => {
    webview.loading = false;
    webview.emit('did-fail-load', { errorCode: -2, errorDescription: 'ERR_FAILED' });
  });

  await assert.rejects(ready, /Bot 1: injectAutomation webview loading\/ready wait failed.*ERR_FAILED/);
});

test('waitForWebviewReady ignores aborted navigation if load later finishes', async () => {
  const webview = new FakeWebview();
  const tab = { label: 'Bot 1', webview, loaded: false };
  const ready = waitForWebviewReady(tab, { label: 'injectAutomation', timeoutMs: 100 });

  setImmediate(() => {
    webview.emit('did-fail-load', { errorCode: -3, errorDescription: 'ERR_ABORTED' });
    tab.loaded = true;
    webview.loading = false;
    webview.emit('did-finish-load');
  });

  assert.equal(await ready, true);
});

test('an old navigation generation cannot resolve the current readiness wait', async () => {
  const webview = new FakeWebview();
  const tab = { label: 'Bot 1', webview, loaded: false, loadGeneration: 2 };
  const ready = waitForWebviewReady(tab, {
    label: 'injectAutomation',
    timeoutMs: 100,
    generation: 2
  });
  let resolved = false;
  ready.then(() => { resolved = true; });

  webview.loading = false;
  webview.emit('did-finish-load', { generation: 1 });
  await nextTurn();
  assert.equal(resolved, false);

  tab.loaded = true;
  webview.emit('did-finish-load', { generation: 2 });
  assert.equal(await ready, true);
});

test('tracked same-URL navigation only completes the newest generation', async () => {
  const webview = new FakeWebview();
  const firstLoad = deferred();
  const secondLoad = deferred();
  let loadNumber = 0;
  webview.loadURL = () => (++loadNumber === 1 ? firstLoad.promise : secondLoad.promise);
  const tab = {
    label: 'Bot 1',
    webview,
    loaded: true,
    loadState: 'loaded',
    loadGeneration: 0,
    completedGeneration: 0
  };

  const first = startTrackedNavigation(tab, webview.src);
  const second = startTrackedNavigation(tab, webview.src);
  firstLoad.resolve();
  await first.promise;

  assert.equal(tab.loadGeneration, 2);
  assert.equal(tab.loaded, false);
  assert.notEqual(tab.completedGeneration, 2);

  secondLoad.resolve();
  assert.deepEqual(await second.promise, { ok: true, generation: 2 });
  assert.equal(tab.loaded, true);
  assert.equal(tab.completedGeneration, 2);
});

test('tracked reload refuses a loading webview without changing state', () => {
  const webview = new FakeWebview();
  webview.loading = true;
  const tab = {
    label: 'Bot 1',
    webview,
    loaded: false,
    loadState: 'loading',
    loadGeneration: 7,
    completedGeneration: 6,
    loadError: 'previous',
    automationInjected: true,
    injectionGeneration: 7,
    expectedNavigationUrl: 'https://pages.fm/current'
  };
  const before = { ...tab };

  const result = startTrackedReload(tab, { targetUrl: 'https://pages.fm/current' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'WEBVIEW_NOT_READY');
  assert.equal(webview.reloadCalls, 0);
  assert.deepEqual({ ...tab }, before);
});

test('tracked reload starts a new load generation for a ready webview', () => {
  const webview = new FakeWebview();
  webview.loading = false;
  const tab = {
    label: 'Bot 1',
    webview,
    loaded: true,
    loadState: 'loaded',
    loadGeneration: 4,
    completedGeneration: 4,
    loadError: 'old error',
    automationInjected: true,
    injectionGeneration: 4,
    expectedNavigationUrl: 'https://pages.fm/old',
    reloadGeneration: null
  };

  const result = startTrackedReload(tab, { targetUrl: 'https://pages.fm/current' });

  assert.deepEqual(result, {
    ok: true,
    generation: 5,
    targetUrl: 'https://pages.fm/current'
  });
  assert.equal(webview.reloadCalls, 1);
  assert.equal(tab.loadGeneration, 5);
  assert.equal(tab.reloadGeneration, 5);
  assert.equal(tab.completedGeneration, 4);
  assert.equal(tab.loaded, false);
  assert.equal(tab.loadState, 'loading');
  assert.equal(tab.loadError, null);
  assert.equal(tab.automationInjected, false);
  assert.equal(tab.injectionGeneration, -1);
  assert.equal(tab.expectedNavigationUrl, 'https://pages.fm/current');
});

test('tracked reload restores state when Electron rejects an unattached webview', () => {
  const webview = new FakeWebview();
  webview.loading = false;
  webview.reloadError = new Error('WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.');
  const tab = {
    label: 'Bot 1',
    webview,
    loaded: true,
    loadState: 'loaded',
    loadGeneration: 9,
    completedGeneration: 9,
    loadError: null,
    automationInjected: true,
    injectionGeneration: 9,
    expectedNavigationUrl: 'https://pages.fm/current',
    reloadGeneration: null,
    pendingNavigationToken: null
  };
  const before = { ...tab };

  const result = startTrackedReload(tab, { targetUrl: 'https://pages.fm/current' });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'RELOAD_FAILED');
  assert.match(result.error.message, /WebView must be attached/);
  assert.equal(webview.reloadCalls, 1);
  assert.deepEqual({ ...tab }, before);
});

test('tracked reload completion accepts redirected final URLs only for reload generations', () => {
  const webview = new FakeWebview();
  webview.loading = false;
  const tab = {
    label: 'Bot 1',
    webview,
    loaded: true,
    loadState: 'loaded',
    loadGeneration: 2,
    completedGeneration: 2,
    expectedNavigationUrl: 'https://pages.fm/current',
    reloadGeneration: null
  };

  startTrackedReload(tab, { targetUrl: 'https://pages.fm/current' });

  assert.equal(_shouldAcceptWebviewLoad(tab, {
    loadedUrl: 'https://pages.fm/canonical'
  }), true);

  tab.reloadGeneration = null;
  assert.equal(_shouldAcceptWebviewLoad(tab, {
    loadedUrl: 'https://pages.fm/canonical'
  }), false);
});

test('tracked reload ignores aborted redirect failures before accepting final URL', () => {
  const webview = new FakeWebview();
  webview.loading = false;
  const tab = {
    label: 'Bot 1',
    webview,
    loaded: true,
    loadState: 'loaded',
    loadGeneration: 2,
    completedGeneration: 2,
    expectedNavigationUrl: 'https://pages.fm/current',
    reloadGeneration: null
  };

  startTrackedReload(tab, { targetUrl: 'https://pages.fm/current' });
  assert.equal(_shouldAcceptWebviewLoad(tab, {
    loadedUrl: 'https://pages.fm/current',
    event: { errorCode: -3, errorDescription: 'ERR_ABORTED' },
    failure: true
  }), false);
  assert.equal(tab.reloadGeneration, 3);
  assert.equal(_shouldAcceptWebviewLoad(tab, {
    loadedUrl: 'https://pages.fm/canonical'
  }), true);
});

test('guest-initiated auth navigation clears the stale expected URL and accepts its final load', () => {
  const tab = {
    label: 'Bot 1',
    webview: new FakeWebview(),
    loaded: true,
    loadState: 'loaded',
    loadGeneration: 4,
    completedGeneration: 4,
    expectedNavigationUrl: 'https://pancake.vn/',
    reloadGeneration: null,
    pendingNavigationToken: null,
    automationInjected: true,
    injectionGeneration: 4
  };

  const result = startGuestNavigationLoad(tab);

  assert.deepEqual(result, { generation: 5, untracked: true });
  assert.equal(tab.expectedNavigationUrl, '');
  assert.equal(tab.loaded, false);
  assert.equal(tab.loadState, 'loading');
  assert.equal(tab.automationInjected, false);
  assert.equal(tab.injectionGeneration, -1);
  assert.equal(_shouldAcceptWebviewLoad(tab, {
    loadedUrl: 'https://account.pancake.vn/login'
  }), true);
});

test('waitForWebviewReady rejects when render process is gone', async () => {
  const webview = new FakeWebview();
  const tab = { label: 'Bot 1', webview, loaded: false };
  const ready = waitForWebviewReady(tab, { label: 'getUnreadConversations', timeoutMs: 100 });

  setImmediate(() => {
    webview.emit('render-process-gone', { reason: 'crashed' });
  });

  await assert.rejects(ready, /render process gone|crashed/);
});

test('waitForWebviewReady times out with tab label and url', async () => {
  const webview = new FakeWebview();
  const tab = { label: 'Bot 1', webview, loaded: false };

  await assert.rejects(
    waitForWebviewReady(tab, { label: 'clickConversationById', timeoutMs: 5 }),
    /Bot 1: clickConversationById webview loading\/ready wait failed, url=https:\/\/pancake\.vn\/multi_pages - timed out/
  );
});

test('clickSendButton is not retried', async () => {
  let attempts = 0;
  await assert.rejects(
    executeWithRetry(async () => {
      attempts += 1;
      throw new Error('GUEST_VIEW_MANAGER_CALL busy');
    }, { method: 'clickSendButton', baseDelayMs: 0 }),
    /GUEST_VIEW_MANAGER_CALL/
  );

  assert.equal(attempts, 1);
  assert.equal(getRetryAttempts('clickSendButton'), 1);
});

test('non-idempotent actions are dispatched at most once', async (t) => {
  // Replaying these can double-send a message or flip unread back off, so a
  // transient guest-view failure must surface instead of being retried.
  const actionMethods = [
    'clickSendButton',
    'markCurrentConversationUnread'
  ];

  for (const method of actionMethods) {
    await t.test(method, async () => {
      let attempts = 0;
      await assert.rejects(
        executeWithRetry(async () => {
          attempts += 1;
          throw new Error('GUEST_VIEW_MANAGER_CALL failed after dispatch');
        }, { tabId: 'bot1', method, baseDelayMs: 0 }),
        /GUEST_VIEW_MANAGER_CALL/
      );
      assert.equal(attempts, 1);
      assert.equal(getRetryAttempts(method), 1);
      assert.equal(isIdempotentActionMethod(method), false);
    });
  }
});

test('non-idempotent actions ignore a caller asking for extra attempts', async () => {
  let attempts = 0;
  await assert.rejects(
    executeWithRetry(async () => {
      attempts += 1;
      throw new Error('GUEST_VIEW_MANAGER_CALL busy');
    }, { tabId: 'bot1', method: 'clickSendButton', attempts: 5, baseDelayMs: 0 }),
    /GUEST_VIEW_MANAGER_CALL/
  );

  assert.equal(attempts, 1);
});

test('idempotent actions retry once on a transient guest view failure', async (t) => {
  const actionMethods = [
    'clickConversationById',
    'setReplyText',
    'applyTagByName'
  ];

  for (const method of actionMethods) {
    await t.test(method, async () => {
      let attempts = 0;
      const result = await executeWithRetry(async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('GUEST_VIEW_MANAGER_CALL busy');
        return `${method}-ok`;
      }, { tabId: 'bot1', method, baseDelayMs: 0 });

      assert.equal(result, `${method}-ok`);
      assert.equal(attempts, 2);
      assert.equal(getRetryAttempts(method), 2);
      assert.equal(isIdempotentActionMethod(method), true);
    });
  }
});

test('idempotent actions stop after the second attempt', async () => {
  let attempts = 0;
  await assert.rejects(
    executeWithRetry(async () => {
      attempts += 1;
      throw new Error('GUEST_VIEW_MANAGER_CALL busy');
    }, { tabId: 'bot1', method: 'setReplyText', baseDelayMs: 0 }),
    /GUEST_VIEW_MANAGER_CALL/
  );

  assert.equal(attempts, 2);
});
