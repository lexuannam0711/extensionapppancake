const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLAIM_TTL_MS,
  CLAIM_MAX_ENTRIES,
  activeConversationClaims,
  claimConversation,
  releaseConversationClaim,
  clearConversationClaims
} = require('../src/renderer/conversationClaims');

function runtime(tabId) {
  return { tabId };
}

test('conversation claims: another bot cannot claim the same conversation before TTL', () => {
  clearConversationClaims();

  assert.equal(claimConversation('conv-1', runtime('bot1'), 1000), true);
  assert.equal(claimConversation('conv-1', runtime('bot2'), 1001), false);
});

test('conversation claims: another bot can claim a different conversation', () => {
  clearConversationClaims();

  assert.equal(claimConversation('conv-1', runtime('bot1'), 1000), true);
  assert.equal(claimConversation('conv-2', runtime('bot2'), 1001), true);
});

test('conversation claims: expired claim can be claimed by another bot', () => {
  clearConversationClaims();

  assert.equal(claimConversation('conv-1', runtime('bot1'), 1000), true);
  assert.equal(claimConversation('conv-1', runtime('bot2'), 1000 + CLAIM_TTL_MS + 1), true);
});

test('conversation claims: only owner can release a claim', () => {
  clearConversationClaims();

  assert.equal(claimConversation('conv-1', runtime('bot1'), 1000), true);
  assert.equal(releaseConversationClaim('conv-1', runtime('bot2')), false);
  assert.equal(claimConversation('conv-1', runtime('bot2'), 1001), false);
  assert.equal(releaseConversationClaim('conv-1', runtime('bot1')), true);
  assert.equal(claimConversation('conv-1', runtime('bot2'), 1002), true);
});

test('conversation claims: TTL is 60 seconds', () => {
  assert.equal(CLAIM_TTL_MS, 60_000);
});

test('conversation claims: same owner refreshes the claim timestamp deterministically', () => {
  clearConversationClaims();

  assert.equal(claimConversation('conv-1', runtime('bot1'), 1_000), true);
  assert.equal(claimConversation('conv-1', runtime('bot1'), 31_000), true);
  assert.equal(claimConversation('conv-1', runtime('bot2'), 61_001), false);
  assert.equal(claimConversation('conv-1', runtime('bot2'), 91_001), true);
});

test('conversation claims: rejected owner cannot refresh or release another owner claim', () => {
  clearConversationClaims();

  assert.equal(claimConversation('conv-1', runtime('bot1'), 1_000), true);
  assert.equal(claimConversation('conv-1', runtime('bot2'), 30_000), false);
  assert.equal(releaseConversationClaim('conv-1', runtime('bot2')), false);
  assert.deepEqual(activeConversationClaims.get('conv-1'), {
    runtimeId: 'bot1',
    ts: 1_000
  });
});

test('conversation claims: evicts oldest entries when the cache exceeds 200', () => {
  clearConversationClaims();

  for (let index = 0; index < 205; index += 1) {
    assert.equal(claimConversation(`conv-${index}`, runtime('bot1'), 10_000 + index), true);
  }

  assert.equal(CLAIM_MAX_ENTRIES, 200);
  assert.equal(activeConversationClaims.size, 200);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(activeConversationClaims.has(`conv-${index}`), false);
  }
  assert.equal(activeConversationClaims.has('conv-5'), true);
  assert.equal(activeConversationClaims.has('conv-204'), true);
});
