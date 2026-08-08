const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createConversationProcessingCoordinator
} = require('../src/renderer/conversationProcessing');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createClaims() {
  const active = new Map();
  return {
    claimConversation(key, runtime) {
      const owner = active.get(key);
      if (owner && owner !== runtime.tabId) return false;
      active.set(key, runtime.tabId);
      return true;
    },
    releaseConversationClaim(key, runtime) {
      if (active.get(key) !== runtime.tabId) return false;
      active.delete(key);
      return true;
    }
  };
}

function createHarness(overrides = {}) {
  const processed = new Set();
  const blocked = new Set();
  const calls = {
    commits: [],
    reviews: [],
    blocks: []
  };
  const coordinator = createConversationProcessingCoordinator({
    claims: createClaims(),
    isProcessed: (key) => processed.has(key),
    commitProcessed: (key) => {
      processed.add(key);
      calls.commits.push(key);
    },
    addReviewItem: (item) => calls.reviews.push(item),
    isConversationBlocked: (key) => blocked.has(key),
    blockConversation: (key) => {
      blocked.add(key);
      calls.blocks.push(key);
    },
    ...overrides
  });
  return { coordinator, calls };
}

function job(runtime, performAction, overrides = {}) {
  return {
    key: 'conversation-1',
    conversationId: 'conversation-1',
    runtime,
    stage: 'clickConversationById',
    performAction,
    ...overrides
  };
}

test('conversation processing: two bots can produce only one click for one conversation', async () => {
  const { coordinator, calls } = createHarness();
  const clickStarted = deferred();
  const releaseClick = deferred();
  let clickCount = 0;
  const click = async () => {
    clickCount += 1;
    clickStarted.resolve();
    await releaseClick.promise;
    return { ok: true, info: { id: 'conversation-1' } };
  };

  const bot1 = coordinator.process(job({ tabId: 'bot1' }, click));
  await clickStarted.promise;
  const bot2 = coordinator.process(job({ tabId: 'bot2' }, click));
  releaseClick.resolve();

  const [first, second] = await Promise.all([bot1, bot2]);
  assert.equal(clickCount, 1);
  assert.equal(first.ok, true);
  assert.equal(second.code, 'CLAIM_REJECTED');
  assert.deepEqual(calls.commits, ['conversation-1']);
});

test('conversation processing: rejected claim performs no action and records no processed item', async () => {
  const claims = createClaims();
  claims.claimConversation('conversation-1', { tabId: 'bot1' });
  let actionCount = 0;
  const { coordinator, calls } = createHarness({ claims });

  const result = await coordinator.process(job({ tabId: 'bot2' }, async () => {
    actionCount += 1;
    return { ok: true };
  }));

  assert.equal(result.code, 'CLAIM_REJECTED');
  assert.equal(actionCount, 0);
  assert.deepEqual(calls.commits, []);
});

test('conversation processing: stale pre-click failure releases claim without commit', async () => {
  const claims = createClaims();
  const releases = [];
  const release = claims.releaseConversationClaim.bind(claims);
  claims.releaseConversationClaim = (key, runtime) => {
    releases.push([key, runtime.tabId]);
    return release(key, runtime);
  };
  const { coordinator, calls } = createHarness({ claims });

  const result = await coordinator.process(job(
    { tabId: 'bot1' },
    async () => ({ ok: false, code: 'STALE_CONVERSATION', dispatched: false })
  ));

  assert.equal(result.code, 'STALE_CONVERSATION');
  assert.deepEqual(calls.commits, []);
  assert.deepEqual(calls.reviews, []);
  assert.deepEqual(releases, [['conversation-1', 'bot1']]);
  assert.equal(claims.claimConversation('conversation-1', { tabId: 'bot2' }), true);
});

test('conversation processing: confirmed click commits exactly once', async () => {
  const { coordinator, calls } = createHarness();
  let actionCount = 0;

  const result = await coordinator.process(job({ tabId: 'bot1' }, async () => {
    actionCount += 1;
    return { ok: true, info: { id: 'conversation-1' } };
  }));

  assert.equal(result.ok, true);
  assert.equal(actionCount, 1);
  assert.deepEqual(calls.commits, ['conversation-1']);
  assert.deepEqual(calls.reviews, []);
  assert.deepEqual(calls.blocks, []);

  const second = await coordinator.process(job({ tabId: 'bot2' }, async () => {
    actionCount += 1;
    return { ok: true };
  }));
  assert.equal(second.code, 'ALREADY_PROCESSED');
  assert.equal(actionCount, 1);
  assert.deepEqual(calls.commits, ['conversation-1']);
});

test('conversation processing: deferred completion keeps claim and delays commit', async () => {
  const claims = createClaims();
  const { coordinator, calls } = createHarness({ claims });
  const runtime1 = { tabId: 'bot1' };
  const runtime2 = { tabId: 'bot2' };
  const deferredJob = job(runtime1, async () => ({ ok: true, info: { id: 'conversation-1' } }), {
    deferCompletion: true
  });

  const clicked = await coordinator.process(deferredJob);
  assert.equal(clicked.ok, true);
  assert.deepEqual(calls.commits, []);
  assert.equal(claims.claimConversation('conversation-1', runtime2), false);

  const completed = coordinator.completeDeferred(deferredJob, { commit: true });
  assert.equal(completed, true);
  assert.deepEqual(calls.commits, ['conversation-1']);
  assert.equal(claims.claimConversation('conversation-1', runtime2), true);
});

test('conversation processing: deferred claim heartbeat refreshes ownership until completion', async () => {
  const claims = createClaims();
  let heartbeat = null;
  let refreshCount = 0;
  const claim = claims.claimConversation.bind(claims);
  claims.claimConversation = (key, runtime) => {
    refreshCount += 1;
    return claim(key, runtime);
  };
  const { coordinator } = createHarness({
    claims,
    claimRefreshIntervalMs: 20_000,
    setIntervalFn(callback) {
      heartbeat = callback;
      return 7;
    },
    clearIntervalFn() {}
  });
  const runtime1 = { tabId: 'bot1' };
  const runtime2 = { tabId: 'bot2' };
  const deferredJob = job(runtime1, async () => ({ ok: true }), { deferCompletion: true });

  assert.equal((await coordinator.process(deferredJob)).ok, true);
  assert.equal(typeof heartbeat, 'function');
  heartbeat();
  heartbeat();
  assert.equal(refreshCount, 3);
  assert.equal(claims.claimConversation('conversation-1', runtime2), false);
  assert.equal(coordinator.completeDeferred(deferredJob, { commit: true }), true);
});

test('conversation processing: lost deferred heartbeat prevents commit', async () => {
  let heartbeat = null;
  let owned = true;
  const claims = {
    claimConversation() { return owned; },
    releaseConversationClaim() { return owned; }
  };
  const { coordinator, calls } = createHarness({
    claims,
    setIntervalFn(callback) {
      heartbeat = callback;
      return 9;
    },
    clearIntervalFn() {}
  });
  const deferredJob = job({ tabId: 'bot1' }, async () => ({ ok: true }), { deferCompletion: true });

  await coordinator.process(deferredJob);
  owned = false;
  heartbeat();
  assert.equal(coordinator.completeDeferred(deferredJob, { commit: true }), false);
  assert.deepEqual(calls.commits, []);
});

test('conversation processing: uncertain action is not retried, is blocked, and creates a sanitized review item', async () => {
  const claims = createClaims();
  const releases = [];
  const release = claims.releaseConversationClaim.bind(claims);
  claims.releaseConversationClaim = (key, runtime) => {
    releases.push([key, runtime.tabId]);
    return release(key, runtime);
  };
  const { coordinator, calls } = createHarness({ claims });
  let actionCount = 0;

  const result = await coordinator.process(job(
    { tabId: 'bot1' },
    async () => {
      actionCount += 1;
      return {
        ok: false,
        code: 'ACTION_TIMEOUT',
        uncertain: true,
        dispatched: true,
        message: 'Customer Alice said secret text',
        stack: 'private stack'
      };
    }
  ));

  assert.equal(result.code, 'UNCERTAIN');
  assert.equal(actionCount, 1);
  assert.deepEqual(calls.commits, []);
  assert.deepEqual(calls.blocks, ['conversation-1']);
  assert.deepEqual(calls.reviews, [{
    conversationId: 'conversation-1',
    tabId: 'bot1',
    code: 'ACTION_TIMEOUT',
    stage: 'clickConversationById'
  }]);
  assert.equal(JSON.stringify(calls.reviews).includes('Alice'), false);
  assert.equal(JSON.stringify(calls.reviews).includes('private stack'), false);
  assert.deepEqual(releases, [['conversation-1', 'bot1']]);

  const second = await coordinator.process(job({ tabId: 'bot2' }, async () => {
    actionCount += 1;
    return { ok: true };
  }));
  assert.equal(second.code, 'CONVERSATION_BLOCKED');
  assert.equal(actionCount, 1);
});
