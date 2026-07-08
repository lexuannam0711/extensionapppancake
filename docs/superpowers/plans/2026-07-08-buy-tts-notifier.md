# Buy Customer TTS Notifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a speaker TTS notification when the bot marks a customer as buyer/unread, while preserving all existing bot behavior.

**Architecture:** Add one focused renderer module, `buyTtsNotifier.js`, that owns TTS text selection, dedupe, debounce grouping, and fail-soft speech playback. Existing bot code only emits a buy-customer event from the current `ESCALATED` branch after tag/unread handling; settings/UI only control whether the side-effect runs and how long events are grouped.

**Tech Stack:** Electron renderer, browser Web Speech API (`speechSynthesis`, `SpeechSynthesisUtterance`), CommonJS-compatible renderer globals, Node `node:test`.

## Global Constraints

- Admin/Sếp tổng approved **option 2: independent renderer module**.
- Do not rewrite bot classification, tag, unread, Telegram, address lookup, review queue, Auto Click, or webview tab logic.
- TTS must be a fail-soft side effect: any TTS failure returns locally and must not throw into `processOneConversation`.
- Do not read customer name, phone number, address, or message content aloud; only speak the approved summary phrases.
- Single full-contact phrase: `Khách mua hàng, địa chỉ và số điện thoại đầy đủ`.
- Single missing-contact phrase: `Khách mua hàng mới`.
- Grouped phrase: `Có X khách mua hàng`.
- Default grouping window: `1500` milliseconds.
- Default dedupe TTL: `60000` milliseconds.
- Default language: `vi-VN`.
- No new npm dependencies.
- Before editing any function/class/method, run GitNexus impact on that symbol with `direction: "upstream"`; warn Admin and stop for approval if risk is HIGH or CRITICAL.
- Before any commit, run `gitnexus_detect_changes()` and confirm the affected scope matches this feature.
- Do not commit, push, deploy, publish, delete runtime data, or change secrets without Admin approval.

---

## File Structure

- Create `src/renderer/buyTtsNotifier.js`
  - Owns buy-customer TTS helper functions, event batching, dedupe, and Web Speech playback.
  - Exposes `window.PDBBuyTtsNotifier` in Electron renderer and `module.exports` for Node tests.

- Create `test/buy-tts-notifier.test.js`
  - Tests phrase selection, debounce grouping, separated batches, dedupe, disabled settings, and missing speech support.

- Modify `package.json`
  - Add `src/renderer/buyTtsNotifier.js` to the existing `npm run check` syntax-check list.

- Modify `src/server/store.js`
  - Add persisted settings defaults: `buyTtsEnabled: true`, `buyTtsDebounceMs: 1500`.

- Modify `src/renderer/index.html`
  - Add a minimal checkbox and debounce input in the existing Bot settings card.
  - Load `buyTtsNotifier.js` before `app.js`.

- Modify `src/renderer/app.js`
  - Load/save new settings in the existing settings functions.
  - Emit a buy-customer TTS notification from the existing `ESCALATED` branch after the success log, without awaiting speech playback.

---

### Task 0: Preflight GitNexus and Working Tree Gate

**Files:**
- Read/check only: repository status and GitNexus symbol impact.

**Interfaces:**
- Consumes: Current indexed repo name `pancake-desktop-ai-shortcut-bot-v3`.
- Produces: Confirmed low/acceptable blast radius before implementation edits.

- [ ] **Step 1: Confirm the working tree starts clean or only has approved docs**

Run:

```powershell
git status --short
```

Expected before product-code implementation starts: either no output, or only the already-approved plan document:

```text
?? docs/superpowers/plans/2026-07-08-buy-tts-notifier.md
```

- [ ] **Step 2: Run GitNexus impact for `processOneConversation`**

Use MCP/tooling equivalent to:

```json
{
  "target": "processOneConversation",
  "direction": "upstream",
  "file_path": "src/renderer/app.js",
  "kind": "Function",
  "maxDepth": 3,
  "relationTypes": ["CALLS", "IMPORTS"],
  "includeTests": true,
  "repo": "pancake-desktop-ai-shortcut-bot-v3"
}
```

Expected: risk LOW or MEDIUM. If GitNexus reports a stale index, run:

```powershell
npx gitnexus analyze
```

Then rerun the impact query. If the final risk is HIGH or CRITICAL, stop and ask Admin for explicit approval before editing.

- [ ] **Step 3: Run GitNexus impact for settings functions that will be edited**

Use MCP/tooling equivalent to these three calls:

```json
{
  "target": "loadSettings",
  "direction": "upstream",
  "file_path": "src/renderer/app.js",
  "kind": "Function",
  "maxDepth": 3,
  "relationTypes": ["CALLS", "IMPORTS"],
  "includeTests": true,
  "repo": "pancake-desktop-ai-shortcut-bot-v3"
}
```

```json
{
  "target": "saveSettingsFromUi",
  "direction": "upstream",
  "file_path": "src/renderer/app.js",
  "kind": "Function",
  "maxDepth": 3,
  "relationTypes": ["CALLS", "IMPORTS"],
  "includeTests": true,
  "repo": "pancake-desktop-ai-shortcut-bot-v3"
}
```

```json
{
  "target": "getSettings",
  "direction": "upstream",
  "file_path": "src/server/store.js",
  "kind": "Function",
  "maxDepth": 3,
  "relationTypes": ["CALLS", "IMPORTS"],
  "includeTests": true,
  "repo": "pancake-desktop-ai-shortcut-bot-v3"
}
```

Expected: each risk LOW or MEDIUM. If any risk is HIGH or CRITICAL, stop and ask Admin for explicit approval before editing.

---

### Task 1: Unit-Tested Renderer TTS Notifier Module

**Files:**
- Create: `test/buy-tts-notifier.test.js`
- Create: `src/renderer/buyTtsNotifier.js`
- Modify: `package.json:9`

**Interfaces:**
- Consumes: Browser-compatible `speechSynthesis` and `SpeechSynthesisUtterance` when available.
- Produces:
  - `hasFullContact(event: object): boolean`
  - `buildSingleBuySpeech(event: object): string`
  - `buildGroupedBuySpeech(count: number): string`
  - `makeBuyEventKey(event: object): string`
  - `createBuyTtsNotifier(options: object): object`
  - `window.PDBBuyTtsNotifier.notifyBuyCustomer(event: object, settings?: object): boolean`

- [ ] **Step 1: Write the failing test**

Create `test/buy-tts-notifier.test.js` with this complete content:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUY_TTS_FULL_CONTACT_TEXT,
  BUY_TTS_NEW_CUSTOMER_TEXT,
  hasFullContact,
  buildSingleBuySpeech,
  buildGroupedBuySpeech,
  createBuyTtsNotifier
} = require('../src/renderer/buyTtsNotifier');

function createClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map();

  function runDueTimers() {
    let ran = true;
    while (ran) {
      ran = false;
      for (const [id, timer] of Array.from(timers.entries())) {
        if (timer.at <= current) {
          timers.delete(id);
          timer.fn();
          ran = true;
        }
      }
    }
  }

  return {
    now: () => current,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: current + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    tick(ms) {
      current += ms;
      runDueTimers();
    }
  };
}

function createSpeechMock() {
  const spoken = [];
  function Utterance(text) {
    this.text = text;
  }
  return {
    spoken,
    Utterance,
    speechSynthesis: {
      getVoices: () => [{ lang: 'vi-VN', name: 'Vietnamese' }],
      speak: (utterance) => spoken.push({
        text: utterance.text,
        lang: utterance.lang,
        volume: utterance.volume,
        voiceLang: utterance.voice ? utterance.voice.lang : ''
      })
    }
  };
}

test('buy tts: chooses full-contact speech only when phone and address are present', () => {
  assert.equal(hasFullContact({ phone: '0912345678', address: '12 Nguyễn Trãi' }), true);
  assert.equal(hasFullContact({ phone: '0912345678', address: '' }), false);
  assert.equal(hasFullContact({ phone: '', address: '12 Nguyễn Trãi' }), false);
  assert.equal(hasFullContact({}), false);

  assert.equal(
    buildSingleBuySpeech({ phone: '0912345678', address: '12 Nguyễn Trãi' }),
    BUY_TTS_FULL_CONTACT_TEXT
  );
  assert.equal(buildSingleBuySpeech({ phone: '0912345678' }), BUY_TTS_NEW_CUSTOMER_TEXT);
  assert.equal(buildSingleBuySpeech({ address: '12 Nguyễn Trãi' }), BUY_TTS_NEW_CUSTOMER_TEXT);
});

test('buy tts: builds grouped speech with customer count', () => {
  assert.equal(buildGroupedBuySpeech(2), 'Có 2 khách mua hàng');
  assert.equal(buildGroupedBuySpeech(5), 'Có 5 khách mua hàng');
});

test('buy tts: speaks one full-contact event after debounce window', () => {
  const clock = createClock();
  const speech = createSpeechMock();
  const notifier = createBuyTtsNotifier({
    speechSynthesis: speech.speechSynthesis,
    SpeechSynthesisUtterance: speech.Utterance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    debounceMs: 1500
  });

  assert.equal(notifier.notifyBuyCustomer({ phone: '0912345678', address: '12 Nguyễn Trãi' }), true);
  clock.tick(1499);
  assert.equal(speech.spoken.length, 0);
  clock.tick(1);

  assert.equal(speech.spoken.length, 1);
  assert.equal(speech.spoken[0].text, BUY_TTS_FULL_CONTACT_TEXT);
  assert.equal(speech.spoken[0].lang, 'vi-VN');
  assert.equal(speech.spoken[0].volume, 1);
  assert.equal(speech.spoken[0].voiceLang, 'vi-VN');
});

test('buy tts: groups two buy events that arrive inside one debounce window', () => {
  const clock = createClock();
  const speech = createSpeechMock();
  const notifier = createBuyTtsNotifier({
    speechSynthesis: speech.speechSynthesis,
    SpeechSynthesisUtterance: speech.Utterance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    debounceMs: 1500
  });

  assert.equal(notifier.notifyBuyCustomer({ customerName: 'A', message: 'mua 1' }), true);
  clock.tick(500);
  assert.equal(notifier.notifyBuyCustomer({ customerName: 'B', message: 'mua 2' }), true);
  clock.tick(1499);
  assert.equal(speech.spoken.length, 0);
  clock.tick(1);

  assert.equal(speech.spoken.length, 1);
  assert.equal(speech.spoken[0].text, 'Có 2 khách mua hàng');
});

test('buy tts: separated events outside debounce become separate speech messages', () => {
  const clock = createClock();
  const speech = createSpeechMock();
  const notifier = createBuyTtsNotifier({
    speechSynthesis: speech.speechSynthesis,
    SpeechSynthesisUtterance: speech.Utterance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    debounceMs: 1500
  });

  assert.equal(notifier.notifyBuyCustomer({ customerName: 'A', message: 'mua 1' }), true);
  clock.tick(1500);
  assert.equal(notifier.notifyBuyCustomer({ customerName: 'B', message: 'mua 2' }), true);
  clock.tick(1500);

  assert.equal(speech.spoken.map((item) => item.text), [
    BUY_TTS_NEW_CUSTOMER_TEXT,
    BUY_TTS_NEW_CUSTOMER_TEXT
  ]);
});

test('buy tts: dedupes the same event inside ttl', () => {
  const clock = createClock();
  const speech = createSpeechMock();
  const notifier = createBuyTtsNotifier({
    speechSynthesis: speech.speechSynthesis,
    SpeechSynthesisUtterance: speech.Utterance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    debounceMs: 1500,
    dedupeTtlMs: 60000
  });
  const event = {
    customerName: 'Khách A',
    phone: '0912345678',
    address: '12 Nguyễn Trãi',
    message: 'mua hàng giao em'
  };

  assert.equal(notifier.notifyBuyCustomer(event), true);
  assert.equal(notifier.notifyBuyCustomer(event), false);
  clock.tick(1500);

  assert.equal(speech.spoken.length, 1);
  assert.equal(speech.spoken[0].text, BUY_TTS_FULL_CONTACT_TEXT);
});

test('buy tts: disabled setting prevents queueing and speaking', () => {
  const clock = createClock();
  const speech = createSpeechMock();
  const notifier = createBuyTtsNotifier({
    speechSynthesis: speech.speechSynthesis,
    SpeechSynthesisUtterance: speech.Utterance,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    debounceMs: 1500
  });

  assert.equal(notifier.notifyBuyCustomer({ customerName: 'A' }, { buyTtsEnabled: false }), false);
  clock.tick(1500);

  assert.equal(speech.spoken.length, 0);
});

test('buy tts: missing speech support fails softly', () => {
  const clock = createClock();
  const notifier = createBuyTtsNotifier({
    speechSynthesis: null,
    SpeechSynthesisUtterance: null,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    debounceMs: 1500
  });

  assert.equal(notifier.notifyBuyCustomer({ customerName: 'A' }), true);
  clock.tick(1500);

  assert.equal(notifier.getLastSpokenText(), '');
});
```

- [ ] **Step 2: Run the test to verify it fails before implementation**

Run:

```powershell
node --test test/buy-tts-notifier.test.js
```

Expected: FAIL with a module resolution error for `../src/renderer/buyTtsNotifier`.

- [ ] **Step 3: Write the minimal complete notifier implementation**

Create `src/renderer/buyTtsNotifier.js` with this complete content:

```js
const BUY_TTS_FULL_CONTACT_TEXT = 'Khách mua hàng, địa chỉ và số điện thoại đầy đủ';
const BUY_TTS_NEW_CUSTOMER_TEXT = 'Khách mua hàng mới';
const BUY_TTS_DEFAULT_DEBOUNCE_MS = 1500;
const BUY_TTS_DEDUPE_TTL_MS = 60000;

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeKeyPart(value) {
  return normalizeText(value).toLowerCase();
}

function hasFullContact(event = {}) {
  return Boolean(normalizeText(event.phone) && normalizeText(event.address));
}

function buildSingleBuySpeech(event = {}) {
  return hasFullContact(event) ? BUY_TTS_FULL_CONTACT_TEXT : BUY_TTS_NEW_CUSTOMER_TEXT;
}

function buildGroupedBuySpeech(count) {
  return `Có ${Number(count) || 0} khách mua hàng`;
}

function makeBuyEventKey(event = {}) {
  const message = normalizeKeyPart(event.message).slice(0, 120);
  const key = [
    event.conversationId,
    event.customerName,
    event.phone,
    event.address,
    message
  ].map(normalizeKeyPart).join('|');
  return key.replace(/\|/g, '') ? key : '';
}

function pruneSeen(seen, now, ttlMs) {
  for (const [key, timestamp] of seen.entries()) {
    if (now - timestamp > ttlMs) seen.delete(key);
  }
}

function readPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(0, Math.min(1, number));
}

function resolveVietnameseVoice(speechSynthesis) {
  try {
    const voices = typeof speechSynthesis?.getVoices === 'function' ? speechSynthesis.getVoices() : [];
    return voices.find((voice) => /^vi\b/i.test(voice.lang || ''))
      || voices.find((voice) => /vietnam/i.test(`${voice.lang || ''} ${voice.name || ''}`))
      || null;
  } catch (_) {
    return null;
  }
}

function createBuyTtsNotifier(options = {}) {
  const getSpeechSynthesis = options.getSpeechSynthesis || (() => (
    options.speechSynthesis || (typeof window !== 'undefined' ? window.speechSynthesis : null)
  ));
  const getUtteranceCtor = options.getSpeechSynthesisUtterance || (() => (
    options.SpeechSynthesisUtterance || (typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null)
  ));
  const setTimer = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeout || ((id) => clearTimeout(id));
  const now = options.now || (() => Date.now());
  const defaultDebounceMs = readPositiveNumber(options.debounceMs, BUY_TTS_DEFAULT_DEBOUNCE_MS);
  const dedupeTtlMs = readPositiveNumber(options.dedupeTtlMs, BUY_TTS_DEDUPE_TTL_MS);
  const lang = options.lang || 'vi-VN';
  const rate = Number.isFinite(Number(options.rate)) ? Number(options.rate) : 1;
  const pitch = Number.isFinite(Number(options.pitch)) ? Number(options.pitch) : 1;
  const volume = clampVolume(options.volume);

  let timer = null;
  let queue = [];
  let lastSpokenText = '';
  const seen = new Map();

  function notifyBuyCustomer(event = {}, settings = {}) {
    try {
      if (settings.buyTtsEnabled === false) return false;
      const timestamp = now();
      pruneSeen(seen, timestamp, dedupeTtlMs);

      const key = makeBuyEventKey(event);
      if (key && seen.has(key)) return false;
      if (key) seen.set(key, timestamp);

      queue.push({ ...event, timestamp: event.timestamp || timestamp });
      if (timer) clearTimer(timer);
      const debounceMs = readPositiveNumber(settings.buyTtsDebounceMs, defaultDebounceMs);
      timer = setTimer(flush, debounceMs);
      return true;
    } catch (_) {
      return false;
    }
  }

  function flush() {
    try {
      const batch = queue.splice(0, queue.length);
      timer = null;
      if (!batch.length) return '';
      const text = batch.length > 1 ? buildGroupedBuySpeech(batch.length) : buildSingleBuySpeech(batch[0]);
      speak(text);
      return text;
    } catch (_) {
      return '';
    }
  }

  function speak(text) {
    try {
      const speechSynthesis = getSpeechSynthesis();
      const Utterance = getUtteranceCtor();
      if (!speechSynthesis || typeof speechSynthesis.speak !== 'function' || typeof Utterance !== 'function') return false;

      const utterance = new Utterance(text);
      utterance.lang = lang;
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = volume;
      const voice = resolveVietnameseVoice(speechSynthesis);
      if (voice) utterance.voice = voice;

      speechSynthesis.speak(utterance);
      lastSpokenText = text;
      return true;
    } catch (_) {
      return false;
    }
  }

  function clear() {
    if (timer) clearTimer(timer);
    timer = null;
    queue = [];
    seen.clear();
    lastSpokenText = '';
  }

  return {
    notifyBuyCustomer,
    flush,
    speak,
    clear,
    getQueueSize: () => queue.length,
    getLastSpokenText: () => lastSpokenText
  };
}

const defaultNotifier = createBuyTtsNotifier();

const PDBBuyTtsNotifier = {
  BUY_TTS_FULL_CONTACT_TEXT,
  BUY_TTS_NEW_CUSTOMER_TEXT,
  BUY_TTS_DEFAULT_DEBOUNCE_MS,
  BUY_TTS_DEDUPE_TTL_MS,
  normalizeText,
  hasFullContact,
  buildSingleBuySpeech,
  buildGroupedBuySpeech,
  makeBuyEventKey,
  createBuyTtsNotifier,
  notifyBuyCustomer: defaultNotifier.notifyBuyCustomer,
  flush: defaultNotifier.flush,
  speak: defaultNotifier.speak,
  clear: defaultNotifier.clear
};

if (typeof window !== 'undefined') window.PDBBuyTtsNotifier = PDBBuyTtsNotifier;
if (typeof module !== 'undefined' && module.exports) module.exports = PDBBuyTtsNotifier;
```

- [ ] **Step 4: Add the new file to syntax checks**

In `package.json`, replace the existing `check` script with this exact value:

```json
"check": "node --check src/main.js && node --check src/preload.js && node --check src/server/index.js && node --check src/server/addressLookup.js && node --check src/server/ai.js && node --check src/server/rules.js && node --check src/server/shortcutImporter.js && node --check src/server/shortcutMatcher.js && node --check src/server/store.js && node --check src/server/validators.js && node --check src/renderer/app.js && node --check src/renderer/automation.js && node --check src/renderer/botDecision.js && node --check src/renderer/buyTtsNotifier.js && node --check src/renderer/conversationClaims.js && node --check src/renderer/icons.js"
```

- [ ] **Step 5: Run unit and syntax checks**

Run:

```powershell
node --test test/buy-tts-notifier.test.js
npm run check
```

Expected: all tests pass and all `node --check` commands exit with code 0.

- [ ] **Step 6: Commit this task only after Admin approves committing**

Run only after Admin says to commit:

```powershell
git add package.json src/renderer/buyTtsNotifier.js test/buy-tts-notifier.test.js
git commit -m @'
feat: add buy customer TTS notifier

Co-Authored-By: Claude <noreply@anthropic.com>
'@
```

---

### Task 2: Add TTS Settings Defaults and Minimal Bot UI

**Files:**
- Modify: `src/server/store.js:31-50`
- Modify: `src/renderer/index.html:91-106`
- Modify: `src/renderer/index.html:224-227`
- Modify: `src/renderer/app.js:335-367`

**Interfaces:**
- Consumes: `buyTtsEnabled` and `buyTtsDebounceMs` values from `/api/settings`.
- Produces:
  - `settings.buyTtsEnabled: boolean`, default `true`
  - `settings.buyTtsDebounceMs: number`, default `1500`
  - DOM controls `#buyTtsEnabled` and `#buyTtsDebounceMs`

- [ ] **Step 1: Add settings defaults**

In `src/server/store.js`, replace `getSettings()` with this exact function:

```js
async function getSettings() {
  return readJson('settings.json', {
    botEnabled: false,
    autoSend: false,
    shortcutOnlyMode: true,
    minConfidence: 0.75,
    defaultNewCustomerShortcut: '/1',
    newCustomerTagName: 'Saruto Mới',
    buyTagName: 'Mua hàng',
    buyTtsEnabled: true,
    buyTtsDebounceMs: 1500,
    allowShortcutAfterBuyIntent: false,
    processDelayMs: 3000,
    scanIntervalMs: 2500,
    autoClickEnabled: false,
    autoClickDelayMs: 3000,
    learnExamplesEnabled: true,
    theme: 'light',
    aiBaseUrl: '',
    aiApiKey: '',
    aiModel: ''
  });
}
```

- [ ] **Step 2: Add minimal controls in the Bot settings card**

In `src/renderer/index.html`, replace the existing Bot settings card block inside `<section id="bot" class="tab-panel">` with this exact block:

```html
        <div class="card">
          <div class="card-title-row"><h3>Điều khiển bot</h3><span id="activeTabBotStatus" class="tab-runtime-status">Bot 1: Stopped</span></div>
          <label class="toggle"><input id="botEnabled" type="checkbox" /> <span>Bật bot loop</span></label>
          <label class="toggle"><input id="autoSend" type="checkbox" /> <span>Auto Send shortcut</span></label>
          <label class="toggle"><input id="shortcutOnlyMode" type="checkbox" checked /> <span>Chỉ cho gửi /n</span></label>
          <label class="toggle"><input id="buyTtsEnabled" type="checkbox" checked /> <span>Đọc loa khi có khách mua hàng</span></label>
          <div class="form-row"><label>Shortcut khách mới</label><input id="newCustomerShortcut" value="/1" /></div>
          <div class="form-row"><label>Tag khách mới</label><input id="newCustomerTag" value="Saruto Mới" /></div>
          <div class="form-row"><label>Tag mua hàng</label><input id="buyTag" value="Mua hàng" /></div>
          <div class="form-row"><label>Gộp đọc loa (ms)</label><input id="buyTtsDebounceMs" type="number" min="300" step="100" value="1500" /></div>
          <div class="form-row"><label>Confidence auto send</label><input id="minConfidence" type="number" min="0" max="1" step="0.05" value="0.75" /></div>
          <div class="actions">
            <button id="saveSettingsBtn" class="btn">Lưu settings</button>
            <button id="startBotBtn" class="btn success">Start</button>
            <button id="stopBotBtn" class="btn danger">Emergency Stop</button>
          </div>
        </div>
```

- [ ] **Step 3: Load the notifier script before app.js**

In `src/renderer/index.html`, replace the script block at the end of `<body>` with this exact block:

```html
  <script src="icons.js"></script>
  <script src="botDecision.js"></script>
  <script src="conversationClaims.js"></script>
  <script src="buyTtsNotifier.js"></script>
  <script src="app.js"></script>
```

- [ ] **Step 4: Load the new settings into the UI**

In `src/renderer/app.js`, replace `loadSettings()` with this exact function:

```js
async function loadSettings() {
  settings = await api('/api/settings');
  $('botEnabled').checked = Boolean(settings.botEnabled);
  $('autoSend').checked = Boolean(settings.autoSend);
  $('shortcutOnlyMode').checked = settings.shortcutOnlyMode !== false;
  if ($('buyTtsEnabled')) $('buyTtsEnabled').checked = settings.buyTtsEnabled !== false;
  if ($('buyTtsDebounceMs')) $('buyTtsDebounceMs').value = settings.buyTtsDebounceMs || 1500;
  if ($('learnExamplesEnabled')) $('learnExamplesEnabled').checked = settings.learnExamplesEnabled !== false;
  $('newCustomerShortcut').value = settings.defaultNewCustomerShortcut || '/1';
  $('newCustomerTag').value = settings.newCustomerTagName || 'Saruto Mới';
  $('buyTag').value = settings.buyTagName || 'Mua hàng';
  $('minConfidence').value = settings.minConfidence || 0.75;
  if ($('autoClickDelayMs')) $('autoClickDelayMs').value = settings.autoClickDelayMs || 3000;
  refreshActiveTabRuntimeUi();
}
```

- [ ] **Step 5: Save the new settings from the UI**

In `src/renderer/app.js`, replace `saveSettingsFromUi()` with this exact function:

```js
async function saveSettingsFromUi() {
  settings = await api('/api/settings', {
    method: 'POST',
    body: JSON.stringify({
      botEnabled: Boolean($('botEnabled').checked || anyRuntimeBotRunning()),
      autoSend: $('autoSend').checked,
      shortcutOnlyMode: $('shortcutOnlyMode').checked,
      defaultNewCustomerShortcut: $('newCustomerShortcut').value.trim() || '/1',
      newCustomerTagName: $('newCustomerTag').value.trim() || 'Saruto Mới',
      buyTagName: $('buyTag').value.trim() || 'Mua hàng',
      buyTtsEnabled: $('buyTtsEnabled') ? $('buyTtsEnabled').checked : true,
      buyTtsDebounceMs: Number(($('buyTtsDebounceMs') && $('buyTtsDebounceMs').value) || 1500),
      minConfidence: Number($('minConfidence').value || 0.75),
      autoClickEnabled: Boolean(($('autoClickEnabled') && $('autoClickEnabled').checked) || anyRuntimeAutoClickRunning()),
      autoClickDelayMs: Number(($('autoClickDelayMs') && $('autoClickDelayMs').value) || 3000),
      learnExamplesEnabled: $('learnExamplesEnabled') ? $('learnExamplesEnabled').checked : true
    })
  });
  toast('Đã lưu settings');
  await loadHealth();
}
```

- [ ] **Step 6: Run checks for this task**

Run:

```powershell
npm run check
node --test test/buy-tts-notifier.test.js
```

Expected: syntax checks pass and TTS notifier tests still pass.

- [ ] **Step 7: Commit this task only after Admin approves committing**

Run only after Admin says to commit:

```powershell
git add src/server/store.js src/renderer/index.html src/renderer/app.js
git commit -m @'
feat: add buy TTS settings controls

Co-Authored-By: Claude <noreply@anthropic.com>
'@
```

---

### Task 3: Hook TTS Event Into the Existing Buy Escalation Flow

**Files:**
- Modify: `src/renderer/app.js:994-1030`

**Interfaces:**
- Consumes: `window.PDBBuyTtsNotifier.notifyBuyCustomer(event, settings)` from Task 1.
- Produces: Buy-customer events containing `customerName`, `phone`, `address`, `message`, `tabId`, and `conversationId`.

- [ ] **Step 1: Insert the notifier call in the `ESCALATED` branch**

In `src/renderer/app.js`, replace the existing `if (postDecision.action === 'ESCALATED') { ... }` branch with this exact block:

```js
  if (postDecision.action === 'ESCALATED') {
    const health = await getDomHealthSafe(runtime);
    if (!health.canTag) await log('WARN', 'BOT', prefixRuntime(runtime, `Fail-safe: DOM thiếu tag controls khi xử lý mua hàng cho ${customerName || info.name}`), { message, health, postDecision });
    else await call('applyTagByName', postDecision.tagName);
    await sleep(400);
    if (!health.canMarkUnread) await log('WARN', 'BOT', prefixRuntime(runtime, `Fail-safe: DOM thiếu mark unread cho ${customerName || info.name}`), { message, health, postDecision });
    else await call('markCurrentConversationUnread');
    const ci = analysis.contactInfo || {};
    let addressLookup = null;
    if (ci.address) {
      try {
        const lookupResult = await api('/api/address/lookup', {
          method: 'POST',
          body: JSON.stringify({ customerName: customerName || info.name || '', phone: ci.phone, message })
        });
        addressLookup = lookupResult?.lookup || null;
        analysis.addressLookup = addressLookup;
      } catch (err) {
        await log('WARN', 'BOT', prefixRuntime(runtime, 'Tra địa chỉ Google Maps: lỗi'), { message, error: err?.message || String(err) });
      }
    }
    const contactNote = [ci.phone ? `SĐT ${ci.phone}` : '', ci.address ? `ĐC: ${ci.address}` : ''].filter(Boolean).join(' | ');
    setRuntimeLastDecision(runtime, postDecision.action);
    await log('SUCCESS', 'BOT', prefixRuntime(runtime, `Khách mua hàng/escalate: ${customerName || info.name}${contactNote ? ' — ' + contactNote : ''}`), { message, analysis, postDecision });
    try {
      if (window.PDBBuyTtsNotifier) {
        window.PDBBuyTtsNotifier.notifyBuyCustomer({
          customerName: customerName || info.name || '',
          phone: ci.phone || '',
          address: ci.address || '',
          message,
          tabId: runtime.tabId,
          conversationId: info.id || info.conversationId || ''
        }, settings);
      }
    } catch (_) {}
    if (postDecision.shouldNotifyBuy) {
      try {
        const notifyResult = await api('/api/notify/buy', {
          method: 'POST',
          body: JSON.stringify({ customerName: customerName || info.name || '', phone: ci.phone, address: ci.address, message, addressLookup })
        });
        await log(notifyResult?.telegramSent ? 'SUCCESS' : 'WARN', 'BOT', prefixRuntime(runtime, `Telegram thông báo khách mua hàng: ${notifyResult?.telegramSent ? 'đã gửi' : 'gửi thất bại'}`), { message, analysis, notifyResult });
      } catch (err) {
        await log('WARN', 'BOT', prefixRuntime(runtime, 'Telegram thông báo khách mua hàng: gửi lỗi'), { message, analysis, error: err?.message || String(err) });
      }
    }
    await enqueueReviewCase({ info, customerName, message, analysis, runtime });
    return { ok: true, action: 'ESCALATED', analysis };
  }
```

- [ ] **Step 2: Run the automated checks**

Run:

```powershell
npm run check
npm test
```

Expected: `npm run check` exits with code 0 and `npm test` reports all tests passing.

- [ ] **Step 3: Verify the hook is fail-soft by temporarily disabling the global in DevTools**

Manual verification during an app run:

```js
window.PDBBuyTtsNotifier = null;
```

Then process a known buy/escalation case. Expected: bot still logs `Khách mua hàng/escalate`, Telegram/review queue behavior remains unchanged, and there is no thrown renderer error caused by TTS.

- [ ] **Step 4: Commit this task only after Admin approves committing**

Run only after Admin says to commit:

```powershell
git add src/renderer/app.js
git commit -m @'
feat: announce buy customers with TTS

Co-Authored-By: Claude <noreply@anthropic.com>
'@
```

---

### Task 4: End-to-End QA, Privacy Review, and GitNexus Detect Changes

**Files:**
- Read/check only: `git diff`, runtime app, GitNexus change report.

**Interfaces:**
- Consumes: Completed Tasks 1-3.
- Produces: Admin-ready verification report.

- [ ] **Step 1: Run full automated verification**

Run:

```powershell
npm run check
npm test
```

Expected: both commands exit with code 0.

- [ ] **Step 2: Run the app for manual verification**

Run:

```powershell
npm start
```

Expected: Electron app opens and the Bot tab shows:

```text
Đọc loa khi có khách mua hàng
Gộp đọc loa (ms)
```

- [ ] **Step 3: Manual flow — one buy customer with phone and address**

Use a safe test conversation or controlled Pancake test data. Trigger a buy-customer message containing both phone and address.

Expected observable results:

```text
- Existing buy tag is applied as before.
- Conversation is marked unread as before.
- Existing log line still appears: Khách mua hàng/escalate...
- Existing Telegram notification behavior is unchanged.
- Existing review queue behavior is unchanged.
- Speaker says: Khách mua hàng, địa chỉ và số điện thoại đầy đủ
```

- [ ] **Step 4: Manual flow — one buy customer missing either phone or address**

Trigger a buy-customer message with only phone, only address, or neither.

Expected speaker phrase:

```text
Khách mua hàng mới
```

Expected existing behavior: tag/unread/log/Telegram/review queue remains unchanged.

- [ ] **Step 5: Manual flow — two bots close together**

Start Bot 1 and Bot 2, then trigger two different buy-customer cases within the configured `1500` ms grouping window.

Expected speaker phrase:

```text
Có 2 khách mua hàng
```

Expected existing behavior: both customers are still processed independently by the current bot flow.

- [ ] **Step 6: Manual flow — setting disabled**

Uncheck `Đọc loa khi có khách mua hàng`, click `Lưu settings`, and trigger a buy-customer case.

Expected:

```text
- No speaker phrase is played.
- Existing buy tag, unread, log, Telegram, and review queue behavior remains unchanged.
```

- [ ] **Step 7: Privacy check**

Review `src/renderer/buyTtsNotifier.js` and the manual observations. Confirm:

```text
- TTS never speaks customerName.
- TTS never speaks phone.
- TTS never speaks address.
- TTS never speaks message.
- TTS only speaks the three approved summary phrase shapes.
```

- [ ] **Step 8: GitNexus detect changes before commit**

Use MCP/tooling equivalent to:

```json
{
  "scope": "all",
  "repo": "pancake-desktop-ai-shortcut-bot-v3"
}
```

Expected affected scope:

```text
- Renderer settings load/save flow.
- Renderer buy/escalation flow.
- Server settings defaults.
- New renderer TTS notifier tests/module.
```

If unrelated flows appear, inspect the diff before committing.

- [ ] **Step 9: Inspect git diff and runtime-data safety**

Run:

```powershell
git status --short
git diff --check
git diff -- src/renderer/buyTtsNotifier.js src/renderer/app.js src/renderer/index.html src/server/store.js package.json test/buy-tts-notifier.test.js
```

Expected:

```text
- git diff --check has no whitespace errors.
- No .env files are changed.
- No server/data/*.json files are changed.
- No uploads/* files are changed.
- No customer data is added to source or tests.
```

- [ ] **Step 10: Final commit only after Admin approves committing**

If Tasks 1-3 were not committed separately, run only after Admin says to commit:

```powershell
git add package.json src/renderer/buyTtsNotifier.js src/renderer/app.js src/renderer/index.html src/server/store.js test/buy-tts-notifier.test.js
git commit -m @'
feat: add buy customer TTS speaker notification

Co-Authored-By: Claude <noreply@anthropic.com>
'@
```

---

## Self-Review

**Spec coverage:** Covered option 2 independent module, Web Speech API, TTS phrases, 2-bot grouping, dedupe, settings, fail-soft behavior, privacy, tests, manual app verification, GitNexus impact, and detect-changes before commit.

**Placeholder scan:** The plan contains exact paths, exact function names, exact code blocks, exact commands, and expected results.

**Type consistency:** The notifier interface produced in Task 1 is the same interface consumed in Task 3: `window.PDBBuyTtsNotifier.notifyBuyCustomer(event, settings)`.
