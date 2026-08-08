# AI-Gated Repurchase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require AI analysis plus a deterministic purchase rule before a returning customer can be tagged `Mua hàng` and marked unread, while using `/32` only after a confident safe non-purchase decision.

**Architecture:** Keep the existing `analyzeMessageWithAI` boundary and renderer decision flow. The returning-customer branch performs deterministic safety/candidate checks, calls AI with the current message and five-message history, then combines both signals in a fail-closed decision matrix. The noneligible-customer branch is unchanged.

**Tech Stack:** Node.js CommonJS, Express route integration, Node built-in test runner, Electron renderer decision helpers, GitNexus CLI.

## Global Constraints

- Apply the new policy only when active tags match `Nhận Saruto…`, `Đã nhận TRÀ…`, or contain `Trống`.
- The current non-empty customer message takes precedence over older history.
- Never tag or mark unread unless both deterministic rules and AI confirm a real repurchase.
- Short confirmations require a preceding admin purchase offer within the final five messages.
- AI errors, invalid JSON, low confidence, ambiguity, complaint, refusal, contact-only, and non-text content fail closed.
- `/32` must exist in the configured shortcut list; Auto-send remains controlled by the existing route and renderer.
- Preserve all behavior for customers without eligible returning tags.
- Add no production dependency and do not commit, push, or deploy.

---

### Task 1: Returning-customer two-signal policy

**Files:**
- Modify: `src/server/ai.js:83-360`
- Test: `test/repurchase-policy.test.js`

**Interfaces:**
- Consumes: `detectExplicitRepurchase(text)`, `getRepurchaseBlocker(text)`, `validateShortcutOnly(candidate, items)`, `callAI(prompt, settings)`.
- Produces: `analyzeReturningCustomer({ customerMessage, items, context, settings, examples, history, matchedTags, ruleCandidate }) -> Promise<AnalysisResult>`.

- [ ] **Step 1: Replace deterministic-only expectations with failing AI-gate tests**

Add cases that mock AI and assert the full matrix:

```js
test('clear repurchase requires both rule candidate and AI confirmation', async () => {
  mockAI({
    intent: 'REPURCHASE_INTENT',
    action: 'TAG_BUY_AND_MARK_UNREAD',
    confidence: 0.92
  });
  const result = await analyze({ customerMessage: 'chị mua tiếp 2 hộp' });
  assert.equal(result.action, 'TAG_BUY_AND_MARK_UNREAD');
  assert.equal(result.repurchase.evidence, 'rule_and_ai');
});

test('rule candidate alone never escalates when AI is uncertain', async () => {
  mockAI({ intent: 'UNKNOWN', action: 'WAITING_REVIEW', confidence: 0.4 });
  const result = await analyze({ customerMessage: 'chị mua tiếp 2 hộp' });
  assert.equal(result.action, 'WAITING_REVIEW');
  assert.equal(Object.hasOwn(result, 'repurchase'), false);
});

test('AI alone cannot escalate without a matching rule', async () => {
  mockAI({
    intent: 'REPURCHASE_INTENT',
    action: 'TAG_BUY_AND_MARK_UNREAD',
    confidence: 0.99
  });
  const result = await analyze({ customerMessage: 'chị đang xem lại sản phẩm' });
  assert.equal(result.action, 'WAITING_REVIEW');
  assert.equal(Object.hasOwn(result, 'repurchase'), false);
});
```

- [ ] **Step 2: Add short-confirmation context tests**

```js
test('ok requires a preceding admin purchase offer and AI confirmation', async () => {
  mockAI({ intent: 'REPURCHASE_INTENT', action: 'TAG_BUY_AND_MARK_UNREAD', confidence: 0.91 });
  const confirmed = await analyze({
    customerMessage: 'ok em',
    history: [
      { from: 'admin', text: 'chị lấy thêm 2 hộp nhé' },
      { from: 'customer', text: 'ok em' }
    ]
  });
  assert.equal(confirmed.action, 'TAG_BUY_AND_MARK_UNREAD');

  const isolated = await analyze({
    customerMessage: 'ok em',
    history: [{ from: 'customer', text: 'ok em' }]
  });
  assert.notEqual(isolated.action, 'TAG_BUY_AND_MARK_UNREAD');
});
```

- [ ] **Step 3: Add safe `/32` and failure tests**

```js
test('AI-confirmed safe non-purchase selects configured /32', async () => {
  mockAI({
    intent: 'RETURNING_CUSTOMER_FOLLOWUP',
    action: 'SUGGEST_SHORTCUT',
    bestShortcut: '/32',
    confidence: 0.9
  });
  const result = await analyze({ customerMessage: 'chị đang dùng thử' });
  assert.equal(result.bestShortcut, '/32');
  assert.equal(result.action, 'SUGGEST_SHORTCUT');
});

test('AI failure or low confidence never sends /32 or escalates', async () => {
  mockAI('not json');
  const result = await analyze({ customerMessage: 'chị đang dùng thử' });
  assert.equal(result.action, 'WAITING_REVIEW');
  assert.equal(result.bestShortcut, null);
});
```

- [ ] **Step 4: Run the focused test and verify RED**

Run:

```powershell
node --test test\repurchase-policy.test.js
```

Expected: new two-signal tests fail because the current branch escalates or selects `/32` without calling AI.

- [ ] **Step 5: Implement the AI-gated decision matrix**

In `src/server/ai.js`, add focused helpers with these exact contracts:

```js
function isShortRepurchaseConfirmation(text) {
  const normalized = normalizeVietnameseText(text).replace(/[^a-z0-9]+/g, ' ').trim();
  return /^(?:ok|oke|oki|okay)(?:\s+(?:em|nhe))?$/.test(normalized);
}

function hasPrecedingAdminPurchaseOffer(history) {
  const recent = Array.isArray(history) ? history.slice(-5) : [];
  const lastCustomerIndex = recent.findLastIndex((item) => item?.from === 'customer');
  if (lastCustomerIndex < 1) return false;
  return recent.slice(0, lastCustomerIndex).some((item) =>
    item?.from === 'admin' && detectExplicitRepurchase(item.text)
  );
}
```

Build `ruleCandidate` as:

```js
const explicitCandidate = detectExplicitRepurchase(policyMessage);
const ruleCandidate = explicitCandidate && (
  !isShortRepurchaseConfirmation(policyMessage) ||
  hasPrecedingAdminPurchaseOffer(history)
);
```

Call AI for every safe text in the eligible-tag branch. Accept repurchase only with:

```js
const confirmedRepurchase = ruleCandidate &&
  parsed.intent === 'REPURCHASE_INTENT' &&
  parsed.action === 'TAG_BUY_AND_MARK_UNREAD' &&
  confidence >= minimum;
```

Return `repurchase: { matchedTags, evidence: 'rule_and_ai' }` only for `confirmedRepurchase`. Return `/32` only when AI returns the constrained safe follow-up result at sufficient confidence and `/32` validates against configured shortcuts. Otherwise return `WAITING_REVIEW`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```powershell
node --test test\repurchase-policy.test.js
```

Expected: all policy tests pass with zero failures.

### Task 2: Route and renderer regression coverage

**Files:**
- Modify: `test/repurchase-policy.test.js`
- Modify only if necessary: `test/repurchase-orchestration.test.js`
- Production renderer files: no planned change.

**Interfaces:**
- Consumes: `/api/ai/analyze-message`, `decideAfterAnalysis({ analysis, settings })`.
- Produces: regression evidence for Auto-send, final-admin guard, review, tagging, and unread behavior.

- [ ] **Step 1: Add route-level two-signal tests**

```js
test('route only escalates AI-confirmed rule candidates', async () => {
  const body = {
    customerMessage: 'chị mua tiếp 2 hộp',
    currentTags: ['Nhận Saruto 1'],
    conversationHistory: [{ from: 'customer', text: 'chị mua tiếp 2 hộp' }]
  };
  const confirmed = await analyzeThroughRoute({
    autoSend: true,
    body,
    aiResult: { intent: 'REPURCHASE_INTENT', action: 'TAG_BUY_AND_MARK_UNREAD', confidence: 0.95 }
  });
  assert.equal(confirmed.result.action, 'TAG_BUY_AND_MARK_UNREAD');
  assert.equal(confirmed.result.shouldSend, false);
});
```

- [ ] **Step 2: Verify `/32` Auto-send semantics remain unchanged**

Keep route assertions that Auto-send enabled produces `shouldSend: true` for an AI-confirmed `/32`, while Auto-send disabled produces `shouldSend: false`. Keep orchestration assertions for fill-only, send, and the final admin-sender guard.

- [ ] **Step 3: Run focused integration tests**

Run:

```powershell
node --test test\repurchase-policy.test.js test\repurchase-orchestration.test.js test\bot-decision.test.js
```

Expected: all tests pass.

- [ ] **Step 4: Run full verification**

Run:

```powershell
npm.cmd test
npm.cmd run check
node --test --experimental-test-coverage test\repurchase-policy.test.js test\repurchase-orchestration.test.js
git diff --check
npx.cmd gitnexus detect-changes -r extensionapppancake
```

Expected: full tests and syntax checks pass; `ai.js` and `rules.js` remain above 80% line coverage. GitNexus may continue to report CRITICAL for the pre-existing shared dirty worktree, which must be reported separately from this feature's LOW symbol impact.

- [ ] **Step 5: Independent review**

Request a read-only reviewer to verify the exact decision matrix, safety precedence, unchanged noneligible path, and test coverage. Address all HIGH/MEDIUM findings and rerun the full verification commands.

No commit step is included because Admin approval for commit/push/deploy has not been granted.
