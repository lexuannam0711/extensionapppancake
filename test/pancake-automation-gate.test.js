const test = require('node:test');
const assert = require('node:assert/strict');

const {
  prepareAutomation,
  isAuthRequiredError
} = require('../src/renderer/pancakeAutomationGate');

function createCallbacks(pageState) {
  const calls = { probe: 0, inject: 0 };
  return {
    calls,
    probePage: async () => {
      calls.probe += 1;
      return pageState;
    },
    injectAutomation: async () => {
      calls.inject += 1;
      return 'injected';
    }
  };
}

test('auth origins stop before both the DOM probe and full automation injection', async () => {
  const callbacks = createCallbacks({ kind: 'chat', isChatPage: true });

  await assert.rejects(
    prepareAutomation({
      url: 'https://account.pancake.vn/login?access_token=secret#callback',
      tabLabel: 'Bot 2',
      classifyUrl: () => 'auth',
      ...callbacks
    }),
    (error) => {
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.equal(isAuthRequiredError(error), true);
      assert.match(error.message, /Bot 2/);
      assert.match(error.message, /đăng nhập Pancake/i);
      assert.doesNotMatch(error.message, /access_token|secret|callback/);
      return true;
    }
  );

  assert.deepEqual(callbacks.calls, { probe: 0, inject: 0 });
});

test('auth URL is rejected before readiness wait', async () => {
  let readinessCalls = 0;
  await assert.rejects(
    prepareAutomation({
      url: 'https://account.pancake.vn/login',
      tabLabel: 'Bot 2',
      classifyUrl: () => 'auth',
      waitUntilReady: async () => { readinessCalls += 1; },
      probePage: async () => ({ kind: 'auth', isChatPage: false }),
      injectAutomation: async () => true
    }),
    (error) => error.code === 'AUTH_REQUIRED'
  );
  assert.equal(readinessCalls, 0);
});

test('untrusted origins stop before executing any guest script', async () => {
  const callbacks = createCallbacks({ kind: 'chat', isChatPage: true });

  await assert.rejects(
    prepareAutomation({
      url: 'https://evil.example/inbox?token=secret#fragment',
      tabLabel: 'Bot 1',
      classifyUrl: () => 'untrusted',
      ...callbacks
    }),
    (error) => {
      assert.equal(error.code, 'UNTRUSTED_AUTOMATION_ORIGIN');
      assert.match(error.message, /blocked untrusted automation origin/i);
      assert.match(error.message, /https:\/\/evil\.example\/inbox/);
      assert.doesNotMatch(error.message, /token|secret|fragment/);
      return true;
    }
  );

  assert.deepEqual(callbacks.calls, { probe: 0, inject: 0 });
});

test('an app-origin login page may be probed read-only but never receives full automation', async () => {
  const callbacks = createCallbacks(Object.freeze({ kind: 'auth', isChatPage: false }));

  await assert.rejects(
    prepareAutomation({
      url: 'https://pancake.vn/',
      tabLabel: 'Bot 1',
      classifyUrl: () => 'app',
      ...callbacks
    }),
    (error) => error.code === 'AUTH_REQUIRED' && isAuthRequiredError(error)
  );

  assert.deepEqual(callbacks.calls, { probe: 1, inject: 0 });
});

test('an app page without the chat shell reports the dedicated wrong-page error', async () => {
  const callbacks = createCallbacks(Object.freeze({ kind: 'wrong_page', isChatPage: false }));

  await assert.rejects(
    prepareAutomation({
      url: 'https://pancake.vn/settings?token=secret',
      tabLabel: 'Bot 1',
      classifyUrl: () => 'app',
      ...callbacks
    }),
    (error) => {
      assert.equal(error.code, 'WRONG_PANCAKE_PAGE');
      assert.match(error.message, /https:\/\/pancake\.vn\/settings/);
      assert.doesNotMatch(error.message, /token|secret/);
      return true;
    }
  );

  assert.deepEqual(callbacks.calls, { probe: 1, inject: 0 });
});

test('only a confirmed chat page reaches full automation injection', async () => {
  const pageState = Object.freeze({ kind: 'chat', isChatPage: true });
  const callbacks = createCallbacks(pageState);

  const result = await prepareAutomation({
    url: 'https://pancake.vn/',
    tabLabel: 'Bot 1',
    classifyUrl: () => 'app',
    ...callbacks
  });

  assert.equal(result, 'injected');
  assert.deepEqual(callbacks.calls, { probe: 1, inject: 1 });
  assert.deepEqual(pageState, { kind: 'chat', isChatPage: true });
});

test('origin is classified from the final URL after webview readiness', async () => {
  let currentUrl = 'about:blank';
  let readinessCalls = 0;
  const callbacks = createCallbacks(Object.freeze({ kind: 'chat', isChatPage: true }));

  const result = await prepareAutomation({
    getUrl: () => currentUrl,
    waitUntilReady: async () => {
      readinessCalls += 1;
      currentUrl = 'https://pancake.vn/?inbox=1';
    },
    tabLabel: 'Bot 2',
    classifyUrl: (url) => url.startsWith('https://pancake.vn/') ? 'app' : 'untrusted',
    ...callbacks
  });

  assert.equal(result, 'injected');
  assert.equal(readinessCalls, 1);
  assert.deepEqual(callbacks.calls, { probe: 1, inject: 1 });
});

test('a throwing URL classifier fails closed without leaking a malformed URL', async () => {
  const callbacks = createCallbacks({ kind: 'chat', isChatPage: true });

  await assert.rejects(
    prepareAutomation({
      url: 'not a url?token=secret',
      classifyUrl: () => { throw new Error('classifier failed'); },
      ...callbacks
    }),
    (error) => {
      assert.equal(error.code, 'UNTRUSTED_AUTOMATION_ORIGIN');
      assert.doesNotMatch(error.message, /token|secret/);
      return true;
    }
  );

  assert.deepEqual(callbacks.calls, { probe: 0, inject: 0 });
});

test('a probe that detects an untrusted redirect blocks full injection', async () => {
  const callbacks = createCallbacks(Object.freeze({ kind: 'untrusted', isChatPage: false }));

  await assert.rejects(
    prepareAutomation({
      url: 'https://pancake.vn/',
      classifyUrl: () => 'app',
      ...callbacks
    }),
    (error) => error.code === 'UNTRUSTED_AUTOMATION_ORIGIN'
  );

  assert.deepEqual(callbacks.calls, { probe: 1, inject: 0 });
});

test('missing probe or injector dependencies fail explicitly instead of authorizing by default', async () => {
  await assert.rejects(
    prepareAutomation({ url: 'https://pancake.vn/', classifyUrl: () => 'app' }),
    /page probe is required/i
  );

  await assert.rejects(
    prepareAutomation({
      url: 'https://pancake.vn/',
      classifyUrl: () => 'app',
      probePage: async () => ({ kind: 'chat', isChatPage: true })
    }),
    /automation injector is required/i
  );
});

test('a redirect to auth before the probe is rechecked and receives no probe script', async () => {
  const urls = ['https://pancake.vn/', 'https://account.pancake.vn/login'];
  const callbacks = createCallbacks({ kind: 'chat', isChatPage: true });

  await assert.rejects(
    prepareAutomation({
      getUrl: () => urls.shift() || 'https://account.pancake.vn/login',
      tabLabel: 'Bot 1',
      classifyUrl: (url) => url.includes('account.pancake.vn') ? 'auth' : 'app',
      ...callbacks
    }),
    (error) => error.code === 'AUTH_REQUIRED'
  );

  assert.deepEqual(callbacks.calls, { probe: 0, inject: 0 });
});

test('a redirect to auth after the chat probe is rechecked before adapter injection', async () => {
  let currentUrl = 'https://pancake.vn/';
  let injectCalls = 0;

  await assert.rejects(
    prepareAutomation({
      getUrl: () => currentUrl,
      tabLabel: 'Bot 2',
      classifyUrl: (url) => url.includes('account.pancake.vn') ? 'auth' : 'app',
      probePage: async () => {
        currentUrl = 'https://account.pancake.vn/login';
        return { kind: 'chat', isChatPage: true };
      },
      injectAutomation: async () => {
        injectCalls += 1;
        return true;
      }
    }),
    (error) => error.code === 'AUTH_REQUIRED'
  );

  assert.equal(injectCalls, 0);
});

test('an atomic guest guard block returned at dispatch time becomes a typed gate error', async () => {
  await assert.rejects(
    prepareAutomation({
      url: 'https://pancake.vn/',
      tabLabel: 'Bot 1',
      classifyUrl: () => 'app',
      probePage: async () => ({ kind: 'chat', isChatPage: true }),
      injectAutomation: async () => ({
        __PDB_AUTOMATION_BLOCKED__: { kind: 'auth', isChatPage: false }
      })
    }),
    (error) => error.code === 'AUTH_REQUIRED'
  );
});
