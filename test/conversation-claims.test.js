const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLAIM_TTL_MS,
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
