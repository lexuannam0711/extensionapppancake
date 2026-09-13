const CLAIM_TTL_MS = 60000;
const CLAIM_MAX_ENTRIES = 200;
const activeConversationClaims = new Map();

function getRuntimeId(runtime) {
  return String(runtime?.tabId || runtime?.id || '');
}

function pruneExpiredClaims(now = Date.now()) {
  for (const [key, claim] of activeConversationClaims) {
    if (!claim || now - Number(claim.ts || 0) > CLAIM_TTL_MS) activeConversationClaims.delete(key);
  }
}

function claimConversation(key, runtime, now = Date.now()) {
  const id = getRuntimeId(runtime);
  const claimKey = String(key || '').trim();
  if (!claimKey || !id) return false;
  pruneExpiredClaims(now);
  const existing = activeConversationClaims.get(claimKey);
  if (existing && existing.runtimeId !== id) return false;
  activeConversationClaims.set(claimKey, { runtimeId: id, ts: now });
  while (activeConversationClaims.size > CLAIM_MAX_ENTRIES) {
    activeConversationClaims.delete(activeConversationClaims.keys().next().value);
  }
  return true;
}

function releaseConversationClaim(key, runtime) {
  const id = getRuntimeId(runtime);
  const claimKey = String(key || '').trim();
  const existing = activeConversationClaims.get(claimKey);
  if (!existing || existing.runtimeId !== id) return false;
  activeConversationClaims.delete(claimKey);
  return true;
}

function clearConversationClaims() {
  activeConversationClaims.clear();
}

const PDBConversationClaims = {
  CLAIM_TTL_MS,
  CLAIM_MAX_ENTRIES,
  activeConversationClaims,
  pruneExpiredClaims,
  claimConversation,
  releaseConversationClaim,
  clearConversationClaims
};

if (typeof window !== 'undefined') window.PDBConversationClaims = PDBConversationClaims;
if (typeof module !== 'undefined' && module.exports) module.exports = PDBConversationClaims;
