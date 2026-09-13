const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const {
  buildProbePayload,
  buildAdapterPayload,
  isBlockedResult,
  canCommitAdapterResult
} = require('../src/renderer/pancakeAutomationPayload');

const policyCode = `window.PDBPancakeUrlPolicy = {
  classifyPancakeUrl: (url) => url.includes('account.pancake.vn') ? 'auth' :
    url.startsWith('https://pancake.vn/') ? 'app' : 'untrusted'
};`;

const domCode = `window.PDBPancakeDom = {
  classifyPancakePage: (_document, url) => ({
    kind: window.PDBPancakeUrlPolicy.classifyPancakeUrl(url) === 'app' ? 'chat' :
      window.PDBPancakeUrlPolicy.classifyPancakeUrl(url),
    isChatPage: window.PDBPancakeUrlPolicy.classifyPancakeUrl(url) === 'app'
  })
};`;

function runPayload(payload, href) {
  const context = { window: {}, document: {}, location: { href } };
  context.window.window = context.window;
  context.window.document = context.document;
  context.window.location = context.location;
  return { result: vm.runInNewContext(payload, context), context };
}

test('probe payload checks the guest URL atomically and reports its page state', () => {
  const payload = buildProbePayload({ policyCode, domCode });
  const { result } = runPayload(payload, 'https://evil.example/inbox');

  assert.equal(result.kind, 'untrusted');
  assert.equal(result.isChatPage, false);
});

test('adapter payload blocks an auth redirect inside the dispatched guest script', () => {
  const payload = buildAdapterPayload({
    policyCode,
    domCode,
    adapterCode: 'window.__PDB__ = { installed: true };'
  });
  const { result, context } = runPayload(payload, 'https://account.pancake.vn/login');

  assert.equal(result.__PDB_AUTOMATION_BLOCKED__.kind, 'auth');
  assert.equal(isBlockedResult(result), true);
  assert.equal(context.window.__PDB__, undefined);
});

test('adapter payload installs automation only on a confirmed chat page', () => {
  const payload = buildAdapterPayload({
    policyCode,
    domCode,
    adapterCode: 'window.__PDB__ = { installed: true };'
  });
  const { result, context } = runPayload(payload, 'https://pancake.vn/chat');

  assert.equal(result, true);
  assert.equal(isBlockedResult(result), false);
  assert.equal(context.window.__PDB__.installed, true);
});

test('adapter result is committed only to the same loaded navigation generation', () => {
  assert.equal(canCommitAdapterResult(true, {
    expectedGeneration: 4,
    currentGeneration: 4,
    loaded: true
  }), true);
  assert.equal(canCommitAdapterResult(true, {
    expectedGeneration: 4,
    currentGeneration: 5,
    loaded: true
  }), false);
  assert.equal(canCommitAdapterResult(true, {
    expectedGeneration: 4,
    currentGeneration: 4,
    loaded: false
  }), false);
  assert.equal(canCommitAdapterResult({
    __PDB_AUTOMATION_BLOCKED__: { kind: 'auth' }
  }, {
    expectedGeneration: 4,
    currentGeneration: 4,
    loaded: true
  }), false);
});
