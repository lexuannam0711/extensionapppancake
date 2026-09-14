// ===========================================================================
// Pancake Desktop AI Shortcut Bot — renderer
// Sections: state, helpers, server API, webview/automation, AI & learning,
// extensions, bot loop, UI bindings, init.
// ===========================================================================

const $ = (id) => document.getElementById(id);
const SHORTCUT_RE = /^\/\d+$/; // a valid shortcut is "/" followed by digits

// --- Mutable state ---
let serverUrl = 'http://localhost:8787';
let localApiToken = '';
let controlPlaneStatus = { configured: false, status: 'not_configured' };
let pancakeUrl = window.PDBPancakeUrlPolicy.DEFAULT_PANCAKE_URL;
const PANCAKE_CHAT_URL = window.PDBPancakeUrlPolicy.PANCAKE_CHAT_URL;
let automationProbeCode = '';
let automationAdapterCode = '';
let automationBootstrapCode = null;
let settings = {};
let shortcuts = [];
let examplesCache = [];
let learnedCount = 0;
let lastAnalysis = null;
let lastCustomerMessage = ''; // most recent analyzed message (used for learning)
let currentContextMessage = ''; // tin mới nhất của khách Trợ lý vừa đọc (live-suggest-fill)
let activeWvTab = 'bot1'; // 'bot1'/'bot2' run bot, 'manual' is clean/manual
let pageVisible = true;
let reviewQueueTimer = null;   // setInterval handle while the queue tab is open
let reviewQueueCache = [];     // last rendered pending items (kept on load error)
const timers = [];
const uncertainConversationBlocks = new Set();

// Cap the processed-conversation cache so a long-running bot session cannot
// grow memory without bound. Entries also expire by time (PROCESSED_TTL_MS).
const PROCESSED_MAX_ENTRIES = 200;
const PROCESSED_TTL_MS = 60000;

// --- Auto Click (chế độ tốc độ cao, độc lập hoàn toàn với Bot AI) ---
// State TÁCH BIỆT với botRunning/processed của Bot AI (không gộp chung).
const AUTOCLICK_PROCESSED_TTL_MS = 60000;
const AUTOCLICK_PROCESSED_MAX_ENTRIES = 200;

function createBotRuntime(tabId) {
  return {
    tabId,
    botRunning: false,
    botLoopPromise: null,
    processed: new Map(),
    lastAnalysis: null,
    lastCustomerMessage: '',
    currentContextMessage: '',
    autoClickRunning: false,
    autoClickLoopPromise: null,
    autoClickProcessed: new Map(),
    automationTransientErrorStreak: 0,
    autoClickTransientErrorStreak: 0,
    autoReplyPreviewRunning: false,
    autoReplyPreviewStopping: false,
    autoReplyPreviewLoopPromise: null,
    autoReplyPreviewState: 'idle'
  };
}

// --- DOM refs / webview registry ---
const webviewTabs = {
  bot1: { id: 'bot1', label: 'Bot 1', webview: $('botView1'), botCapable: true, automationInjected: false, loaded: false, loadState: 'idle', authState: 'ready', authLoginPending: false, authReturnUrl: '', readyHandledGeneration: -1, loadError: null, loadGeneration: 0, completedGeneration: -1, injectionGeneration: -1, expectedNavigationUrl: '', reloadGeneration: null, recovering: false, runtime: createBotRuntime('bot1') },
  bot2: { id: 'bot2', label: 'Bot 2', webview: $('botView2'), botCapable: true, automationInjected: false, loaded: false, loadState: 'idle', authState: 'ready', authLoginPending: false, authReturnUrl: '', readyHandledGeneration: -1, loadError: null, loadGeneration: 0, completedGeneration: -1, injectionGeneration: -1, expectedNavigationUrl: '', reloadGeneration: null, recovering: false, runtime: createBotRuntime('bot2') },
  manual: { id: 'manual', label: 'Tab 3', webview: $('manualView'), botCapable: false, automationInjected: false, loaded: false, loadState: 'idle', authState: 'ready', authLoginPending: false, authReturnUrl: '', loadError: null, loadGeneration: 0, completedGeneration: -1, injectionGeneration: -1, expectedNavigationUrl: '', reloadGeneration: null, recovering: false, runtime: null }
};

// Backward-compatible aliases for tests/older helpers that still inspect these names.
const pancakeView = webviewTabs.bot1.webview;
const cleanView = webviewTabs.manual.webview;
const processed = webviewTabs.bot1.runtime.processed;
const autoClickProcessed = webviewTabs.bot1.runtime.autoClickProcessed;
let botRunning = false;
let botLoopPromise = null;
let autoClickRunning = false;
let autoClickLoopPromise = null;
const AUTO_REPLY_PREVIEW_STORAGE_KEY = 'pdb-auto-reply-preview-settings';
let autoReplyPreviewCode = '';
let autoReplyPreviewStartLock = false;

// --- Trợ lý gợi ý real-time (suggest-only, độc lập botLoop) ---
let assistantEnabled = false;   // Công_Tắc_Trợ_Lý, mặc định TẮT (Req 4.2)
let assistantTimer = null;      // interval đọc id cuộc đang mở (1.2s)
let assistantDebounce = null;   // setTimeout debounce 1s (Req 6.2)
let lastConversationId = '';    // id cuộc xử lý gần nhất (phát hiện đổi cuộc)
const suggestCache = new Map(); // key: nội dung tin mới nhất -> analysis (Req 6.3/6.4)
const SUGGEST_CACHE_MAX = 100;  // chặn phình bộ nhớ

// Tạo khóa dedupe ổn định từ một unread conversation (Req 7.1).
// Ưu tiên id; thiếu id thì dùng tổ hợp name + snippet. An toàn khi conv null/undefined.
function makeDedupeKey(conv) {
  if (conv && conv.id) return String(conv.id);
  const name = (conv && conv.name) || '';
  const snippet = (conv && conv.snippet) || '';
  return `${name}-${snippet}`;
}

// Quyết định có bỏ qua khách vì đã có thẻ hay không (Req 4.1).
// Trả về true KHI VÀ CHỈ KHI hasTags === true HOẶC tags có ≥ 1 phần tử.
// An toàn khi info null/undefined → false.
function shouldSkipByTags(info) {
  if (window.PDBBotDecision?.shouldSkipByTags) return window.PDBBotDecision.shouldSkipByTags(info);
  if (!info) return false;
  return Boolean(info.hasTags || (info.tags || []).length > 0);
}

// Ghi key + timestamp vào autoClickProcessed; dọn mục quá TTL và giới hạn số mục
// (Req 7.2, 7.3, 7.4). Nhận `now` để test kiểm soát thời gian. Cùng style rememberProcessed.
function rememberAutoClickProcessed(key, now = Date.now(), runtime = getActiveBotRuntime() || webviewTabs.bot1.runtime) {
  const cache = runtime?.autoClickProcessed || autoClickProcessed;
  cache.set(key, now);
  for (const [k, ts] of cache) {
    if (now - ts > AUTOCLICK_PROCESSED_TTL_MS) cache.delete(k);
  }
  while (cache.size > AUTOCLICK_PROCESSED_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

const isShortcut = (value) => SHORTCUT_RE.test(String(value || '').trim());

// --- Theme (light/dark) ---
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.body.classList.toggle('dark', dark);
  const btn = $('themeBtn');
  if (btn) {
    if (window.PDBIcons) window.PDBIcons.set(btn, dark ? 'sun' : 'moon');
    else btn.textContent = dark ? '☀️' : '🌙';
    btn.setAttribute('aria-label', dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối');
  }
}

function syncLegacyRuntimeAliases(runtime = getActiveBotRuntime() || webviewTabs.bot1.runtime) {
  botRunning = Boolean(runtime?.botRunning);
  botLoopPromise = runtime?.botLoopPromise || null;
  autoClickRunning = Boolean(runtime?.autoClickRunning);
  autoClickLoopPromise = runtime?.autoClickLoopPromise || null;
}

function forEachBotTab(callback) {
  Object.values(webviewTabs).filter((tab) => tab.botCapable && tab.runtime).forEach(callback);
}

function anyRuntimeBotRunning() {
  return Object.values(webviewTabs).some((tab) => Boolean(tab.runtime?.botRunning));
}

function anyRuntimeAutoClickRunning() {
  return Object.values(webviewTabs).some((tab) => Boolean(tab.runtime?.autoClickRunning));
}

function anyRuntimeAutoReplyPreviewRunning() {
  return Object.values(webviewTabs).some((tab) => Boolean(tab.runtime?.autoReplyPreviewRunning || tab.runtime?.autoReplyPreviewStopping));
}

function isRuntimeAutomationActive(runtime) {
  return Boolean(runtime?.botRunning || runtime?.autoClickRunning || runtime?.autoReplyPreviewRunning || runtime?.autoReplyPreviewStopping);
}

function anyRuntimeAutomationActive() {
  return Object.values(webviewTabs).some((tab) => isRuntimeAutomationActive(tab.runtime));
}

function notifyMainAutomationState() {
  if (!window.pancakeDesktop?.setBotActive) return;
  forEachBotTab((tab) => {
    window.pancakeDesktop.setBotActive({
      tabId: tab.id,
      active: isRuntimeAutomationActive(tab.runtime)
    }).catch(() => {});
  });
}

function reconcileHiddenPolling() {
  if (pageVisible) return;
  if (anyRuntimeAutomationActive()) {
    startPolling();
  } else {
    stopPolling();
    stopAssistantWatch();
  }
}

function updateAutomationActivity() {
  notifyMainAutomationState();
  reconcileHiddenPolling();
}

function initTheme() {
  let theme = 'light';
  try { theme = localStorage.getItem('pdb-theme') || 'light'; } catch (_) {}
  applyTheme(theme);
}

function toggleTheme() {
  const dark = !document.body.classList.contains('dark');
  const theme = dark ? 'dark' : 'light';
  applyTheme(theme);
  try { localStorage.setItem('pdb-theme', theme); } catch (_) {}
}

function rememberProcessed(key, runtime = getActiveBotRuntime() || webviewTabs.bot1.runtime) {
  const now = Date.now();
  const cache = runtime?.processed || processed;
  cache.set(key, now);
  for (const [k, ts] of cache) {
    if (now - ts > PROCESSED_TTL_MS) cache.delete(k);
  }
  while (cache.size > PROCESSED_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

function rememberProcessedForAllBotRuntimes(key) {
  forEachBotTab((tab) => rememberProcessed(key, tab.runtime));
}

function rememberConversationProcessedEverywhere(key) {
  const now = Date.now();
  forEachBotTab((tab) => {
    rememberProcessed(key, tab.runtime);
    rememberAutoClickProcessed(key, now, tab.runtime);
  });
}

function wasConversationProcessedAnywhere(key, now = Date.now()) {
  return Object.values(webviewTabs).some((tab) => {
    const runtime = tab.runtime;
    if (!runtime) return false;
    const botTs = runtime.processed.get(key);
    const autoTs = runtime.autoClickProcessed.get(key);
    return Boolean(
      (botTs && now - botTs <= PROCESSED_TTL_MS)
      || (autoTs && now - autoTs <= AUTOCLICK_PROCESSED_TTL_MS)
    );
  });
}

function toast(message, ms = 2600) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

function renderControlPlaneStatus(next = {}) {
  controlPlaneStatus = next;
  const panel = $('accountAuth');
  if (!panel) return;
  panel.hidden = !next.configured;
  if (!next.configured) return;
  const signedIn = ['authenticated', 'online'].includes(next.status);
  const terminal = ['disabled', 'revoked', 'error'].includes(next.status);
  if ($('authLoginBtn')) $('authLoginBtn').hidden = signedIn || next.status === 'signing_in';
  if ($('authLogoutBtn')) $('authLogoutBtn').hidden = !(signedIn || terminal);
  if ($('accountEmail')) $('accountEmail').disabled = signedIn || next.status === 'signing_in';
  if ($('accountPassword')) $('accountPassword').disabled = signedIn || next.status === 'signing_in';
  if ($('authStatus')) $('authStatus').textContent = next.error ? `${next.status}: ${next.error}` : next.status;
  if ($('authStatusCompact')) $('authStatusCompact').textContent = next.error ? 'Error' : (next.status || 'Offline');
}

async function loadControlPlaneStatus() {
  if (!window.pancakeDesktop?.getAuthStatus) return;
  try { renderControlPlaneStatus(await window.pancakeDesktop.getAuthStatus()); }
  catch (error) { renderControlPlaneStatus({ configured: true, status: 'error', error: error.message }); }
}

async function signInOperator() {
  const email = $('accountEmail')?.value.trim();
  const password = $('accountPassword')?.value || '';
  if (!email || !password) return toast('Enter operator email and password', 4000);
  try {
    renderControlPlaneStatus({ ...controlPlaneStatus, status: 'signing_in', error: '' });
    renderControlPlaneStatus(await window.pancakeDesktop.login({ email, password }));
    if ($('accountPassword')) $('accountPassword').value = '';
    toast('Operator signed in');
  } catch (error) {
    renderControlPlaneStatus({ ...controlPlaneStatus, status: 'error', error: error.message });
    toast(error.message, 5000);
  }
}

async function signOutOperator() {
  try {
    renderControlPlaneStatus(await window.pancakeDesktop.logout());
    toast('Operator signed out');
  } catch (error) { toast(error.message, 5000); }
}
async function api(path, options = {}) {
  const res = await fetch(`${serverUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(localApiToken ? { 'x-local-api-token': localApiToken } : {}),
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch (_) {}
    throw new Error(`${res.status} ${res.statusText} ${detail}`);
  }
  return res.json();
}

async function log(level, type, message, data = null) {
  try { await api('/api/logs', { method: 'POST', body: JSON.stringify({ level, type, message, data }) }); } catch (_) {}
  await loadLogs();
}

function getTab(tabId = activeWvTab) {
  return webviewTabs[tabId] || webviewTabs.bot1;
}

function normalizePancakeBotUrl(url = pancakeUrl) {
  if (window.PDBPancakeUrlPolicy.classifyPancakeUrl(url) === 'auth') {
    return String(url || '').trim();
  }
  return window.PDBPancakeUrlPolicy.normalizeBotUrl(url) || PANCAKE_CHAT_URL;
}

function navigateWebview(tab, url) {
  if (!tab?.webview) return;
  const targetUrl = tab.botCapable ? normalizePancakeBotUrl(url) : url;
  const currentUrl = safeGetURL(tab.webview, tab.webview.src || '');
  const useSrcAssignment = window.PDBWebviewTabNavigation?.isBlankWebviewUrl(currentUrl);
  if (useSrcAssignment) {
    tab.loaded = false;
    tab.loadState = 'loading';
    tab.loadError = null;
    tab.automationInjected = false;
    tab.injectionGeneration = -1;
    tab.loadGeneration += 1;
    tab.reloadGeneration = null;
    tab.pendingNavigationToken = null;
    tab.expectedNavigationUrl = targetUrl;
    tab.webview.src = targetUrl;
  } else if (window.PDBWebviewAutomation?.startTrackedNavigation && typeof tab.webview.loadURL === 'function') {
    window.PDBWebviewAutomation.startTrackedNavigation(tab, targetUrl);
  } else {
    tab.loaded = false;
    tab.loadState = 'loading';
    tab.loadError = null;
    tab.automationInjected = false;
    tab.injectionGeneration = -1;
    tab.loadGeneration += 1;
    tab.reloadGeneration = null;
    tab.expectedNavigationUrl = targetUrl;
    tab.webview.src = targetUrl;
  }
  if (tab.id === activeWvTab && $('urlInput')) $('urlInput').value = targetUrl;
  return targetUrl;
}

async function reloadActiveWebview() {
  const tab = getTab(activeWvTab);
  const targetUrl = safeGetURL(tab.webview, tab.expectedNavigationUrl || tab.webview?.src || pancakeUrl);
  const result = window.PDBWebviewAutomation?.startTrackedReload
    ? window.PDBWebviewAutomation.startTrackedReload(tab, { targetUrl, fallbackUrl: pancakeUrl })
    : { ok: false, code: 'WEBVIEW_NOT_READY', reason: 'reload helper unavailable' };

  if (!result.ok) {
    const message = result.code === 'WEBVIEW_NOT_READY'
      ? 'Webview đang tải, chưa thể reload'
      : `Reload webview lỗi: ${serializeError(result.error || result.reason)}`;
    if ($('webviewStatus')) $('webviewStatus').textContent = message;
    toast(message, result.code === 'WEBVIEW_NOT_READY' ? 2200 : 5000);
    return result;
  }

  if ($('webviewStatus')) $('webviewStatus').textContent = 'Đang tải...';
  return result;
}

function getActiveBotRuntime() {
  const tab = getTab(activeWvTab);
  return tab.botCapable ? tab.runtime : null;
}

function getRuntimeLabel(runtime) {
  return getTab(runtime?.tabId)?.label || 'Bot';
}

function prefixRuntime(runtime, message) {
  return `[${getRuntimeLabel(runtime)}] ${message}`;
}

function serializeError(error) {
  if (!error) return 'Lỗi không xác định';
  if (typeof error === 'string') return error;
  const parts = [];
  if (error.message) parts.push(error.message);
  if (error.code) parts.push(`code=${error.code}`);
  if (error.name) parts.push(`name=${error.name}`);
  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}') parts.push(json);
  } catch (_) {}
  return parts.join(' | ') || String(error);
}

function isTransientAutomationError(error) {
  if (window.PDBWebviewAutomation?.isTransientGuestViewError) {
    return window.PDBWebviewAutomation.isTransientGuestViewError(error);
  }
  return /GUEST_VIEW_MANAGER_CALL|Script failed to execute|\[object Object\]|webview.*(loading|destroyed)/i.test(serializeError(error));
}

// The loop stopped because an action may already have taken effect in Pancake.
// Name the action so the admin knows what to verify instead of only seeing that
// the bot went quiet.
async function logUncertainStop(runtime, type, method) {
  const safeMethod = /^[A-Za-z]{1,64}$/.test(String(method || '')) ? String(method) : '';
  const detail = safeMethod ? ` (${safeMethod})` : '';
  await log('ERROR', type, prefixRuntime(runtime, `Automation stopped: uncertain action requires review${detail}`));
  toast(
    safeMethod
      ? `${getRuntimeLabel(runtime)} đã dừng: "${safeMethod}" có thể đã chạy — hãy kiểm tra hội thoại trước khi bật lại.`
      : `${getRuntimeLabel(runtime)} đã dừng: một hành động có thể đã chạy — hãy kiểm tra hội thoại trước khi bật lại.`,
    8000
  );
}

// A guest console error recorded within this window of the failure is treated as
// its cause; anything older is unrelated noise from normal Pancake activity.
const GUEST_CONSOLE_CORRELATION_MS = 5000;

function getGuestConsoleHint(runtime) {
  const recorded = getTab(runtime?.tabId)?.lastGuestConsoleError;
  if (!recorded) return '';
  if (Date.now() - recorded.at > GUEST_CONSOLE_CORRELATION_MS) return '';
  return `${recorded.text}${recorded.source ? ` @ ${recorded.source}` : ''}`;
}

async function logTransientAutomationError(runtime, type, error, streak) {
  const level = streak >= 3 ? 'ERROR' : 'WARN';
  const errorCode = String(error?.code || 'TRANSIENT_GUEST_ERROR');
  // Electron only surfaces "Script failed to execute" here, so attach the guest's
  // own console error when one landed alongside it.
  const guestHint = getGuestConsoleHint(runtime);
  const message = prefixRuntime(runtime, `Transient webview automation error (${streak}): ${errorCode}${guestHint ? ` | guest: ${guestHint}` : ''}`);
  await log(level, type, message);
  if (level === 'ERROR') toast(`${getRuntimeLabel(runtime)} webview automation lỗi liên tiếp: ${errorCode}`, 5000);
}

function getWebviewReadiness(tab) {
  const wv = tab?.webview;
  if (!wv) return { ok: false, reason: 'Thiếu webview' };
  if (typeof wv.isDestroyed === 'function') {
    try { if (wv.isDestroyed()) return { ok: false, reason: 'Webview đã bị hủy' }; } catch (_) {}
  }
  if (!wv.executeJavaScript) return { ok: false, reason: 'Webview chưa hỗ trợ executeJavaScript' };
  return { ok: true, reason: '' };
}

async function waitForTabReady(tab, label) {
  if (window.PDBWebviewAutomation?.waitForWebviewReady) {
    return window.PDBWebviewAutomation.waitForWebviewReady(tab, {
      label,
      timeoutMs: window.PDBWebviewAutomation.DEFAULT_WEBVIEW_READY_TIMEOUT_MS || 15000,
      generation: tab.loadGeneration
    });
  }
  if (!tab.loaded) throw new Error(`${tab.label}: ${label} webview loading`);
  return true;
}

async function recoverTabAfterReadTimeout(tab, label) {
  if (tab.recovering) return waitForTabReady(tab, label);
  tab.recovering = true;
  try {
    const targetUrl = safeGetURL(tab.webview, tab.expectedNavigationUrl || tab.webview.src || '');
    if (window.PDBWebviewAutomation?.startTrackedNavigation && typeof tab.webview.loadURL === 'function') {
      window.PDBWebviewAutomation.startTrackedNavigation(tab, targetUrl);
    } else {
      tab.loaded = false;
      tab.loadState = 'loading';
      tab.automationInjected = false;
      tab.injectionGeneration = -1;
      tab.loadGeneration += 1;
      tab.webview.reload();
    }
    await waitForTabReady(tab, `${label}:recovery`);
  } finally {
    tab.recovering = false;
  }
}

async function executeInTab(tabId, js, label = 'executeJavaScript') {
  const tab = getTab(tabId);
  const wv = tab.webview;
  const ready = getWebviewReadiness(tab);
  if (!ready.ok) throw new Error(`${tab.label}: ${ready.reason}`);
  let dispatched = false;
  try {
    const run = async () => {
      await waitForTabReady(tab, label);
      dispatched = true;
      return wv.executeJavaScript(js, false);
    };
    if (window.PDBWebviewAutomation?.executeWithRetry) {
      return await window.PDBWebviewAutomation.executeWithRetry(run, {
        tabId: tab.id,
        method: label,
        timeoutMs: window.PDBWebviewAutomation.DEFAULT_AUTOMATION_TIMEOUT_MS || 15000,
        onBeforeRetry: async ({ error }) => {
          if (error?.code === 'AUTOMATION_TIMEOUT') {
            await recoverTabAfterReadTimeout(tab, label);
          }
          if (label === 'injectAutomation') return;
          tab.automationInjected = false;
          tab.injectionGeneration = -1;
          await injectAutomation(tab.id);
        }
      });
    }
    return await run();
  } catch (error) {
    const wrapped = new Error(`${tab.label}: ${label} lỗi (${tab.loaded ? 'loaded' : 'loading'}), code=${String(error?.code || 'AUTOMATION_EXECUTION_FAILED')}`);
    wrapped.code = error?.code || 'AUTOMATION_EXECUTION_FAILED';
    wrapped.cause = error;
    // Only a non-idempotent action leaves the page in an unknown state after a
    // failed dispatch, so only those stop the loop for review. Replaying
    // clickConversationById/setReplyText/applyTagByName is harmless, and
    // treating their transient failures as uncertain was stopping the bot for
    // errors that had no effect on Pancake.
    if (dispatched
      && window.PDBWebviewAutomation?.isActionMethod?.(label)
      && !window.PDBWebviewAutomation?.isIdempotentActionMethod?.(label)) {
      wrapped.uncertain = true;
      wrapped.dispatched = true;
      wrapped.uncertainMethod = label;
    }
    throw wrapped;
  }
}

async function executeInPancake(js) {
  return executeInTab('bot1', js);
}

async function loadAutomationProbeCode() {
  if (automationProbeCode) return automationProbeCode;
  if (!automationBootstrapCode) {
    const [policyCode, domCode] = await Promise.all([
      fetch('pancakeUrlPolicy.js').then((response) => response.text()),
      fetch('pancakeDom.js').then((response) => response.text())
    ]);
    automationBootstrapCode = Object.freeze({ policyCode, domCode });
  }
  automationProbeCode = window.PDBPancakeAutomationPayload.buildProbePayload(automationBootstrapCode);
  return automationProbeCode;
}

async function loadAutomationAdapterCode() {
  if (automationAdapterCode) return automationAdapterCode;
  await loadAutomationProbeCode();
  const adapterCode = await fetch('automation.js').then((response) => response.text());
  automationAdapterCode = window.PDBPancakeAutomationPayload.buildAdapterPayload({
    ...automationBootstrapCode,
    adapterCode
  });
  return automationAdapterCode;
}

async function loadAutoReplyPreviewCode() {
  if (!autoReplyPreviewCode) autoReplyPreviewCode = await fetch('autoReplyPreview.js').then((response) => response.text());
  return autoReplyPreviewCode;
}

async function previewCall(tabId, expression, label) {
  const code = await loadAutoReplyPreviewCode();
  const ensure = `if (!window.PDBAutoReplyPreviewController) { ${code} }`;
  return executeInTab(tabId, `${ensure}\n${expression}`, label);
}

async function injectAutomation(tabId = activeWvTab) {
  const tab = getTab(tabId);
  if (!tab.botCapable) throw new Error('Tab này không hỗ trợ bot');
  // automation.js is idempotent (guards on window.__PDB__), but skip the
  // executeJavaScript round-trip entirely once injected for this page load.
  if (tab.automationInjected && tab.injectionGeneration === tab.loadGeneration) return true;
  return window.PDBPancakeAutomationGate.prepareAutomation({
    tabLabel: tab.label,
    waitUntilReady: () => waitForTabReady(tab, 'injectAutomation'),
    getUrl: () => safeGetURL(tab.webview, tab.webview.src || ''),
    classifyUrl: window.PDBPancakeUrlPolicy.classifyPancakeUrl,
    probePage: async () => executeInTab(
      tab.id,
      await loadAutomationProbeCode(),
      'injectAutomation'
    ),
    injectAutomation: async () => {
      const dispatchGeneration = tab.loadGeneration;
      const result = await executeInTab(tab.id, await loadAutomationAdapterCode(), 'injectAutomation');
      if (window.PDBPancakeAutomationPayload.isBlockedResult(result)) return result;
      if (!window.PDBPancakeAutomationPayload.canCommitAdapterResult(result, {
        expectedGeneration: dispatchGeneration,
        currentGeneration: tab.loadGeneration,
        loaded: tab.loaded
      })) {
        const error = new Error(`${tab.label}: navigation changed during automation injection`);
        error.code = 'AUTOMATION_NAVIGATION_RACE';
        throw error;
      }
      tab.automationInjected = true;
      tab.injectionGeneration = dispatchGeneration;
      return true;
    }
  });
}

function createAuthRequiredError(tab) {
  const error = new Error(`${tab.label}: cần đăng nhập Pancake`);
  error.code = window.PDBPancakeAutomationGate.ERROR_CODES.AUTH_REQUIRED;
  return error;
}

async function botCallForTab(tabId, method, ...args) {
  const tab = getTab(tabId);
  if (!tab.botCapable) throw new Error('Tab này không hỗ trợ bot');
  if (tab.authState === 'required') throw createAuthRequiredError(tab);
  await injectAutomation(tabId);
  const argJson = JSON.stringify(args);
  return executeInTab(tabId, `window.__PDB__.${method}.apply(window.__PDB__, ${argJson})`, method);
}

async function botCall(method, ...args) {
  const tab = getTab(activeWvTab);
  if (!tab.botCapable) throw new Error('Tab này không hỗ trợ bot');
  return botCallForTab(tab.id, method, ...args);
}

function safeJson(data) { return JSON.stringify(data, null, 2); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function loadHealth() {
  try {
    const health = await api('/health');
    $('serverBadge').textContent = 'Server Online';
    $('serverBadge').className = 'badge online';
    $('shortcutCount').textContent = health.shortcutCount || 0;
    $('botState').textContent = health.settings?.botEnabled ? 'ON' : 'OFF';
    $('autoSendState').textContent = health.settings?.autoSend ? 'ON' : 'OFF';
  } catch (error) {
    $('serverBadge').textContent = 'Server Offline';
    $('serverBadge').className = 'badge offline';
  }
}

function setRuntimeState(label, level = 'muted') {
  const el = $('runtimeState');
  if (el) el.textContent = label;
  const badge = $('safetyState');
  if (badge && level === 'error') badge.className = 'badge offline';
}

function setSafetyState(label, level = 'warn', reason = '') {
  const badge = $('safetyState');
  if (badge) {
    badge.textContent = label;
    badge.className = level === 'ok' ? 'badge online' : 'badge offline';
  }
  const failSafe = $('lastFailSafe');
  if (failSafe) failSafe.textContent = reason || '—';
}

function setLastDecision(action, reason = '') {
  const el = $('lastDecision');
  if (el) el.textContent = action || '—';
  if (reason) setSafetyState('Fail-safe', 'warn', reason);
}

function setRuntimeLastDecision(runtime, action, reason = '') {
  if (!runtime || runtime.tabId === activeWvTab) setLastDecision(action, reason);
}

function setActiveRuntimeMessages(runtime) {
  if (!runtime || runtime.tabId !== activeWvTab) return;
  lastAnalysis = runtime.lastAnalysis;
  lastCustomerMessage = runtime.lastCustomerMessage;
  currentContextMessage = runtime.currentContextMessage;
}

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
  renderAutoReplyPreviewSettings();
  refreshActiveTabRuntimeUi();
}

async function saveSettingsFromUi() {
  const buyTtsDebounceInput = $('buyTtsDebounceMs');
  const parsedBuyTtsDebounceMs = Number((buyTtsDebounceInput && buyTtsDebounceInput.value) || 1500);
  const buyTtsDebounceMs = Number.isFinite(parsedBuyTtsDebounceMs) && parsedBuyTtsDebounceMs >= 300
    ? parsedBuyTtsDebounceMs
    : 1500;
  if (buyTtsDebounceInput) buyTtsDebounceInput.value = buyTtsDebounceMs;

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
      buyTtsDebounceMs,
      minConfidence: Number($('minConfidence').value || 0.75),
      autoClickEnabled: Boolean(($('autoClickEnabled') && $('autoClickEnabled').checked) || anyRuntimeAutoClickRunning()),
      autoClickDelayMs: Number(($('autoClickDelayMs') && $('autoClickDelayMs').value) || 3000),
      learnExamplesEnabled: $('learnExamplesEnabled') ? $('learnExamplesEnabled').checked : true
    })
  });
  toast('Đã lưu settings');
  await loadHealth();
}

function renderAiConfigStatus(config, message = '') {
  const source = config?.source || {};
  const parts = [
    message || 'AI config sẵn sàng',
    `Base URL: ${config?.aiBaseUrl || ''} (${source.baseUrl || 'n/a'})`,
    `Model: ${config?.aiModel || ''} (${source.model || 'n/a'})`,
    `API Key: ${config?.aiApiKeyMasked || ''} (${source.apiKey || 'n/a'})`,
    config?.resolvedResponsesUrl ? `Endpoint: ${config.resolvedResponsesUrl}` : ''
  ].filter(Boolean);
  $('aiConfigStatus').innerHTML = parts.map((line) => `<div>${escapeHtml(line)}</div>`).join('');
}

async function loadAiConfig() {
  const config = await api('/api/ai/config');
  $('aiBaseUrl').value = config.aiBaseUrl || '';
  $('aiApiKey').value = config.aiApiKey || '';
  $('aiModel').value = config.aiModel || '';
  renderAiConfigStatus(config);
  return config;
}

async function saveAiConfigFromUi() {
  const config = await api('/api/ai/config', {
    method: 'POST',
    body: JSON.stringify({
      aiBaseUrl: $('aiBaseUrl').value.trim(),
      aiApiKey: $('aiApiKey').value.trim(),
      aiModel: $('aiModel').value.trim()
    })
  });
  renderAiConfigStatus(config, 'Đã lưu AI config');
  toast('Đã lưu AI config');
}

async function testAiConfig() {
  const result = await api('/api/ai/test', {
    method: 'POST',
    body: JSON.stringify({
      aiBaseUrl: $('aiBaseUrl').value.trim(),
      aiApiKey: $('aiApiKey').value.trim(),
      aiModel: $('aiModel').value.trim()
    })
  });
  renderAiConfigStatus(result.config, result.message || 'AI test OK');
  toast(result.message || 'AI test OK');
}

async function loadShortcuts() {
  const data = await api('/api/shortcuts');
  shortcuts = data.items || [];
  renderShortcuts();
  renderShortcutPalette();
  $('shortcutCount').textContent = shortcuts.length;
}

function renderShortcuts() {
  const q = ($('shortcutSearch')?.value || '').toLowerCase();
  const filtered = shortcuts.filter((s) => [s.shortcut, s.topic, s.quickReply, s.message, s.folders].join(' ').toLowerCase().includes(q));
  $('shortcutTable').innerHTML = `<table><thead><tr><th>Shortcut</th><th>Topic</th><th>Quick Reply</th><th>Message</th><th>Folder</th></tr></thead><tbody>${filtered.map((s) => `<tr><td><span class="shortcut-pill">${escapeHtml(s.shortcut)}</span></td><td>${escapeHtml(s.topic || '')}</td><td>${escapeHtml(s.quickReply || '')}</td><td>${escapeHtml((s.message || '').slice(0, 90))}</td><td>${escapeHtml(s.folders || '')}</td></tr>`).join('')}</tbody></table>`;
}

// Bảng shortcut dạy/điền (tab Gợi ý): render mọi shortcut đã import thành nút.
function renderShortcutPalette() {
  const box = $('paletteList');
  if (!box) return;
  if (!shortcuts.length) {                                                 // Req 1.4
    box.innerHTML = '<p style="padding:10px;color:var(--muted)">Chưa import shortcut nào. Hãy import file shortcut trước.</p>';
    return;
  }
  const q = ($('paletteSearch')?.value || '').toLowerCase();
  const filtered = shortcuts.filter((s) => `${s.shortcut} ${s.topic || ''}`.toLowerCase().includes(q)); // Req 2.2
  if (!filtered.length) {                                                  // Req 2.4
    box.innerHTML = '<p style="padding:10px;color:var(--muted)">Không có shortcut khớp tìm kiếm.</p>';
    return;
  }
  box.innerHTML = filtered.map((s) =>                                      // Req 1.2, 1.3
    `<button class="btn small palette-btn" data-shortcut="${escapeHtml(s.shortcut)}" title="${escapeHtml(s.topic || '')}">${escapeHtml(s.shortcut)} ${escapeHtml(s.topic || '')}</button>`
  ).join('');
}

// Nguồn học cho thao tác dạy có chủ đích: chỉ dùng khi Trợ lý gợi ý
// real-time đang bật. Ưu tiên ô test #aiMessage, sau đó dùng tin khách mới nhất.
function resolveLearnSource({ allowAssistantContext = assistantEnabled } = {}) {
  const typed = ($('aiMessage')?.value || '').trim();
  if (typed) return typed;
  return allowAssistantContext ? (currentContextMessage || '') : '';
}

function shouldRecordManualExample() {
  const typedMessage = $('aiMessage')?.value || '';
  const learnExamplesEnabled = settings.learnExamplesEnabled !== false;
  if (window.PDBBotDecision?.shouldRecordManualExample) {
    return window.PDBBotDecision.shouldRecordManualExample({ assistantEnabled, typedMessage, learnExamplesEnabled });
  }
  return Boolean(assistantEnabled && learnExamplesEnabled);
}

async function fillShortcutIntoActiveTab(shortcut) {
  const tab = getTab(activeWvTab);
  if (!tab.botCapable) return { ok: false, message: 'Tab hiện tại không hỗ trợ điền shortcut. Hãy chọn Bot 1 hoặc Bot 2.' };
  const ready = getWebviewReadiness(tab);
  if (!ready.ok) return { ok: false, message: `${tab.label}: ${ready.reason}` };
  return botCallForTab(tab.id, 'setReplyText', shortcut.trim());
}

// Bấm nút bảng: điền mã vào Pancake (luôn nếu hợp lệ), chỉ học khi
// Trợ lý gợi ý real-time đang bật. KHÔNG tự gửi.
async function teachAndFill(shortcut) {
  if (!isShortcut(shortcut)) { toast('Shortcut không đúng định dạng'); return; }
  const result = await fillShortcutIntoActiveTab(shortcut);
  const source = shouldRecordManualExample() ? resolveLearnSource() : '';
  if (result?.ok && source) {
    try { await recordExample(source, shortcut, lastAnalysis?.intent || ''); }
    catch (_) { toast('Đã điền nhưng lưu ví dụ thất bại'); }
  }
  toast(result?.ok ? `Đã điền ${shortcut}${source ? ' + đã học' : ''}` : (result?.message || 'Không điền được'));
}

// === Trợ lý gợi ý real-time (Phần 2) — suggest-only, độc lập botLoop ===
// Không phụ thuộc settings.botEnabled (Req 4.3, 4.4). Tuyệt đối không gọi
// applyTagByName/setReplyText/clickSendButton trong luồng này (Req 5.6).
function toggleAssistant() {
  assistantEnabled = $('assistantEnabled').checked;
  if (assistantEnabled && pageVisible) startAssistantWatch();
  else stopAssistantWatch();
}

function startAssistantWatch() {
  stopAssistantWatch();
  lastConversationId = '';
  assistantTimer = setInterval(checkConversationChange, 1200); // chỉ đọc id, rẻ
}

function stopAssistantWatch() {
  if (assistantTimer) clearInterval(assistantTimer);
  assistantTimer = null;
  if (assistantDebounce) clearTimeout(assistantDebounce);
  assistantDebounce = null;
}

async function checkConversationChange() {
  if (!assistantEnabled || !pageVisible) return;        // Req 5.9, 4.5
  let convId = '';
  try { convId = await botCall('getActiveConversationId'); } catch { return; }
  if (!convId || convId === lastConversationId) return; // Req 7.2, 7.3
  lastConversationId = convId;
  if (assistantDebounce) clearTimeout(assistantDebounce);
  assistantDebounce = setTimeout(() => runAssistantSuggest(convId), 1000); // Req 6.2
}

async function runAssistantSuggest(convId) {
  if (!assistantEnabled || !pageVisible) return;
  let history = [], orderStatus = null, name = '';
  try {
    history = await botCall('getRecentMessages', 5);
    orderStatus = await botCall('getCustomerOrderStatus');
    name = await botCall('getCurrentCustomerName');
  } catch (_) { renderAssistantError('Không đọc được hội thoại'); return; }  // Req 5.7
  const latest = lastCustomerText(history);
  if (!latest) { currentContextMessage = ''; renderAssistantEmpty('Chưa có tin để gợi ý'); return; }     // Req 5.2, 1.3
  currentContextMessage = latest;                    // Req 1.1, 1.2 (tin khách mới nhất, không ghép)
  if (suggestCache.has(latest)) { renderAnalysis(suggestCache.get(latest)); return; } // Req 6.3, 1.4
  try {
    const analysis = await api('/api/ai/analyze-message', {
      method: 'POST',
      body: JSON.stringify({ customerMessage: latest, customerName: name, conversationHistory: history, orderStatus, context: { source: 'assistant' } }),
      signal: AbortSignal.timeout(30000)               // Req 5.8
    });
    cacheSuggest(latest, analysis);                    // Req 6.4
    renderAnalysis(analysis);                          // Req 5.3, 5.4
  } catch (_) { renderAssistantError('AI lỗi hoặc quá thời gian'); }         // Req 5.8
}

// Lấy text tin gần nhất do khách gửi trong history [{from,text}]; rỗng -> ''.
function lastCustomerText(history) {
  if (!Array.isArray(history)) return '';
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.from === 'customer') return String(m.text || '').trim();
  }
  return '';
}

// Lưu vào cache, trim cũ nhất khi vượt SUGGEST_CACHE_MAX (giống rememberProcessed).
function cacheSuggest(key, analysis) {
  suggestCache.set(key, analysis);
  while (suggestCache.size > SUGGEST_CACHE_MAX) {
    suggestCache.delete(suggestCache.keys().next().value);
  }
}

function renderAssistantError(msg) {
  $('aiResult').innerHTML = `<div class="suggestion"><p style="color:var(--red)">${escapeHtml(msg)}</p></div>`;
}

function renderAssistantEmpty(msg) {
  $('aiResult').innerHTML = `<div class="suggestion"><p style="color:var(--muted)">${escapeHtml(msg)}</p></div>`;
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
}

function iconSvg(name) {
  return window.PDBIcons ? window.PDBIcons.svg(name) : '';
}

async function loadLogs() {
  try {
    const logs = await api('/api/logs?limit=120');
    $('logsBox').innerHTML = logs.map((l) => `<div class="log-item ${escapeHtml(l.level)}"><b>${escapeHtml(l.level)}</b> <span>${escapeHtml(l.type)}</span><br>${escapeHtml(l.message)}<br><small>${escapeHtml(l.time)}</small></div>`).join('') || '<p>Chưa có log</p>';
  } catch (_) {}
}

// --- Bot stats (đọc từ log sẵn có, không thêm server) ---
// Suy action của một ca: ưu tiên data.analysis.action, fallback tiền tố message.
function resolveBotAction(logItem) {
  let a = logItem?.data?.analysis?.action || logItem?.data?.output?.action || '';
  if (a === 'SKIP') a = 'SKIPPED_NON_TEXT';
  if (a === 'TAG_BUY_AND_MARK_UNREAD') a = 'ESCALATED';
  if (['NEW_CUSTOMER', 'SHORTCUT', 'ESCALATED', 'WAITING_REVIEW', 'TAG_FAILED', 'SKIPPED_NON_TEXT'].includes(a)) return a;
  const m = String(logItem?.message || '');
  if (m.includes('Bỏ qua (không phải text)')) return 'SKIPPED_NON_TEXT';
  if (m.includes('Khách mua hàng/escalate')) return 'ESCALATED';
  if (m.startsWith('Khách mới:')) return 'NEW_CUSTOMER';
  if (m.includes('Không có shortcut phù hợp')) return 'WAITING_REVIEW';
  if (m.includes('Không gắn được tag')) return 'TAG_FAILED';
  if (m.startsWith('Đã gửi ') || m.startsWith('Đã điền ')) return 'SHORTCUT';
  return null;
}

function extractStatShortcut(logItem) {
  const sc = logItem?.data?.analysis?.bestShortcut;
  if (sc && /^\/\d+$/.test(sc)) return sc;
  const m = String(logItem?.message || '').match(/\/\d+/);
  return m ? m[0] : null;
}

async function computeBotStats() {
  let logs = [];
  try { logs = await api('/api/logs?limit=800'); } catch (_) { renderBotStats(null); return; }
  const botLogs = (logs || []).filter((l) => l.type === 'BOT');
  const AUTO = new Set(['NEW_CUSTOMER', 'SHORTCUT']);
  const HUMAN = new Set(['ESCALATED', 'WAITING_REVIEW', 'TAG_FAILED']);
  let auto = 0, human = 0, skipped = 0;
  const scCount = new Map();
  for (const l of botLogs) {
    const act = resolveBotAction(l);
    if (!act) continue;
    if (AUTO.has(act)) auto++;
    else if (HUMAN.has(act)) human++;
    else if (act === 'SKIPPED_NON_TEXT') skipped++;
    if (act === 'SHORTCUT' || act === 'NEW_CUSTOMER') {
      const sc = extractStatShortcut(l);
      if (sc) scCount.set(sc, (scCount.get(sc) || 0) + 1);
    }
  }
  const decided = auto + human;
  const autoRate = decided ? Math.round((auto / decided) * 100) : 0;
  const topShortcuts = [...scCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([shortcut, count]) => ({ shortcut, count }));
  renderBotStats({ total: auto + human + skipped, auto, human, skipped, autoRate, topShortcuts });
}

function renderBotStats(stats) {
  const box = $('botStats');
  if (!box) return;
  if (!stats || stats.total === 0) {
    box.innerHTML = '<p style="color:var(--muted)">Chưa có dữ liệu thống kê (bot chưa xử lý ca nào gần đây).</p>';
    return;
  }
  const top = stats.topShortcuts.length
    ? stats.topShortcuts.map((s) => `<li><span class="shortcut-pill">${escapeHtml(s.shortcut)}</span> × ${s.count}</li>`).join('')
    : '<li style="color:var(--muted)">Chưa có</li>';
  box.innerHTML = `
    <div class="grid two">
      <div class="stat"><span>Tổng ca</span><b>${stats.total}</b></div>
      <div class="stat"><span>Tỉ lệ tự xử</span><b>${stats.autoRate}%</b></div>
      <div class="stat"><span>Bot tự xử</span><b>${stats.auto}</b></div>
      <div class="stat"><span>Đẩy người</span><b>${stats.human}</b></div>
      <div class="stat"><span>Bỏ qua</span><b>${stats.skipped}</b></div>
    </div>
    <div style="margin-top:10px"><b style="font-size:12px;color:var(--muted)">TOP SHORTCUT</b><ul class="bot-stats-top">${top}</ul></div>
  `;
}

function renderAnalysis(analysis) {
  lastAnalysis = analysis;
  const suggestions = (analysis.topSuggestions || []).map((s) => `
    <div class="suggestion">
      <strong>${escapeHtml(s.shortcut)}</strong> — ${escapeHtml(s.topic || '')}<br>
      <small>Confidence: ${Math.round(Number(s.confidence || 0) * 100)}% · ${escapeHtml(s.reason || '')}</small>
      <div class="actions"><button class="btn small ghost suggestion-fill" data-shortcut="${escapeHtml(s.shortcut)}">Điền ${escapeHtml(s.shortcut)}</button></div>
    </div>
  `).join('');
  $('aiResult').innerHTML = `
    <div class="suggestion">
      <h3>Best: <span class="shortcut-pill">${escapeHtml(analysis.bestShortcut || 'null')}</span></h3>
      <p><b>Intent:</b> ${escapeHtml(analysis.intent || '')}</p>
      <p><b>Action:</b> ${escapeHtml(analysis.action || '')}</p>
      <p><b>Confidence:</b> ${Math.round(Number(analysis.confidence || 0) * 100)}%</p>
      <p><b>Reason:</b> ${escapeHtml(analysis.reason || '')}</p>
      <p><b>Should escalate:</b> ${analysis.shouldEscalate ? 'YES' : 'NO'}</p>
      ${typeof analysis.usedExamples === 'number' && analysis.usedExamples > 0 ? `<p class="icon-copy"><small>${iconSvg('book')} Đã tham khảo ${analysis.usedExamples} ví dụ đã học</small></p>` : ''}
      ${analysis.bestShortcut ? `<div class="actions"><button class="btn small danger" id="unlearnBtn" title="Báo AI rằng gợi ý này sai">Gợi ý sai</button></div>` : ''}
    </div>
    ${suggestions || '<p>Không có gợi ý</p>'}
  `;
  document.querySelectorAll('.suggestion-fill').forEach((btn) => btn.addEventListener('click', async () => fillShortcut(btn.dataset.shortcut)));
  const unlearnBtn = $('unlearnBtn');
  if (unlearnBtn) unlearnBtn.addEventListener('click', () => unlearnExample(lastCustomerMessage, analysis.bestShortcut));
}

async function analyzeText(text) {
  lastCustomerMessage = String(text || '');
  const analysis = await api('/api/ai/analyze-message', {
    method: 'POST',
    body: JSON.stringify({ customerMessage: text, customerName: '', currentTags: [], context: {} })
  });
  renderAnalysis(analysis);
  return analysis;
}

// Learning: record a (message -> shortcut) example. Best-effort, never throws.
async function recordExample(message, shortcut, intent = '') {
  if (settings.learnExamplesEnabled === false) return;
  const msg = String(message || '').trim();
  if (!msg || !isShortcut(shortcut)) return;
  try {
    const res = await api('/api/examples', {
      method: 'POST',
      body: JSON.stringify({ message: msg, shortcut: shortcut.trim(), intent })
    });
    learnedCount = res.count || learnedCount;
    updateLearnedCount();
    loadLearnedCount();
  } catch (_) { /* ignore - learning must not break flow */ }
}

// Unlearn: remove a wrong example (👎).
async function unlearnExample(message, shortcut) {
  try {
    await api('/api/examples/delete-pair', {
      method: 'POST',
      body: JSON.stringify({ message: String(message || ''), shortcut: String(shortcut || '') })
    });
    toast('Đã xóa ví dụ sai, AI sẽ không học theo nữa');
    await loadLearnedCount();
  } catch (e) { toast(e.message); }
}

function updateLearnedCount() {
  const el = $('learnedCount');
  if (el) el.textContent = learnedCount;
}

function renderExamples() {
  const box = $('examplesTable');
  if (!box) return;
  const q = ($('exampleSearch')?.value || '').toLowerCase();
  const filtered = examplesCache.filter((e) => `${e.message} ${e.shortcut} ${e.intent || ''}`.toLowerCase().includes(q));
  if (!filtered.length) {
    box.innerHTML = '<p style="padding:10px;color:var(--muted)">Chưa có ví dụ nào. AI sẽ học khi bạn gửi/điền shortcut.</p>';
    return;
  }
  box.innerHTML = `<table><thead><tr><th>Tin khách</th><th>Shortcut</th><th></th></tr></thead><tbody>${
    filtered.map((e) => `<tr>
      <td>${escapeHtml((e.message || '').slice(0, 120))}</td>
      <td><span class="shortcut-pill">${escapeHtml(e.shortcut)}</span></td>
      <td><button class="btn small danger example-del" data-id="${escapeHtml(e.id)}" title="Xóa ví dụ này">✕</button></td>
    </tr>`).join('')
  }</tbody></table>`;
  box.querySelectorAll('.example-del').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await api(`/api/examples/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' });
      await loadLearnedCount();
      toast('Đã xóa ví dụ');
    } catch (e) { toast(e.message); }
  }));
}

async function loadLearnedCount() {
  try {
    const data = await api('/api/examples');
    examplesCache = data.items || [];
    learnedCount = examplesCache.length;
    updateLearnedCount();
    renderExamples();
  } catch (_) {}
}

// --- Extensions (Chrome-like store) ---
function renderExtensions(list) {
  const box = $('extList');
  if (!box) return;
  const items = Array.isArray(list) ? list : [];
  if (!items.length) {
    box.innerHTML = '<p>Chưa có extension nào trong thư mục <code>extensions/</code>.</p>';
    return;
  }
  box.innerHTML = items.map((e) => `
    <div class="suggestion">
      <div class="card-title-row">
        <strong>${escapeHtml(e.name || e.folder)}</strong>
        <span class="badge ${e.loaded ? 'online' : 'offline'}">${e.loaded ? 'Đã load' : 'Lỗi'}</span>
      </div>
      <small>Thư mục: ${escapeHtml(e.folder)} · v${escapeHtml(e.version || '?')} · MV${escapeHtml(String(e.manifestVersion || '?'))}</small>
      ${e.error ? `<p style="color:var(--red);margin-top:6px"><small>${escapeHtml(e.error)}</small></p>` : ''}
      <div class="actions"><button class="btn small ghost ext-reload" data-folder="${escapeHtml(e.folder)}">Reload</button></div>
    </div>
  `).join('');
  box.querySelectorAll('.ext-reload').forEach((btn) => btn.addEventListener('click', async () => {
    btn.textContent = 'Đang reload...';
    try {
      await window.pancakeDesktop.reloadExtensions(btn.dataset.folder);
      await loadExtensions();
      toast('Đã reload extension');
    } catch (e) { toast(e.message); }
  }));
}

async function loadExtensions() {
  if (!window.pancakeDesktop || !window.pancakeDesktop.listExtensions) return;
  try {
    const list = await window.pancakeDesktop.listExtensions();
    renderExtensions(list);
  } catch (e) {
    const box = $('extList');
    if (box) box.textContent = 'Lỗi tải extension: ' + e.message;
  }
}

async function fillShortcut(shortcut) {
  if (!isShortcut(shortcut)) {
    toast('Chặn: không phải shortcut /n');
    return;
  }
  const result = await fillShortcutIntoActiveTab(shortcut);
  const source = shouldRecordManualExample() ? resolveLearnSource() : '';
  if (result.ok && source) {
    // Điền từ vùng gợi ý chỉ học khi Trợ lý real-time và tự học ví dụ mới đều bật.
    try { await recordExample(source, shortcut.trim(), lastAnalysis?.intent || ''); }
    catch (_) { toast('Đã điền nhưng lưu ví dụ thất bại'); }
  }
  toast(result.ok ? `Đã điền ${shortcut}${source ? ' + đã học' : ''}` : result.message || 'Không điền được');
}

function openLoginInTab(tab, { force = false } = {}) {
  if (!tab?.webview) return false;
  const currentUrl = safeGetURL(tab.webview, tab.webview?.src || '');
  const currentKind = window.PDBPancakeUrlPolicy.classifyPancakeUrl(currentUrl);
  if (!force && currentKind === 'auth') return false;
  if (!force && tab.authLoginPending) return false;
  const resolveChatEntry = window.PDBPancakeUrlPolicy.resolveChatEntryUrl;
  const returnUrl = typeof resolveChatEntry === 'function'
    ? (resolveChatEntry(currentUrl) || resolveChatEntry(pancakeUrl))
    : '';
  if (returnUrl) tab.authReturnUrl = returnUrl;
  tab.authLoginPending = true;
  tab.authState = 'transition';
  navigateWebview(tab, window.PDBPancakeUrlPolicy.PANCAKE_LOGIN_URL);
  if (tab.id === activeWvTab && $('webviewStatus')) {
    $('webviewStatus').textContent = 'Đang mở trang đăng nhập Pancake...';
  }
  return true;
}

function showAuthRequiredState(tab, error, { openLogin = false } = {}) {
  if (tab) tab.authState = 'required';
  if (openLogin) openLoginInTab(tab);
  if (tab?.id !== activeWvTab) return;
  const message = error?.message || `${tab.label}: cần đăng nhập Pancake`;
  $('domSummary').textContent = message;
  $('unreadCount').textContent = '0';
  if ($('webviewStatus')) $('webviewStatus').textContent = message;
  const badge = $('safetyState');
  if (badge) {
    badge.textContent = 'Đăng nhập';
    badge.className = 'badge offline';
  }
  if ($('pancakeLoginBtn')) $('pancakeLoginBtn').hidden = false;
}

async function updateDomSummary(tabId = activeWvTab) {
  const tab = getTab(tabId);
  if (!tab.botCapable) {
    $('domSummary').textContent = `${tab.label}: tab thủ công, không chạy bot`;
    $('unreadCount').textContent = '0';
    setSafetyState('Manual', 'warn', 'Tab thủ công');
    return null;
  }
  try {
    const status = await botCallForTab(tab.id, 'getDomStatus');
    $('domSummary').textContent = safeJson(status);
    $('unreadCount').textContent = status.unreadCount || 0;
    const health = status.health || {};
    if (health.level === 'OK') setSafetyState('OK', 'ok');
    else setSafetyState(health.level === 'FAIL' ? 'Fail-safe' : 'Warn', 'warn', (health.missing || []).join(', ') || 'DOM chưa đủ điều kiện');
    return status;
  } catch (error) {
    if (window.PDBPancakeAutomationGate.isAuthRequiredError(error)) {
      showAuthRequiredState(tab, error);
      return null;
    }
    $('domSummary').textContent = error.message;
    setSafetyState('Fail-safe', 'warn', error.message);
    return null;
  }
}

async function getDomHealthSafe(runtime = getActiveBotRuntime()) {
  try { return await botCallForTab(runtime.tabId, 'getDomHealth'); }
  catch (error) { return { level: 'FAIL', canTypeReply: false, canSend: false, canTag: false, canMarkUnread: false, missing: [error.message] }; }
}

function missingReason(health, fallback) {
  return (health?.missing || []).join(', ') || fallback;
}

function isBlankShortcut(s) { return s == null || String(s).trim() === ''; }

async function getPancakeUrl(tabId = activeWvTab) {
  try { return await executeInTab(tabId, 'location.href'); } catch { return ''; }
}

async function ensureBotChatPage(runtime) {
  const tab = getTab(runtime?.tabId);
  if (!tab.botCapable) throw new Error('Tab này không hỗ trợ bot');

  await waitForTabReady(tab, 'openPancakeChat');
  let currentUrl = safeGetURL(tab.webview, tab.webview.src || '');
  const isBlankUrl = window.PDBWebviewTabNavigation?.isBlankWebviewUrl?.(currentUrl);
  if (!currentUrl || isBlankUrl) {
    const defaultChatUrl = normalizePancakeBotUrl(pancakeUrl);
    if (defaultChatUrl) {
      navigateWebview(tab, defaultChatUrl);
      await waitForTabReady(tab, 'openPancakeChat');
      currentUrl = safeGetURL(tab.webview, defaultChatUrl);
    }
  }

  try {
    await injectAutomation(tab.id);
  } catch (error) {
    if (window.PDBPancakeAutomationGate.isAuthRequiredError(error)) {
      showAuthRequiredState(tab, error, { openLogin: true });
      throw error;
    }
    const resolveChatEntry = window.PDBPancakeUrlPolicy.resolveChatEntryUrl;
    const chatEntryUrl = typeof resolveChatEntry === 'function'
      ? resolveChatEntry(currentUrl)
      : '';
    if (error?.code !== 'WRONG_PANCAKE_PAGE' || !chatEntryUrl || currentUrl === chatEntryUrl) {
      throw error;
    }
    if (activeWvTab === tab.id) $('webviewStatus').textContent = 'Đang mở trang chat Pancake...';
    navigateWebview(tab, chatEntryUrl);
    await waitForTabReady(tab, 'openPancakeChat');
    currentUrl = safeGetURL(tab.webview, chatEntryUrl);
    await injectAutomation(tab.id);
  }

  const status = await botCallForTab(tab.id, 'getDomStatus');
  if (status && status.isChatPage === false) {
    const safeUrl = window.PDBPancakeAutomationGate.sanitizeUrl(status.url || currentUrl || pancakeUrl);
    const error = new Error(`${tab.label}: đang ở sai trang Pancake (${status.pageKind || 'unknown'})${safeUrl ? `, url=${safeUrl}` : ''}`);
    error.code = 'WRONG_PANCAKE_PAGE';
    throw error;
  }
  return status;
}

async function postQueueWithRetry(body) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await api('/api/review-queue', {
        method: 'POST',
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  await log('ERROR', 'QUEUE', `Không enqueue được: ${body.conversationId} - ${lastErr?.message || 'lỗi không xác định'}`);
}

async function enqueueReviewCase({ info, customerName, message, analysis, runtime = getActiveBotRuntime() }) {
  const conversationId = info?.id || '';
  const pancakeUrl = await getPancakeUrl(runtime?.tabId || activeWvTab);
  const hasValidUrl = /^https?:\/\//.test(pancakeUrl);
  if (!conversationId && !hasValidUrl) {
    await log('ERROR', 'QUEUE', 'Không lấy được tham chiếu cuộc trò chuyện, bỏ qua enqueue', { customerName });
    return;
  }
  const body = {
    conversationId,
    customerName: customerName || info?.name || '',
    customerMessage: message || '',
    intent: analysis?.intent || '',
    reason: analysis?.reason || 'Bot không tự tin / không hiểu',
    pancakeUrl: hasValidUrl ? pancakeUrl : '',
    addressLookup: analysis?.addressLookup || null
  };
  await postQueueWithRetry(body);
}

async function processOneConversation(runtime = getActiveBotRuntime()) {
  if (!runtime) return { ok: false, message: 'Tab này không hỗ trợ bot' };
  const rawCall = (method, ...args) => botCallForTab(runtime.tabId, method, ...args);
  const unreadResult = await rawCall('getUnreadConversations');
  const unread = Array.isArray(unreadResult) ? unreadResult : (unreadResult?.items || []);
  const rawCount = Array.isArray(unreadResult) ? unread.length : Number(unreadResult?.rawCount || 0);
  if (runtime.tabId === activeWvTab) $('unreadCount').textContent = rawCount;
  if (unreadResult?.degraded) {
    await log('WARN', 'BOT', prefixRuntime(runtime, `DOM unread degraded: raw=${rawCount}, usable=${unread.length}, malformed=${unreadResult.malformedCount || 0}`));
    return { ok: false, code: 'DOM_DEGRADED', degraded: true };
  }
  if (!unread.length) return { ok: true, idle: true, message: 'Không có khách chưa đọc' };

  let first = null;
  let key = '';
  for (const candidate of unread) {
    const candidateKey = makeDedupeKey(candidate);
    if (wasConversationProcessedAnywhere(candidateKey)) {
      await log('WARN', 'BOT', prefixRuntime(runtime, `Bỏ qua vì mới xử lý: ${candidate.name}`));
      continue;
    }
    first = candidate;
    key = candidateKey;
    break;
  }
  if (!first) return { ok: true, skipped: true, message: 'Không có khách chưa đọc khả dụng' };

  const coordinator = createClickCoordinator('BOT');
  const processingJob = {
    key,
    conversationId: first.id,
    runtime,
    stage: 'clickConversationById',
    performAction: () => rawCall('clickConversationById', first.id),
    deferCompletion: true
  };
  const clickResult = await coordinator.process(processingJob);
  if (!clickResult.ok) return clickResult;
  const info = clickResult.info;
  const call = async (method, ...args) => {
    try {
      if (!coordinator.refreshDeferred(processingJob)) {
        const error = new Error('Conversation claim ownership was lost');
        error.code = 'CLAIM_LOST';
        throw error;
      }
      return await rawCall(method, ...args);
    } catch (error) {
      error.processingStage = method;
      throw error;
    }
  };
  try {
  const outcome = await (async () => {
  await sleep(900);
  const effectiveInfo = await window.PDBBotDecision.readEffectiveConversationInfo({
    info,
    readCurrentTags: () => call('getCurrentTags'),
    onWarning: async (error) => {
      await log('WARN', 'BOT', prefixRuntime(runtime, 'Không đọc được tag hiện tại; dùng tag từ danh sách'), {
        error: serializeError(error)
      });
    }
  });
  const customerName = await call('getCurrentCustomerName');
  const message = info.snippet || first.snippet || '';
  runtime.lastCustomerMessage = message;
  setActiveRuntimeMessages(runtime);

  const lastSender = await call('getLastMessageSender');
  const preDecision = window.PDBBotDecision.decideBeforeAnalysis({ info: effectiveInfo, lastSender, settings });

  if (preDecision.action === 'NEW_CUSTOMER' || preDecision.action === 'NEW_CUSTOMER_TAGGED_ONLY_HUMAN_REPLY') {
    const health = await getDomHealthSafe(runtime);
    if (!health.canTag) {
      setRuntimeLastDecision(runtime, 'FAIL_SAFE_TAG', missingReason(health, 'Không tìm thấy tag controls'));
      await log('WARN', 'BOT', prefixRuntime(runtime, `Fail-safe: không gắn tag khách mới cho ${customerName || info.name}`), { message, health, preDecision });
      await enqueueReviewCase({ info, customerName, message, analysis: { action: 'WAITING_REVIEW', reason: 'DOM không đủ điều kiện gắn tag khách mới', health }, runtime });
      return { ok: true, action: 'WAITING_REVIEW', failSafe: true };
    }
    const tagResult = await call('applyTagByName', preDecision.tagName);   // best-effort
    await sleep(350);
    if (!tagResult || !tagResult.ok) {
      await log('WARN', 'BOT', prefixRuntime(runtime, `Không gắn được tag "${preDecision.tagName}" cho ${customerName || info.name}`), { message, tagResult });
    }
    const tagged = Boolean(tagResult?.ok);
    if (!preDecision.shouldSendShortcut) {
      setRuntimeLastDecision(runtime, preDecision.action);
      await log(tagged ? 'SUCCESS' : 'WARN', 'BOT', prefixRuntime(runtime, `Khách mới đã có admin trả lời — ${tagged ? `đã gắn ${preDecision.tagName}` : `chưa gắn được ${preDecision.tagName}`}, không gửi ${preDecision.shortcut}`), { message, tagResult, preDecision });
      return { ok: true, action: preDecision.action, shortcut: preDecision.shortcut, tagged };
    }
    if (!health.canTypeReply) {
      setRuntimeLastDecision(runtime, 'FAIL_SAFE_REPLY', missingReason(health, 'Không tìm thấy ô reply'));
      await log('WARN', 'BOT', prefixRuntime(runtime, `Fail-safe: không gửi shortcut khách mới cho ${customerName || info.name}`), { message, health, preDecision });
      return { ok: true, action: 'WAITING_REVIEW', failSafe: true };
    }
    await call('setReplyText', preDecision.shortcut);
    const sendResult = await call('clickSendButton');
    if (!sendResult?.ok) {
      setRuntimeLastDecision(runtime, 'FAIL_SAFE_SEND', sendResult?.message || 'Không gửi được shortcut');
      await log('WARN', 'BOT', prefixRuntime(runtime, `Fail-safe: ${sendResult?.message || 'không gửi được shortcut'} cho ${customerName || info.name}`), { message, sendResult, preDecision });
      return { ok: true, action: 'WAITING_REVIEW', failSafe: true };
    }
    setRuntimeLastDecision(runtime, preDecision.action);
    await log('SUCCESS', 'BOT', prefixRuntime(runtime, `Khách mới (fast): ${customerName || info.name} → ${tagged ? preDecision.tagName + ' + ' : ''}${preDecision.shortcut}`), { message, preDecision });
    return { ok: true, action: 'NEW_CUSTOMER', shortcut: preDecision.shortcut, tagged };
  }

  if (preDecision.action === 'SKIPPED_HUMAN_REPLY') {
    setRuntimeLastDecision(runtime, preDecision.action);
    await log('INFO', 'BOT', prefixRuntime(runtime, `Đã có người trả lời, bỏ qua: ${customerName || info.name}`), { message, preDecision });
    return { ok: true, action: 'SKIPPED_HUMAN_REPLY' };
  }

  // Read up to 5 recent messages for context (best-effort; [] if unreadable).
  let conversationHistory = [];
  try { conversationHistory = await call('getRecentMessages', 5); } catch (_) {}

  // Read order status (has the customer already purchased?) — best-effort.
  let orderStatus = null;
  try { orderStatus = await call('getCustomerOrderStatus'); } catch (_) {}

  const analysis = await api('/api/ai/analyze-message', {
    method: 'POST',
    body: JSON.stringify({ customerMessage: message, customerName, currentTags: effectiveInfo.tags || [], conversationHistory, orderStatus, context: { source: 'electron-webview', tabId: runtime.tabId } })
  });
  runtime.lastAnalysis = analysis;
  if (runtime.tabId === activeWvTab) renderAnalysis(analysis);

  const postDecision = window.PDBBotDecision.decideAfterAnalysis({ analysis, settings });

  if (postDecision.action === 'SKIPPED_NON_TEXT') {
    setRuntimeLastDecision(runtime, postDecision.action);
    await log('INFO', 'BOT', prefixRuntime(runtime, `Bỏ qua (không phải text): ${customerName || info.name}`), { message, postDecision });
    return { ok: true, action: 'SKIPPED_NON_TEXT', message };
  }

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

  if (postDecision.action === 'WAITING_REVIEW') {
    setRuntimeLastDecision(runtime, postDecision.action);
    await log('WARN', 'BOT', prefixRuntime(runtime, `Không có shortcut phù hợp: ${customerName || info.name}`), { message, analysis, postDecision });
    await enqueueReviewCase({ info, customerName, message, analysis, runtime });
    return { ok: true, action: 'WAITING_REVIEW', analysis };
  }

  const health = await getDomHealthSafe(runtime);
  if (!health.canTypeReply) {
    setRuntimeLastDecision(runtime, 'FAIL_SAFE_REPLY', missingReason(health, 'Không tìm thấy ô reply'));
    await log('WARN', 'BOT', prefixRuntime(runtime, `Fail-safe: không điền shortcut cho ${customerName || info.name}`), { message, analysis, health, postDecision });
    await enqueueReviewCase({ info, customerName, message, analysis: { ...analysis, reason: 'DOM không đủ điều kiện điền shortcut', health }, runtime });
    return { ok: true, action: 'WAITING_REVIEW', failSafe: true, analysis };
  }

  await call('setReplyText', postDecision.shortcut);
  if (postDecision.shouldAttemptAutoSend) {
    const sendDecision = window.PDBBotDecision.decideBeforeSend({ lastSender: await call('getLastMessageSender') });
    if (sendDecision.action === 'SKIPPED_HUMAN_REPLY') {
      setRuntimeLastDecision(runtime, sendDecision.action);
      await log('INFO', 'BOT', prefixRuntime(runtime, `Đã có người trả lời trước khi gửi, hủy: ${customerName || info.name}`), { message, analysis, sendDecision });
      return { ok: true, action: 'SKIPPED_HUMAN_REPLY', analysis };
    }
    const sendResult = await call('clickSendButton');
    if (!sendResult?.ok) {
      setRuntimeLastDecision(runtime, 'FAIL_SAFE_SEND', sendResult?.message || 'Không gửi được shortcut');
      await log('WARN', 'BOT', prefixRuntime(runtime, `Fail-safe: ${sendResult?.message || 'không gửi được shortcut'} cho ${customerName || info.name}`), { message, analysis, sendResult, postDecision });
      return { ok: true, action: 'WAITING_REVIEW', failSafe: true, analysis };
    }
    await recordExample(message, postDecision.shortcut, analysis.intent || '');
    setRuntimeLastDecision(runtime, postDecision.action);
    await log('SUCCESS', 'BOT', prefixRuntime(runtime, `Đã gửi ${postDecision.shortcut} cho ${customerName || info.name}`), { message, analysis, postDecision });
  } else {
    setRuntimeLastDecision(runtime, postDecision.action);
    await log('INFO', 'BOT', prefixRuntime(runtime, `Đã điền ${postDecision.shortcut}, chờ duyệt`), { message, analysis, postDecision });
  }
  return { ok: true, action: 'SHORTCUT', analysis };
  })();
  if (!outcome?.ok) {
    return await coordinator.failDeferred(
      { ...processingJob, stage: outcome?.stage || 'postClick' },
      { code: outcome?.code || 'POST_CLICK_FAILURE' }
    );
  }
  if (!coordinator.completeDeferred(processingJob, { commit: true })) {
    return coordinator.failDeferred(
      { ...processingJob, stage: 'postClick' },
      { code: 'CLAIM_LOST' }
    );
  }
  return outcome;
  } catch (error) {
    return coordinator.failDeferred(
      { ...processingJob, stage: error?.processingStage || 'postClick' },
      { code: error?.code || 'POST_CLICK_FAILURE' }
    );
  }
}

// Xử lý MỘT khách theo chế độ Auto Click (tốc độ cao, KHÔNG gọi AI).
// Đặt cạnh processOneConversation để nhất quán; mọi log dùng type 'AUTOCLICK'
// để không lẫn vào computeBotStats (chỉ lọc type 'BOT').
async function processOneAutoClick(runtime = getActiveBotRuntime()) {
  if (!runtime) return { ok: false, message: 'Tab này không hỗ trợ Auto Click' };
  const rawCall = (method, ...args) => botCallForTab(runtime.tabId, method, ...args);
  // --- Task 4.1: lấy danh sách + chọn khách + dedupe ---
  const unreadResult = await rawCall('getUnreadConversations');
  const unread = Array.isArray(unreadResult) ? unreadResult : (unreadResult?.items || []);
  const rawCount = Array.isArray(unreadResult) ? unread.length : Number(unreadResult?.rawCount || 0);
  // Cập nhật badge best-effort: không để thiếu phần tử làm sập vòng lặp.
  try {
    const badge = $('unreadCount');
    if (badge && runtime.tabId === activeWvTab) badge.textContent = rawCount;
  } catch (_) {}

  if (unreadResult?.degraded) {
    await log('WARN', 'AUTOCLICK', prefixRuntime(runtime, `DOM unread degraded: raw=${rawCount}, usable=${unread.length}, malformed=${unreadResult.malformedCount || 0}`));
    return { ok: false, code: 'DOM_DEGRADED', degraded: true };
  }

  // Danh sách rỗng → idle, không gắn thẻ/gửi (Req 3.2).
  if (!unread.length) return { ok: true, idle: true, action: 'IDLE' };

  const first = unread.find((candidate) => !wasConversationProcessedAnywhere(makeDedupeKey(candidate)));
  if (!first) return { ok: true, skipped: true, action: 'SKIPPED_RECENT' };
  const key = makeDedupeKey(first);              // Req 7.1
  const coordinator = createClickCoordinator('AUTOCLICK');
  const processingJob = {
    key,
    conversationId: first.id,
    runtime,
    stage: 'clickConversationById',
    performAction: () => rawCall('clickConversationById', first.id),
    deferCompletion: true
  };
  const clickResult = await coordinator.process(processingJob);
  if (!clickResult.ok) return clickResult;
  const info = clickResult.info;
  const call = async (method, ...args) => {
    try {
      if (!coordinator.refreshDeferred(processingJob)) {
        const error = new Error('Conversation claim ownership was lost');
        error.code = 'CLAIM_LOST';
        throw error;
      }
      return await rawCall(method, ...args);
    } catch (error) {
      error.processingStage = method;
      throw error;
    }
  };
  try {
  const outcome = await (async () => {
  await sleep(700);

  // --- Task 4.2: bỏ qua khi đã có thẻ ---
  const customerName = await call('getCurrentCustomerName');   // best-effort
  if (shouldSkipByTags(info)) {                  // Req 4.1
    await log('INFO', 'AUTOCLICK', prefixRuntime(runtime, `Bỏ qua (đã có thẻ): ${customerName || info.name}`));
    return { ok: true, skipped: true, action: 'SKIPPED_HAS_TAG' };  // Req 4.2, 4.3
  }

  // --- Task 4.3: khách mới — gắn thẻ best-effort + gửi shortcut ---
  const newTag = settings.newCustomerTagName || 'Saruto Mới';
  const shortcut = settings.defaultNewCustomerShortcut || '/1';
  const health = await getDomHealthSafe(runtime);
  if (!health.canTypeReply) {
    setRuntimeLastDecision(runtime, 'AUTOCLICK_FAIL_SAFE_REPLY', missingReason(health, 'Không tìm thấy ô reply'));
    await log('WARN', 'AUTOCLICK', prefixRuntime(runtime, `Fail-safe: không gửi ${shortcut} cho ${customerName || info.name}`), { health, message: info.snippet });
    return { ok: true, action: 'WAITING_REVIEW', failSafe: true };
  }

  // Gắn thẻ ĐÚNG 1 LẦN (không retry); lỗi → coi như thất bại nhưng vẫn gửi (Req 5.1, 5.2, 5.3).
  let tagResult;
  try {
    tagResult = health.canTag ? await call('applyTagByName', newTag) : { ok: false, message: 'DOM thiếu tag controls' };
  } catch (error) {
    if (error?.uncertain || error?.dispatched) {
      return { ok: false, code: 'UNCERTAIN', uncertain: true, stage: 'applyTagByName' };
    }
    tagResult = { ok: false };
  }
  if (!tagResult || !tagResult.ok) {
    await log('WARN', 'AUTOCLICK', prefixRuntime(runtime, `Không gắn được tag "${newTag}" cho ${customerName || info.name} (vẫn gửi)`));
  }

  await sleep(350);
  await call('setReplyText', shortcut);        // Req 5.4

  // Gửi ĐÚNG 1 LẦN; thất bại → log WARN, KHÔNG ném ra ngoài (Req 5.5, 5.6).
  try {
    const sendRes = await call('clickSendButton');
    if (!sendRes || !sendRes.ok) {
      await log('WARN', 'AUTOCLICK', prefixRuntime(runtime, `Gửi shortcut thất bại`));
      return { ok: false, code: 'SEND_FAILED' };
    }
  } catch (error) {
    if (error?.uncertain || error?.dispatched) {
      return { ok: false, code: 'UNCERTAIN', uncertain: true, stage: 'clickSendButton' };
    }
    await log('WARN', 'AUTOCLICK', prefixRuntime(runtime, `Gửi ${shortcut} thất bại cho ${customerName || info.name}`));
    return { ok: false, code: 'SEND_FAILED' };
  }

  // Tổng kết khách mới (Req 5.7).
  setRuntimeLastDecision(runtime, 'AUTOCLICK_NEW_CUSTOMER');
  await log('SUCCESS', 'AUTOCLICK', prefixRuntime(runtime, `Khách mới: ${customerName || info.name} → ${tagResult?.ok ? newTag + ' + ' : ''}${shortcut}`), { message: info.snippet });
  return { ok: true, action: 'NEW_CUSTOMER', shortcut, tagged: Boolean(tagResult?.ok) };
  })();
  if (!outcome?.ok) {
    return await coordinator.failDeferred(
      { ...processingJob, stage: outcome?.stage || 'postClick' },
      { code: outcome?.code || 'POST_CLICK_FAILURE' }
    );
  }
  if (!coordinator.completeDeferred(processingJob, { commit: true })) {
    return coordinator.failDeferred(
      { ...processingJob, stage: 'postClick' },
      { code: 'CLAIM_LOST' }
    );
  }
  return outcome;
  } catch (error) {
    return coordinator.failDeferred(
      { ...processingJob, stage: error?.processingStage || 'postClick' },
      { code: error?.code || 'POST_CLICK_FAILURE' }
    );
  }
}

async function botLoop(runtime) {
  runtime.botRunning = true;
  syncLegacyRuntimeAliases(runtime);
  toast(`${getRuntimeLabel(runtime)} đã bắt đầu`);
  while (runtime.botRunning) {
    try {
      settings = await api('/api/settings');
      if (!settings.botEnabled) {
        await sleep(settings.scanIntervalMs || 2500);
        continue;
      }
      const result = await processOneConversation(runtime);
      if (result?.uncertain || result?.code === 'UNCERTAIN') {
        runtime.botRunning = false;
        await logUncertainStop(runtime, 'BOT', result?.stage || result?.uncertainMethod);
        break;
      }
      if (runtime.tabId === activeWvTab) await updateDomSummary(runtime.tabId);
      runtime.automationTransientErrorStreak = 0;
      await sleep(settings.processDelayMs || 3000);
    } catch (error) {
      if (error?.uncertain || error?.dispatched) {
        runtime.botRunning = false;
        await logUncertainStop(runtime, 'BOT', error?.uncertainMethod || error?.processingStage);
        break;
      }
      if (isTransientAutomationError(error)) {
        runtime.automationTransientErrorStreak = (runtime.automationTransientErrorStreak || 0) + 1;
        await logTransientAutomationError(runtime, 'BOT', error, runtime.automationTransientErrorStreak);
        await sleep(3000);
        continue;
      }
      await log('ERROR', 'BOT', prefixRuntime(runtime, error.message));
      toast(`${getRuntimeLabel(runtime)} lỗi: ${error.message}`, 5000);
      await sleep(3000);
    }
  }
  if (runtime.tabId === activeWvTab) refreshActiveTabRuntimeUi();
  updateAutomationActivity();
  toast(`${getRuntimeLabel(runtime)} đã dừng`);
}

async function enqueueTechnicalReview({ conversationId, tabId, code, stage }) {
  const safeCode = /^[A-Z0-9_]{1,64}$/.test(String(code || '')) ? String(code) : 'ACTION_UNCERTAIN';
  const safeStage = /^(clickConversationById|setReplyText|clickSendButton|applyTagByName|markCurrentConversationUnread)$/.test(String(stage || ''))
    ? String(stage)
    : 'action';
  const safeTabId = tabId === 'bot1' || tabId === 'bot2' ? tabId : '';
  await postQueueWithRetry({
    conversationId: String(conversationId || '').slice(0, 200),
    customerName: '',
    customerMessage: '',
    intent: 'AUTOMATION_REVIEW',
    reason: `Automation ${safeCode} at ${safeStage}`,
    pancakeUrl: '',
    technical: {
      tabId: safeTabId,
      code: safeCode,
      stage: safeStage
    }
  });
}

function createClickCoordinator(cacheMode) {
  return window.PDBConversationProcessing.createConversationProcessingCoordinator({
    claims: window.PDBConversationClaims,
    isProcessed: (key) => wasConversationProcessedAnywhere(key),
    commitProcessed: (key) => rememberConversationProcessedEverywhere(key),
    isConversationBlocked: (key) => uncertainConversationBlocks.has(key),
    blockConversation: (key) => uncertainConversationBlocks.add(key),
    addReviewItem: (item) => enqueueTechnicalReview({ ...item, cacheMode })
  });
}

// --- Panel: cửa sổ nổi kéo-thả ---
let panelPos = null; // { left, top } px — vị trí gần nhất

function openPanel() {
  const p = document.querySelector('.control-panel');
  p.classList.add('open');
  if ($('panelBackdrop')) $('panelBackdrop').hidden = false;
  if (panelPos) {
    // Kẹp lại trong viewport phòng khi cửa sổ app đã thu nhỏ từ lần kéo trước.
    const w = p.offsetWidth || 0;
    const left = Math.max(0, Math.min(panelPos.left, window.innerWidth - Math.min(w, 80)));
    const top = Math.max(0, Math.min(panelPos.top, window.innerHeight - 40));
    p.style.left = left + 'px';
    p.style.top = top + 'px';
    p.style.right = 'auto';
  }
  if ($('miniRail')) $('miniRail').classList.add('hidden');
}

function closePanel() {
  document.querySelector('.control-panel').classList.remove('open');
  if ($('panelBackdrop')) $('panelBackdrop').hidden = true;
  if ($('miniRail')) $('miniRail').classList.remove('hidden');
  if ($('settingsBtn')) $('settingsBtn').focus();
}

// Kéo cửa sổ nổi bằng thanh tiêu đề; kẹp trong viewport; lưu vị trí.
function enablePanelDrag() {
  const bar = $('panelTitlebar');
  const panel = document.querySelector('.control-panel');
  if (!bar || !panel) return;
  let dragging = false, offsetX = 0, offsetY = 0;

  bar.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;   // không kéo khi bấm nút (Req 2.4)
    const r = panel.getBoundingClientRect();
    offsetX = e.clientX - r.left;
    offsetY = e.clientY - r.top;
    dragging = true;
    panel.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = panel.offsetWidth, h = bar.offsetHeight;
    let left = Math.max(0, Math.min(e.clientX - offsetX, window.innerWidth - Math.min(w, 80)));  // Req 2.3
    let top = Math.max(0, Math.min(e.clientY - offsetY, window.innerHeight - h));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('dragging');
    const r = panel.getBoundingClientRect();
    panelPos = { left: r.left, top: r.top };   // Req 2.2, 3.4
  });
}

// --- Mini rail: bật/tắt bot + mở nhanh tab ---
function setBotUiState(running = Boolean(getActiveBotRuntime()?.botRunning)) {
  const activeTab = getTab(activeWvTab);
  const btn = $('miniBotBtn');
  if (btn) {
    btn.classList.toggle('on', running);
    btn.disabled = !activeTab.botCapable;
    btn.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'mini-dot';
    btn.appendChild(dot);
    const icon = document.createElement('span');
    icon.innerHTML = window.PDBIcons ? window.PDBIcons.svg(running ? 'pause' : 'play') : (running ? '⏸' : '▶');
    btn.appendChild(icon);
  }
  if ($('botEnabled')) {
    $('botEnabled').checked = running;
    $('botEnabled').disabled = !activeTab.botCapable;
  }
}

function refreshBrowserTabBadges() {
  document.querySelectorAll('.browser-tab').forEach((btn) => {
    const runtime = getTab(btn.dataset.wvtab).runtime;
    btn.classList.toggle('running', Boolean(runtime?.botRunning || runtime?.autoClickRunning || runtime?.autoReplyPreviewRunning));
  });
}

function refreshActiveTabRuntimeUi() {
  const tab = getTab(activeWvTab);
  const runtime = tab.runtime;
  syncLegacyRuntimeAliases(runtime || webviewTabs.bot1.runtime);
  const botOn = Boolean(runtime?.botRunning);
  const autoOn = Boolean(runtime?.autoClickRunning);
  const previewOn = Boolean(runtime?.autoReplyPreviewRunning || runtime?.autoReplyPreviewStopping);
  setBotUiState(botOn);
  setAutoClickUiState(autoOn);
  setAutoReplyPreviewUiState(previewOn);
  if ($('activeTabBotStatus')) {
    $('activeTabBotStatus').textContent = tab.botCapable
      ? `${tab.label}: ${botOn ? 'Bot running' : autoOn ? 'AutoClick running' : previewOn ? 'Preview Reply running' : 'Stopped'}`
      : `${tab.label}: thủ công`;
  }
  const floatingStatus = tab.botCapable ? (botOn ? 'Running' : autoOn ? 'Auto Click' : previewOn ? 'Preview Reply' : 'Ready') : 'Manual';
  if ($('floatingBotLabel')) $('floatingBotLabel').textContent = tab.label;
  if ($('floatingBotStatus')) $('floatingBotStatus').textContent = floatingStatus;
  if ($('bottomBotStatus')) $('bottomBotStatus').textContent = floatingStatus;
  if ($('startBotBtn')) $('startBotBtn').disabled = !tab.botCapable || botOn || autoOn || previewOn;
  if ($('stopBotBtn')) $('stopBotBtn').disabled = !tab.botCapable || !botOn;
  if ($('startAutoClickBtn')) $('startAutoClickBtn').disabled = !tab.botCapable || botOn || previewOn;
  if ($('startAutoReplyPreviewBtn')) $('startAutoReplyPreviewBtn').disabled = !tab.botCapable || botOn || autoOn || previewOn;
  if ($('stopAutoReplyPreviewBtn')) $('stopAutoReplyPreviewBtn').disabled = !tab.botCapable || !previewOn;
  if ($('autoReplyPreviewStatus')) $('autoReplyPreviewStatus').textContent = runtime?.autoReplyPreviewState || 'idle';
  if ($('stopAutoClickBtn')) $('stopAutoClickBtn').disabled = !tab.botCapable;
  setRuntimeState(tab.botCapable
    ? `${tab.label}: ${botOn ? 'Bot running' : autoOn ? 'AutoClick running' : previewOn ? 'Preview Reply running' : 'Stopped'}`
    : `${tab.label}: Manual`);
  refreshBrowserTabBadges();
}

async function startBot(runtime = getActiveBotRuntime()) {
  if (!runtime) { toast('Tab này không hỗ trợ bot', 4000); refreshActiveTabRuntimeUi(); return; }
  if (runtime.botRunning) {
    if ($('botEnabled')) $('botEnabled').checked = true;
    syncLegacyRuntimeAliases(runtime);
    updateAutomationActivity();
    refreshActiveTabRuntimeUi();
    return;
  }
  if (runtime.autoClickRunning) {                             // Req 2.3, 2.4, 9.1
    toast('Auto Click đang chạy trong tab này — hãy dừng Auto Click trước.', 5000);
    refreshActiveTabRuntimeUi();
    return;
  }
  if (anyRuntimeAutoReplyPreviewRunning()) {
    toast('Auto Reply Preview đang chạy — hãy dừng trước.', 5000);
    refreshActiveTabRuntimeUi();
    return;
  }
  await ensureBotChatPage(runtime);
  runtime.botRunning = true;
  if ($('botEnabled')) $('botEnabled').checked = true;
  try {
    await saveSettingsFromUi();
  } catch (error) {
    runtime.botRunning = false;
    syncLegacyRuntimeAliases(runtime);
    updateAutomationActivity();
    refreshActiveTabRuntimeUi();
    throw error;
  }
  if (!runtime.botLoopPromise) {
    runtime.botLoopPromise = botLoop(runtime).finally(() => { runtime.botLoopPromise = null; syncLegacyRuntimeAliases(runtime); refreshActiveTabRuntimeUi(); });
  }
  await log('INFO', 'BOT', prefixRuntime(runtime, 'Started'));
  syncLegacyRuntimeAliases(runtime);
  updateAutomationActivity();
  refreshActiveTabRuntimeUi();
}

async function stopBot(runtime = getActiveBotRuntime()) {
  if (!runtime) { toast('Tab này không hỗ trợ bot', 4000); return; }
  const wasRunning = Boolean(runtime.botRunning);
  runtime.botRunning = false;
  if ($('botEnabled')) $('botEnabled').checked = anyRuntimeBotRunning();
  if (!wasRunning) {
    syncLegacyRuntimeAliases(runtime);
    updateAutomationActivity();
    refreshActiveTabRuntimeUi();
    return;
  }
  await saveSettingsFromUi();
  await log('WARN', 'BOT', prefixRuntime(runtime, 'Emergency Stop'));
  syncLegacyRuntimeAliases(runtime);
  updateAutomationActivity();
  refreshActiveTabRuntimeUi();
}

async function toggleBotFromRail() {
  const runtime = getActiveBotRuntime();
  if (!runtime) { toast('Tab này không hỗ trợ bot', 4000); return; }
  if (runtime.botRunning) await stopBot(runtime);
  else await startBot(runtime);
}

// --- Auto Click: vòng lặp + start/stop + guard loại trừ lẫn nhau ---
// Đặt ngay sau toggleBotFromRail để nhất quán với nhóm điều phối Bot AI.
// Mọi log dùng type 'AUTOCLICK' để không lẫn vào computeBotStats.

// Task 5.3: cập nhật nút mini + đèn + checkbox (đặt trước để gọn nhóm).
function setAutoClickUiState(running = Boolean(getActiveBotRuntime()?.autoClickRunning)) {
  const activeTab = getTab(activeWvTab);
  const btn = $('miniAutoClickBtn');
  if (btn) {
    btn.classList.toggle('on', running);
    btn.disabled = !activeTab.botCapable;
    btn.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'mini-dot';
    btn.appendChild(dot);
    const icon = document.createElement('span');
    icon.innerHTML = window.PDBIcons ? window.PDBIcons.svg(running ? 'pause' : 'zap') : (running ? '⏸' : '⚡');
    btn.appendChild(icon);
  }
  if ($('autoClickEnabled')) {
    $('autoClickEnabled').checked = running;
    $('autoClickEnabled').disabled = !activeTab.botCapable;
  }
}

// Task 5.1: vòng lặp xử lý từng khách, try/catch mỗi vòng để không sập loop.
async function autoClickLoop(runtime) {
  runtime.autoClickRunning = true;
  syncLegacyRuntimeAliases(runtime);
  toast(`${getRuntimeLabel(runtime)} Auto Click đã bắt đầu`);
  while (runtime.autoClickRunning) {
    try {
      settings = await api('/api/settings');
      const result = await processOneAutoClick(runtime);
      if (result?.uncertain || result?.code === 'UNCERTAIN') {
        runtime.autoClickRunning = false;
        await logUncertainStop(runtime, 'AUTOCLICK', result?.stage || result?.uncertainMethod);
        break;
      }
      runtime.autoClickTransientErrorStreak = 0;
      await sleep(settings.autoClickDelayMs || 3000);   // Req 6.1, 6.3
    } catch (error) {
      if (error?.uncertain || error?.dispatched) {
        runtime.autoClickRunning = false;
        await logUncertainStop(runtime, 'AUTOCLICK', error?.uncertainMethod || error?.processingStage);
        break;
      }
      if (isTransientAutomationError(error)) {
        runtime.autoClickTransientErrorStreak = (runtime.autoClickTransientErrorStreak || 0) + 1;
        await logTransientAutomationError(runtime, 'AUTOCLICK', error, runtime.autoClickTransientErrorStreak);
        await sleep(3000);
        continue;
      }
      await log('ERROR', 'AUTOCLICK', prefixRuntime(runtime, error.message));   // Req 8.2
      toast(`${getRuntimeLabel(runtime)} Auto Click lỗi: ${error.message}`, 5000);
      await sleep(3000);
    }
  }
  if (runtime.tabId === activeWvTab) refreshActiveTabRuntimeUi();
  updateAutomationActivity();
  toast(`${getRuntimeLabel(runtime)} Auto Click đã dừng`);
}

// Task 5.2: bật Auto Click với guard botRunning (loại trừ lẫn nhau).
async function startAutoClick(runtime = getActiveBotRuntime()) {
  if (!runtime) { toast('Tab này không hỗ trợ Auto Click', 4000); refreshActiveTabRuntimeUi(); return; }
  if (runtime.botRunning) {                                   // Req 2.1, 2.2
    toast('Bot AI đang chạy trong tab này — hãy dừng Bot trước.', 5000);
    refreshActiveTabRuntimeUi();
    return;
  }
  if (anyRuntimeAutoReplyPreviewRunning()) {
    toast('Auto Reply Preview đang chạy — hãy dừng trước.', 5000);
    refreshActiveTabRuntimeUi();
    return;
  }
  if ($('autoClickEnabled')) $('autoClickEnabled').checked = true;
  await saveSettingsFromUi();
  if (!runtime.autoClickLoopPromise) {
    runtime.autoClickLoopPromise = autoClickLoop(runtime).finally(() => { runtime.autoClickLoopPromise = null; syncLegacyRuntimeAliases(runtime); refreshActiveTabRuntimeUi(); });
  }
  runtime.autoClickRunning = true;
  syncLegacyRuntimeAliases(runtime);
  updateAutomationActivity();
  refreshActiveTabRuntimeUi();
}

// Task 5.3: dừng Auto Click (dừng sau khi xong khách hiện tại).
async function stopAutoClick(runtime = getActiveBotRuntime()) {
  if (!runtime) { toast('Tab này không hỗ trợ Auto Click', 4000); return; }
  runtime.autoClickRunning = false;
  if ($('autoClickEnabled')) $('autoClickEnabled').checked = anyRuntimeAutoClickRunning();
  await saveSettingsFromUi();
  await log('WARN', 'AUTOCLICK', prefixRuntime(runtime, 'Đã dừng Auto Click'));
  syncLegacyRuntimeAliases(runtime);
  updateAutomationActivity();
  refreshActiveTabRuntimeUi();
}

function setAutoReplyPreviewUiState(running = Boolean(getActiveBotRuntime()?.autoReplyPreviewRunning)) {
  const activeTab = getTab(activeWvTab);
  const btn = $('miniAutoReplyPreviewBtn');
  if (!btn) return;
  btn.classList.toggle('on', running);
  btn.disabled = !activeTab.botCapable;
  btn.innerHTML = `<span class="mini-dot"></span><span>${window.PDBIcons ? window.PDBIcons.svg(running ? 'pause' : 'message') : (running ? '⏸' : '▢')}</span><span class="mini-label">Comment</span>`;
}

function readAutoReplyPreviewSettings() {
  const fallback = window.PDBAutoReplyPreview.DEFAULTS;
  try { return window.PDBAutoReplyPreview.normalizeSettings(JSON.parse(localStorage.getItem(AUTO_REPLY_PREVIEW_STORAGE_KEY) || '{}')); }
  catch (_) { return { ...fallback }; }
}

function autoReplyPreviewSettingsFromUi() {
  return window.PDBAutoReplyPreview.normalizeSettings({
    replyText: $('autoReplyPreviewShortcut').value,
    waitAfterConversationClickMs: $('autoReplyPreviewWaitAfterClick').value,
    waitBeforePreviewSendMs: $('autoReplyPreviewWaitBeforePreview').value,
    waitBeforeOuterReplyMs: $('autoReplyPreviewWaitBeforeOuter').value,
    loopDelayMs: $('autoReplyPreviewLoopDelay').value,
    selectorTimeoutMs: $('autoReplyPreviewSelectorTimeout').value
  });
}

function renderAutoReplyPreviewSettings(value = readAutoReplyPreviewSettings()) {
  if (!$('autoReplyPreviewShortcut')) return;
  $('autoReplyPreviewShortcut').value = value.replyText;
  $('autoReplyPreviewWaitAfterClick').value = value.waitAfterConversationClickMs;
  $('autoReplyPreviewWaitBeforePreview').value = value.waitBeforePreviewSendMs;
  $('autoReplyPreviewWaitBeforeOuter').value = value.waitBeforeOuterReplyMs;
  $('autoReplyPreviewLoopDelay').value = value.loopDelayMs;
  $('autoReplyPreviewSelectorTimeout').value = value.selectorTimeoutMs;
}

function saveAutoReplyPreviewSettings() {
  const value = autoReplyPreviewSettingsFromUi();
  localStorage.setItem(AUTO_REPLY_PREVIEW_STORAGE_KEY, JSON.stringify(value));
  renderAutoReplyPreviewSettings(value);
  toast('Đã lưu thông số Preview Reply');
}

async function autoReplyPreviewLoop(runtime, settingsValue) {
  runtime.autoReplyPreviewRunning = true;
  runtime.autoReplyPreviewState = 'running';
  refreshActiveTabRuntimeUi();
  try {
    await previewCall(runtime.tabId, `window.PDBAutoReplyPreviewController.start(${JSON.stringify(settingsValue)})`, 'autoReplyPreviewStart');
    while (runtime.autoReplyPreviewRunning) {
      if (getTab(runtime.tabId).loadGeneration !== runtime.autoReplyPreviewGeneration) {
        const error = new Error('Trang Pancake đã tải lại; Preview Reply đã dừng');
        error.code = 'PREVIEW_SEND_UNVERIFIED';
        throw error;
      }
      const status = await previewCall(runtime.tabId, 'window.PDBAutoReplyPreviewController.getStatus()', 'autoReplyPreviewStatus');
      runtime.autoReplyPreviewState = status?.state || status?.phase || 'running';
      if ($('autoReplyPreviewProgress')) $('autoReplyPreviewProgress').textContent = `Phase: ${status?.phase || 'running'} | Đã xử lý: ${status?.processedCount || 0} | Thử: ${status?.attemptedCount || 0}`;
      if (status?.lastErrorCode && $('autoReplyPreviewError')) { $('autoReplyPreviewError').hidden = false; $('autoReplyPreviewError').textContent = `${status.lastErrorCode}: ${status.lastError}`; }
      if (status?.state === 'failed' || status?.state === 'stopped') break;
      await sleep(500);
    }
  } catch (error) {
    runtime.autoReplyPreviewState = 'failed';
    if ($('autoReplyPreviewError')) { $('autoReplyPreviewError').hidden = false; $('autoReplyPreviewError').textContent = String(error.message || error); }
    toast(`Preview Reply lỗi: ${error.message}`, 5000);
  } finally {
    runtime.autoReplyPreviewRunning = false;
    runtime.autoReplyPreviewLoopPromise = null;
    updateAutomationActivity();
    refreshActiveTabRuntimeUi();
  }
}

async function startAutoReplyPreview(runtime = getActiveBotRuntime()) {
  if (!runtime) { toast('Tab này không hỗ trợ Preview Reply', 4000); return; }
  if (autoReplyPreviewStartLock || anyRuntimeBotRunning() || anyRuntimeAutoClickRunning() || anyRuntimeAutoReplyPreviewRunning()) {
    toast('Đang có automation khác chạy — hãy dừng trước.', 5000);
    return;
  }
  autoReplyPreviewStartLock = true;
  runtime.autoReplyPreviewRunning = true;
  runtime.autoReplyPreviewGeneration = getTab(runtime.tabId).loadGeneration;
  runtime.autoReplyPreviewState = 'starting';
  updateAutomationActivity();
  refreshActiveTabRuntimeUi();
  runtime.autoReplyPreviewLoopPromise = (async () => {
    try {
      await ensureBotChatPage(runtime);
      if (!runtime.autoReplyPreviewRunning || runtime.autoReplyPreviewStopping) return;
      const settingsValue = autoReplyPreviewSettingsFromUi();
      if ($('autoReplyPreviewError')) $('autoReplyPreviewError').hidden = true;
      await autoReplyPreviewLoop(runtime, settingsValue);
    } catch (error) {
      runtime.autoReplyPreviewState = 'failed';
      if ($('autoReplyPreviewError')) { $('autoReplyPreviewError').hidden = false; $('autoReplyPreviewError').textContent = String(error.message || error); }
      toast(`Preview Reply lỗi: ${error.message}`, 5000);
    }
  })().finally(() => {
    runtime.autoReplyPreviewLoopPromise = null;
    runtime.autoReplyPreviewRunning = false;
    runtime.autoReplyPreviewStopping = false;
    autoReplyPreviewStartLock = false;
    updateAutomationActivity();
    refreshActiveTabRuntimeUi();
  });
}

async function stopAutoReplyPreview(runtime = getActiveBotRuntime()) {
  if (!runtime) return;
  const loopPromise = runtime.autoReplyPreviewLoopPromise;
  if (runtime.autoReplyPreviewRunning) {
    runtime.autoReplyPreviewState = 'stopping';
    runtime.autoReplyPreviewStopping = true;
    runtime.autoReplyPreviewRunning = false;
    refreshActiveTabRuntimeUi();
    void previewCall(runtime.tabId, 'window.PDBAutoReplyPreviewController.stop()', 'autoReplyPreviewStop').catch(() => {});
  }
  if (loopPromise) await loopPromise.catch(() => {});
  runtime.autoReplyPreviewRunning = false;
  runtime.autoReplyPreviewStopping = false;
  autoReplyPreviewStartLock = false;
  updateAutomationActivity();
  refreshActiveTabRuntimeUi();
}

async function toggleAutoClickFromRail() {
  const runtime = getActiveBotRuntime();
  if (!runtime) { toast('Tab này không hỗ trợ Auto Click', 4000); return; }
  if (runtime.autoClickRunning) await stopAutoClick(runtime);
  else await startAutoClick(runtime);
}

async function toggleAutoReplyPreviewFromRail() {
  const runtime = getActiveBotRuntime();
  if (!runtime) { toast('Tab này không hỗ trợ Preview Reply', 4000); return; }
  if (runtime.autoReplyPreviewRunning || runtime.autoReplyPreviewStopping) await stopAutoReplyPreview(runtime);
  else await startAutoReplyPreview(runtime);
}

function openPanelTab(tabId) {
  openPanel();
  const tabBtn = document.querySelector(`.tab[data-tab="${tabId}"]`);
  if (tabBtn) tabBtn.click();   // tái dùng bindTabs: kích polling hàng đợi / render palette
}

// getURL() throws if the webview isn't attached/dom-ready yet.
function safeGetURL(wv, fallback) {
  try {
    if (wv && typeof wv.getURL === 'function') {
      const url = wv.getURL();
      if (url) return url;
    }
  } catch (_) { /* not ready yet */ }
  return fallback;
}

function switchWebviewTab(tabName) {
  const tab = getTab(tabName);
  activeWvTab = tab.id;
  document.querySelectorAll('.browser-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.wvtab === tab.id);
  });
  Object.values(webviewTabs).forEach((item) => {
    if (!item.webview) return;
    item.webview.classList.toggle('wv-active', item.id === tab.id);
    item.webview.classList.toggle('wv-hidden', item.id !== tab.id);
  });
  const currentUrl = safeGetURL(tab.webview, tab.webview.src || '');
  if (window.PDBWebviewTabNavigation?.shouldLazyLoadWebview(tab, currentUrl)) {
    navigateWebview(tab, pancakeUrl);
    if ($('webviewStatus')) $('webviewStatus').textContent = 'Đang tải...';
  }
  $('urlInput').value = safeGetURL(tab.webview, tab.expectedNavigationUrl || tab.webview.src || pancakeUrl);
  setActiveRuntimeMessages(tab.runtime);
  stopAssistantWatch();
  if (assistantEnabled && pageVisible && tab.botCapable) startAssistantWatch();
  refreshActiveTabRuntimeUi();
  updateDomSummary(tab.id);
}

// Returns the webview backing the currently active browser tab.
function activeWebview() {
  return getTab(activeWvTab).webview;
}

// --- Review queue (admin review) UI ---
function showReviewQueueError(msg) {
  const el = $('reviewQueueError');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideReviewQueueError() {
  const el = $('reviewQueueError');
  if (el) el.classList.add('hidden');
}

async function loadReviewQueue() {
  try {
    const data = await api('/api/review-queue');
    reviewQueueCache = (data.items || [])
      .filter((x) => x.status === 'pending')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // newest first (Req 2.8)
    renderReviewQueue(reviewQueueCache);
    hideReviewQueueError();
  } catch (_) {
    showReviewQueueError('Không tải được hàng đợi'); // keep stale cache (Req 2.9)
  }
}

function renderReviewQueue(items) {
  const list = $('reviewQueueList');
  const empty = $('reviewQueueEmpty');
  const count = Array.isArray(items) ? items.length : 0;
  $('reviewQueueBadge').textContent = count;
  if ($('miniQueueBadge')) $('miniQueueBadge').textContent = count;
  $('reviewQueueCount').textContent = count;

  if (!count) {
    if (empty) empty.classList.remove('hidden');
    if (list) list.innerHTML = '';
    return;
  }
  if (empty) empty.classList.add('hidden');

  list.innerHTML = items.map((item) => {
    const name = escapeHtml(item.customerName || '(không tên)');
    const rawMsg = String(item.customerMessage || '');
    const msg = escapeHtml(rawMsg.length > 140 ? rawMsg.slice(0, 140) + '…' : rawMsg);
    const reason = escapeHtml(item.reason || '');
    let when = '';
    try { when = escapeHtml(new Date(item.createdAt).toLocaleString()); } catch (_) {}
    const id = escapeHtml(item.id || '');
    const conv = escapeHtml(item.conversationId || '');
    const url = escapeHtml(item.pancakeUrl || '');
    const lookup = item.addressLookup || null;
    const mapsUrl = lookup?.googleMapsUrl ? escapeHtml(lookup.googleMapsUrl) : '';
    const addressBlock = mapsUrl ? `
      <div class="rq-address">
        <div><b>Địa chỉ:</b> ${escapeHtml(lookup.rawAddress || lookup.query || '')}</div>
        <div><b>Độ chắc chắn:</b> ${escapeHtml(lookup.confidence || 'medium')}</div>
        ${lookup.note ? `<div>${escapeHtml(lookup.note)}</div>` : ''}
        <a class="btn small ghost" href="${mapsUrl}" target="_blank" rel="noreferrer">Mở Google Maps</a>
      </div>` : '';
    return `<li class="rq-item">
      <div class="rq-item-name">${name}</div>
      <div class="rq-item-msg">${msg}</div>
      <div class="rq-item-reason">${reason}</div>
      ${addressBlock}
      <div class="rq-item-time">${when}</div>
      <div class="actions">
        <button class="btn small rq-open" data-id="${id}" data-conv="${conv}" data-url="${url}">Mở</button>
        <button class="btn small rq-done" data-id="${id}">Hoàn tất</button>
        <button class="btn small danger rq-del" data-id="${id}">Xóa</button>
      </div>
    </li>`;
  }).join('');
}

function getReviewTargetTabId() {
  return getTab(activeWvTab).botCapable ? activeWvTab : 'bot1';
}

async function navigateToConversation(item, tabId = getReviewTargetTabId()) {
  const tab = getTab(tabId);
  if (/^https?:\/\//.test(item.pancakeUrl || '')) {   // Req 3.3
    navigateWebview(tab, item.pancakeUrl);
    return true;
  }
  if (item.conversationId) {                            // Req 3.4
    try { await botCallForTab(tab.id, 'clickConversationById', item.conversationId); return true; }
    catch (_) { return false; }
  }
  return false;                                         // Req 3.5
}

async function openReviewItem(item) {
  const tabId = getReviewTargetTabId();
  switchWebviewTab(tabId);                              // Req 3.1
  const ok = await navigateToConversation(item, tabId);
  if (!ok) toast('Không mở được cuộc trò chuyện', 4000); // Req 3.5/3.6, item stays pending
}

async function markReviewDone(id) {
  await api(`/api/review-queue/${id}/done`, { method: 'POST' });
  await loadReviewQueue();
}

async function deleteReviewItemUI(id) {
  await api(`/api/review-queue/${id}`, { method: 'DELETE' });
  await loadReviewQueue();
}

async function clearDoneReview() {
  await api('/api/review-queue/clear-done', { method: 'POST' });
  await loadReviewQueue();
}

function startReviewQueuePolling() {
  stopReviewQueuePolling();
  loadReviewQueue();                                    // refresh immediately (Req 2.1)
  reviewQueueTimer = setInterval(loadReviewQueue, 5000); // poll every 5s (Req 2.5)
}

function stopReviewQueuePolling() {
  if (reviewQueueTimer) clearInterval(reviewQueueTimer);
  reviewQueueTimer = null;
}

function bindTabs() {
  const tabsBar = document.querySelector('.tabs');

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(btn.dataset.tab).classList.add('active');
      // Toggle review-queue polling based on which tab is active.
      if (btn.dataset.tab === 'reviewQueuePanel') startReviewQueuePolling();
      else stopReviewQueuePolling();
      // Cập nhật bảng shortcut khi mở tab Gợi ý.
      if (btn.dataset.tab === 'ai') renderShortcutPalette();
      // Tính lại thống kê bot khi mở tab Tổng quan.
      if (btn.dataset.tab === 'overview') computeBotStats();
      // Bring the clicked tab fully into view if the bar is overflowing.
      btn.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
  });

  enableDragScroll(tabsBar);
}

// Let an overflowing horizontal container be dragged with the mouse and
// scrolled with the vertical wheel. Used for the tab bar.
function enableDragScroll(el) {
  if (!el) return;
  let isDown = false;
  let startX = 0;
  let startScroll = 0;
  let moved = false;

  el.addEventListener('mousedown', (e) => {
    isDown = true; moved = false;
    startX = e.pageX;
    startScroll = el.scrollLeft;
    el.classList.add('dragging');
  });
  window.addEventListener('mouseup', () => { isDown = false; el.classList.remove('dragging'); });
  el.addEventListener('mouseleave', () => { isDown = false; el.classList.remove('dragging'); });
  el.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    const delta = e.pageX - startX;
    if (Math.abs(delta) > 3) moved = true;
    el.scrollLeft = startScroll - delta;
  });
  // Suppress the click that follows a drag so we don't switch tabs by accident.
  el.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, true);
  // Vertical wheel scrolls the bar horizontally.
  el.addEventListener('wheel', (e) => {
    if (e.deltaY === 0) return;
    e.preventDefault();
    el.scrollLeft += e.deltaY;
  }, { passive: false });
}

function bindUi() {
  const webviewStatus = $('webviewStatus');
  const bottomWebviewStatus = $('bottomWebviewStatus');
  const connectionStatus = $('webviewConnectionStatus');
  const loadingState = $('webviewLoading');
  const errorState = $('webviewError');
  const syncShellWebviewState = () => {
    const text = webviewStatus?.textContent || '';
    const loading = /Ä‘ang táº£i|connecting|loading|khÃ´i phá»¥c/i.test(text);
    const failed = /lá»—i|failed|error|khÃ´ng thá»ƒ|chÆ°a thá»ƒ/i.test(text);
    const connected = !loading && !failed && /loaded|ready|Ä‘Ã£ Ä‘Äƒng nháº­p|connected/i.test(text);
    if (bottomWebviewStatus) bottomWebviewStatus.textContent = text || (loading ? 'Loading' : 'WebView');
    if (connectionStatus) {
      connectionStatus.textContent = loading ? 'Loading' : failed ? 'Error' : connected ? 'Connected' : 'Connecting';
      connectionStatus.className = `surface-status ${loading ? 'loading' : failed ? 'error' : connected ? 'connected' : 'connecting'}`;
    }
    if (loadingState) loadingState.hidden = !loading;
    if (errorState) errorState.hidden = !failed;
  };
  if (webviewStatus && bottomWebviewStatus) {
    new MutationObserver(syncShellWebviewState).observe(webviewStatus, { childList: true, characterData: true, subtree: true });
    syncShellWebviewState();
  }
  // Panel toggle + mini rail
  $('panelCloseBtn').addEventListener('click', closePanel);
  if ($('panelMinBtn')) $('panelMinBtn').addEventListener('click', closePanel);
  enablePanelDrag();
  if ($('miniPanelBtn')) $('miniPanelBtn').addEventListener('click', openPanel);
  if ($('panelBackdrop')) $('panelBackdrop').addEventListener('click', closePanel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.querySelector('.control-panel.open')) closePanel();
  });
  if ($('miniBotBtn')) $('miniBotBtn').addEventListener('click', async () => {
    try { await toggleBotFromRail(); } catch (e) { toast(e.message, 5000); }
  });
  if ($('miniAutoClickBtn')) $('miniAutoClickBtn').addEventListener('click', async () => {
    try { await toggleAutoClickFromRail(); } catch (e) { toast(e.message, 5000); }
  });
  if ($('miniAutoReplyPreviewBtn')) $('miniAutoReplyPreviewBtn').addEventListener('click', async () => {
    try { await toggleAutoReplyPreviewFromRail(); } catch (e) { toast(e.message, 5000); }
  });
  if ($('miniQueueBtn')) $('miniQueueBtn').addEventListener('click', () => openPanelTab('reviewQueuePanel'));
  if ($('miniSuggestBtn')) $('miniSuggestBtn').addEventListener('click', () => openPanelTab('ai'));
  if ($('themeBtn')) $('themeBtn').addEventListener('click', toggleTheme);
  document.querySelectorAll('[data-open-devtools]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const target = button.dataset.openDevtools;
        const webview = target === 'main' ? null : getTab(target)?.webview;
        const webContentsId = webview?.getWebContentsId?.();
        await window.pancakeDesktop.openDevTools(webContentsId);
      } catch (error) {
        toast(`Không mở được Developer Tools: ${error.message}`, 5000);
      }
    });
  });

  // Browser webview tabs
  document.querySelectorAll('.browser-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchWebviewTab(btn.dataset.wvtab));
  });

  // Toolbar: Go / Reload target the active tab
  $('goBtn').addEventListener('click', () => {
    navigateWebview(getTab(activeWvTab), $('urlInput').value.trim() || pancakeUrl);
  });
  $('reloadBtn').addEventListener('click', async () => {
    try { await reloadActiveWebview(); } catch (e) { toast(e.message, 5000); }
  });
  if ($('pancakeLoginBtn')) $('pancakeLoginBtn').addEventListener('click', () => {
    openLoginInTab(getTab(activeWvTab), { force: true });
  });
  if ($('settingsBtn')) $('settingsBtn').addEventListener('click', () => openPanelTab('bot'));
  if ($('retryWebviewBtn')) $('retryWebviewBtn').addEventListener('click', async () => {
    try { await reloadActiveWebview(); } catch (e) { toast(e.message, 5000); }
  });
  document.querySelectorAll('.shortcut-dock-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      try { await fillShortcut(button.dataset.shortcut); }
      catch (e) { toast(e.message, 5000); }
    });
  });
  if ($('authLoginBtn')) $('authLoginBtn').addEventListener('click', signInOperator);
  if ($('authLogoutBtn')) $('authLogoutBtn').addEventListener('click', signOutOperator);
  $('saveSettingsBtn').addEventListener('click', saveSettingsFromUi);
  $('saveAiConfigBtn').addEventListener('click', async () => {
    try { await saveAiConfigFromUi(); } catch (e) { toast(e.message, 5000); }
  });
  $('testAiBtn').addEventListener('click', async () => {
    try { await testAiConfig(); } catch (e) { $('aiConfigStatus').textContent = e.message; toast(e.message, 5000); }
  });
  $('startBotBtn').addEventListener('click', async () => {
    try { await startBot(); } catch (e) { toast(e.message, 5000); }
  });
  $('stopBotBtn').addEventListener('click', async () => {
    try { await stopBot(); } catch (e) { toast(e.message, 5000); }
  });
  if ($('startAutoClickBtn')) $('startAutoClickBtn').addEventListener('click', async () => {
    try { await startAutoClick(); } catch (e) { toast(e.message, 5000); }
  });
  if ($('stopAutoClickBtn')) $('stopAutoClickBtn').addEventListener('click', async () => {
    try { await stopAutoClick(); } catch (e) { toast(e.message, 5000); }
  });
  if ($('saveAutoReplyPreviewBtn')) $('saveAutoReplyPreviewBtn').addEventListener('click', () => {
    try { saveAutoReplyPreviewSettings(); } catch (e) { toast(e.message, 5000); }
  });
  if ($('startAutoReplyPreviewBtn')) $('startAutoReplyPreviewBtn').addEventListener('click', async () => {
    try { await startAutoReplyPreview(); } catch (e) { toast(e.message, 5000); }
  });
  if ($('stopAutoReplyPreviewBtn')) $('stopAutoReplyPreviewBtn').addEventListener('click', async () => {
    try { await stopAutoReplyPreview(); } catch (e) { toast(e.message, 5000); }
  });
  if ($('autoClickEnabled')) $('autoClickEnabled').addEventListener('change', async (e) => {
    try { if (e.target.checked) await startAutoClick(); else await stopAutoClick(); }
    catch (err) { toast(err.message, 5000); }
  });
  $('shortcutSearch').addEventListener('input', renderShortcuts);
  if ($('paletteSearch')) $('paletteSearch').addEventListener('input', renderShortcutPalette);
  if ($('paletteList')) $('paletteList').addEventListener('click', (e) => {
    const btn = e.target.closest('.palette-btn');
    if (btn) teachAndFill(btn.dataset.shortcut);
  });
  if ($('assistantEnabled')) $('assistantEnabled').addEventListener('change', toggleAssistant);
  if ($('exampleSearch')) $('exampleSearch').addEventListener('input', renderExamples);
  if ($('clearExamplesBtn')) $('clearExamplesBtn').addEventListener('click', async () => {
    if (!confirm('Xóa toàn bộ ví dụ đã học? AI sẽ học lại từ đầu.')) return;
    try { await api('/api/examples/clear', { method: 'POST' }); await loadLearnedCount(); toast('Đã xóa hết ví dụ'); } catch (e) { toast(e.message); }
  });
  if ($('reloadExtBtn')) $('reloadExtBtn').addEventListener('click', async () => {
    $('reloadExtBtn').textContent = 'Đang reload...';
    try { await window.pancakeDesktop.reloadExtensions(); await loadExtensions(); toast('Đã reload extension'); }
    catch (e) { toast(e.message); }
    finally { $('reloadExtBtn').textContent = 'Reload tất cả'; }
  });
  if ($('openExtFolderBtn')) $('openExtFolderBtn').addEventListener('click', async () => {
    try { await window.pancakeDesktop.openExtensionsFolder(); } catch (e) { toast(e.message); }
  });
  $('analyzeBtn').addEventListener('click', async () => {
    try { renderAnalysis(await analyzeText($('aiMessage').value)); } catch (e) { toast(e.message); }
  });
  $('fillBestBtn').addEventListener('click', async () => {
    if (lastAnalysis?.bestShortcut) await fillShortcut(lastAnalysis.bestShortcut);
    else toast('Chưa có best shortcut');
  });
  $('uploadExcelBtn').addEventListener('click', uploadExcel);
  $('commitExcelBtn').addEventListener('click', commitExcel);
  $('templateBtn').addEventListener('click', () => window.pancakeDesktop.openExternal(`${serverUrl}/api/shortcuts/template`));
  $('clearLogsBtn').addEventListener('click', async () => { await api('/api/logs/clear', { method: 'POST' }); await loadLogs(); });
  if ($('botStatsRefresh')) $('botStatsRefresh').addEventListener('click', computeBotStats);

  // Review queue: refresh / clear-done + delegated row actions
  if ($('reviewQueueRefresh')) $('reviewQueueRefresh').addEventListener('click', loadReviewQueue);
  if ($('reviewQueueClearDone')) $('reviewQueueClearDone').addEventListener('click', async () => {
    try { await clearDoneReview(); toast('Đã xóa mục đã xong'); } catch (e) { toast(e.message); }
  });
  if ($('reviewQueueList')) $('reviewQueueList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = btn.dataset.id;
    try {
      if (btn.classList.contains('rq-open')) {
        await openReviewItem({ pancakeUrl: btn.dataset.url, conversationId: btn.dataset.conv });
      } else if (btn.classList.contains('rq-done')) {
        await markReviewDone(id);
      } else if (btn.classList.contains('rq-del')) {
        await deleteReviewItemUI(id);
      }
    } catch (err) { toast(err.message); }
  });

  document.querySelectorAll('[data-domtest]').forEach((btn) => {
    btn.addEventListener('click', async () => runDomTest(btn.dataset.domtest));
  });

  Object.values(webviewTabs).forEach((tab) => {
    if (!tab.webview) return;
    const finishTabLoad = async (event = {}) => {
      const loadedUrl = safeGetURL(tab.webview, tab.webview.src || '');
      const shouldAcceptLoad = window.PDBWebviewAutomation?._shouldAcceptWebviewLoad;
      if (shouldAcceptLoad && !shouldAcceptLoad(tab, { loadedUrl, event })) return;
      if (tab.readyHandledGeneration === tab.loadGeneration) return;
      tab.readyHandledGeneration = tab.loadGeneration;
      const completedReload = tab.reloadGeneration === tab.loadGeneration;
      tab.loaded = true;
      tab.completedGeneration = tab.loadGeneration;
      tab.loadState = 'loaded';
      tab.loadError = null;
      tab.authState = 'transition';
      if (completedReload) tab.reloadGeneration = null;
      tab.automationInjected = false; // page reloaded -> __PDB__ is gone, re-inject lazily
      tab.injectionGeneration = -1;
      if (activeWvTab === tab.id) {
        $('urlInput').value = safeGetURL(tab.webview, tab.webview.src || pancakeUrl);
        $('webviewStatus').textContent = `${tab.label} loaded`;
      }
      const resolveChatEntry = window.PDBPancakeUrlPolicy.resolveChatEntryUrl;
      const loadedChatEntry = typeof resolveChatEntry === 'function'
        ? resolveChatEntry(loadedUrl)
        : '';
      if (tab.authLoginPending && loadedChatEntry && tab.authReturnUrl && loadedChatEntry !== tab.authReturnUrl) {
        if (activeWvTab === tab.id) $('webviewStatus').textContent = 'Đã đăng nhập, đang mở lại trang chốt đơn...';
        navigateWebview(tab, tab.authReturnUrl);
        await waitForTabReady(tab, 'auth return');
        return;
      }
      if (tab.authLoginPending && loadedChatEntry && (!tab.authReturnUrl || loadedChatEntry === tab.authReturnUrl)) {
        tab.authState = 'ready';
        tab.authLoginPending = false;
        tab.authReturnUrl = '';
        if (activeWvTab === tab.id && $('pancakeLoginBtn')) $('pancakeLoginBtn').hidden = true;
      }
      if (tab.botCapable) {
        try {
          await injectAutomation(tab.id);
          tab.authState = 'ready';
          tab.authLoginPending = false;
          tab.authReturnUrl = '';
          if ($('pancakeLoginBtn')) $('pancakeLoginBtn').hidden = true;
          if (activeWvTab === tab.id) await updateDomSummary(tab.id);
        } catch (error) {
          if (window.PDBPancakeAutomationGate.isAuthRequiredError(error)) {
            showAuthRequiredState(tab, error);
          } else if (activeWvTab === tab.id && error?.code === 'WRONG_PANCAKE_PAGE') {
            $('domSummary').textContent = error.message;
            $('unreadCount').textContent = '0';
            $('webviewStatus').textContent = error.message;
          } else if (activeWvTab === tab.id) {
            $('webviewStatus').textContent = 'Inject lỗi: ' + error.message;
          }
        }
      }
    };
    tab.webview.addEventListener('did-finish-load', finishTabLoad);
    tab.webview.addEventListener('pdb-navigation-ready', finishTabLoad);
    tab.webview.addEventListener('dom-ready', (event) => {
      if (!tab.webview.isLoading?.()) finishTabLoad(event);
    });
    tab.webview.addEventListener('did-stop-loading', finishTabLoad);
    const markAuthTransition = (event = {}) => {
      tab.authState = 'transition';
      tab.automationInjected = false;
      tab.injectionGeneration = -1;
      tab.lastNavigationUrl = event.url || safeGetURL(tab.webview, tab.webview.src || '');
    };
    tab.webview.addEventListener('did-navigate', markAuthTransition);
    tab.webview.addEventListener('did-navigate-in-page', markAuthTransition);
    tab.webview.addEventListener('did-start-loading', () => {
      window.PDBWebviewAutomation.startGuestNavigationLoad(tab);
      tab.readyHandledGeneration = -1;
      tab.authState = 'transition';
      if (activeWvTab === tab.id) $('webviewStatus').textContent = 'Đang tải...';
    });
    tab.webview.addEventListener('did-fail-load', (event) => {
      const shouldAcceptLoad = window.PDBWebviewAutomation?._shouldAcceptWebviewLoad;
      if (shouldAcceptLoad && !shouldAcceptLoad(tab, {
        loadedUrl: event.validatedURL || '',
        event,
        failure: true
      })) return;
      const failedReload = tab.reloadGeneration === tab.loadGeneration;
      tab.automationInjected = false;
      tab.injectionGeneration = -1;
      tab.loaded = false;
      tab.loadState = 'failed';
      if (failedReload) tab.reloadGeneration = null;
      const detail = `${tab.label} load lỗi: ${event.errorCode || ''} ${event.errorDescription || ''}`.trim();
      tab.loadError = detail;
      if (activeWvTab === tab.id) $('webviewStatus').textContent = detail;
    });
    tab.webview.addEventListener('render-process-gone', (event) => {
      tab.automationInjected = false;
      tab.injectionGeneration = -1;
      tab.loaded = false;
      tab.loadState = 'gone';
      tab.reloadGeneration = null;
      const detail = `${tab.label} renderer dừng: ${event.reason || 'unknown'}`;
      tab.loadError = detail;
      if (activeWvTab === tab.id) $('webviewStatus').textContent = detail;
    });
    // "Script failed to execute" only tells us the guest threw; the stack stays
    // in the guest's own console. Keep the newest guest-side error so transient
    // automation failures can report where it actually threw.
    tab.webview.addEventListener('console-message', (event) => {
      if (Number(event.level) < 2) return;   // errors/warnings only
      tab.lastGuestConsoleError = {
        text: String(event.message || '').slice(0, 300),
        source: `${String(event.sourceId || '').split('/').pop()}:${event.line || 0}`,
        at: Date.now()
      };
    });
  });
}

async function uploadExcel() {
  const file = $('excelFile').files[0];
  if (!file) return toast('Chọn file Excel trước');
  const fd = new FormData();
  fd.append('file', file);
  const res = await api('/api/shortcuts/import-excel', { method: 'POST', body: fd });
  $('importResult').innerHTML = `<b>Preview:</b> ${res.validRows.length} hợp lệ, ${res.errors.length} lỗi<br>${res.errors.map((e) => `<div style="color:#dc2626">Dòng ${e.line}: ${escapeHtml(e.error)}</div>`).join('')}`;
  toast('Đã preview Excel');
}

async function commitExcel() {
  const res = await api('/api/shortcuts/commit-import', { method: 'POST', body: JSON.stringify({ mode: 'overwrite' }) });
  shortcuts = res.items || [];
  renderShortcuts();
  toast('Đã import shortcuts');
}

async function runDomTest(name) {
  try {
    let result;
    if (name === 'status') result = await botCall('getDomStatus');
    if (name === 'unread') result = await botCall('getUnreadConversations');
    if (name === 'fill1') result = await botCall('setReplyText', '/1');
    if (name === 'sendBtn') result = await botCall('findSendButton');
    if (name === 'tagNew') result = await botCall('applyTagByName', settings.newCustomerTagName || 'Saruto Mới');
    if (name === 'tagBuy') result = await botCall('applyTagByName', settings.buyTagName || 'Mua hàng');
    if (name === 'markUnread') result = await botCall('markCurrentConversationUnread');
    if (name === 'recentMsgs') result = await botCall('getRecentMessages', 5);
    if (name === 'orderStatus') result = await botCall('getCustomerOrderStatus');
    if (name === 'openOrders') {
      result = await botCall('openCustomerOrders');
      if (result?.ok && result.mode === 'url' && result.url) {
        result.window = await window.pancakeDesktop.openOrderWindow(result.url);
      }
    }
    $('domTestResult').textContent = safeJson(result);
    await updateDomSummary();
  } catch (error) {
    $('domTestResult').textContent = error.stack || error.message;
  }
}

function startPolling() {
  if (timers.length) return; // already running
  timers.push(setInterval(loadHealth, 5000));
  timers.push(setInterval(loadLogs, 4000));
  timers.push(setInterval(updateDomSummary, 7000));
}

function stopPolling() {
  while (timers.length) clearInterval(timers.pop());
}

function applyVisibility(state) {
  const visible = state !== 'hidden';
  if (visible === pageVisible) return;
  pageVisible = visible;
  if (visible) {
    startPolling();
    if (assistantEnabled) startAssistantWatch();        // Req 5.9
  } else {
    if (anyRuntimeAutomationActive()) {
      startPolling();
      return;
    }
    // Pause background work and hint the engine to reclaim memory.
    stopPolling();
    stopAssistantWatch();                               // Req 5.9
    if (typeof window.gc === 'function') {
      try { window.gc(); } catch (_) {}
    }
  }
}

// --- electron-updater toast notification ---
function initUpdaterToast() {
  if (!window.pancakeDesktop?.onUpdateState) return;
  const toast = document.getElementById('updateToast');
  const msg = document.getElementById('updateToastMsg');
  const progressWrap = document.getElementById('updateProgressWrap');
  const progressBar = document.getElementById('updateProgressBar');
  const installBtn = document.getElementById('updateInstallBtn');
  const dismissBtn = document.getElementById('updateDismissBtn');
  if (!toast || !msg) return;

  function show(message, showInstall = false, showProgress = false) {
    msg.textContent = message;
    toast.classList.remove('hidden');
    progressWrap.classList.toggle('hidden', !showProgress);
    installBtn.classList.toggle('hidden', !showInstall);
  }

  dismissBtn?.addEventListener('click', () => toast.classList.add('hidden'));

  installBtn?.addEventListener('click', () => {
    window.pancakeDesktop.quitAndInstall?.();
  });

  window.pancakeDesktop.onUpdateAvailable?.((info) => {
    show(`Bản cập nhật ${info?.version || 'mới'} đang tải xuống...`, false, true);
  });

  window.pancakeDesktop.onUpdateProgress?.((progress) => {
    const pct = Math.round(progress?.percent ?? 0);
    progressBar.style.width = `${pct}%`;
    msg.textContent = `Đang tải bản cập nhật: ${pct}%`;
  });

  window.pancakeDesktop.onUpdateDownloaded?.((info) => {
    progressBar.style.width = '100%';
    show(`Bản ${info?.version || 'mới'} đã sẵn sàng cài đặt.`, true, false);
  });

  window.pancakeDesktop.onUpdateError?.((err) => {
    const raw = String(err?.message || '');
    if (!raw || /trust configuration|not-configured|cannot parse|no published|unable to find/i.test(raw)) return;
    msg.textContent = `Lỗi cập nhật: ${raw.split('\n')[0].slice(0, 120)}`;
    toast.classList.remove('hidden');
    installBtn.classList.add('hidden');
    progressWrap.classList.add('hidden');
  });
}

async function init() {
  initUpdaterToast();
  initTheme();
  bindTabs();
  bindUi();
  const env = await window.pancakeDesktop.getEnv();
  serverUrl = env.serverUrl || serverUrl;
  localApiToken = String(env.apiToken || '');
  pancakeUrl = normalizePancakeBotUrl(env.pancakeUrl || pancakeUrl);
  await loadControlPlaneStatus();
  if (window.pancakeDesktop.onAuthStatus) window.pancakeDesktop.onAuthStatus(renderControlPlaneStatus);
  $('urlInput').value = pancakeUrl;
  Object.values(webviewTabs).forEach((tab) => navigateWebview(tab, pancakeUrl));
  await loadHealth();
  await loadSettings();
  await loadAiConfig();
  await loadShortcuts();
  await loadLogs();
  await loadLearnedCount();
  await loadExtensions();
  computeBotStats();   // thống kê bot lần đầu (tab Tổng quan)
  startPolling();
  notifyMainAutomationState();

  // Pause polling when the window/tab is not visible to cut idle RAM/CPU.
  if (window.pancakeDesktop.onVisibilityChange) {
    window.pancakeDesktop.onVisibilityChange(applyVisibility);
  }
  document.addEventListener('visibilitychange', () => {
    applyVisibility(document.hidden ? 'hidden' : 'visible');
  });
}

init().catch((error) => toast(error.message, 6000));

// Export có điều kiện cho test thuần (node:test) — KHÔNG ảnh hưởng môi trường browser.
// Khi chạy trong renderer, typeof module === 'undefined' nên block này được bỏ qua.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Object.assign(module.exports || {}, {
    makeDedupeKey,
    shouldSkipByTags,
    rememberAutoClickProcessed,
    autoClickProcessed,
    AUTOCLICK_PROCESSED_TTL_MS,
    AUTOCLICK_PROCESSED_MAX_ENTRIES
  });
}
