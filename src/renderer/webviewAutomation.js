(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.PDBWebviewAutomation = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DEFAULT_WEBVIEW_READY_TIMEOUT_MS = 15000;
  const DEFAULT_AUTOMATION_TIMEOUT_MS = 15000;
  const READ_METHODS = new Set([
    'getUnreadConversations',
    'getDomStatus',
    'getDomHealth',
    'getRecentMessages',
    'getCustomerOrderStatus',
    'getLastMessageSender',
    'getCurrentCustomerName',
    'getCurrentTags',
    'getActiveConversationId',
    'location.href',
    'injectAutomation'
  ]);

  const ACTION_METHODS = new Set([
    'clickConversationById',
    'setReplyText',
    'clickSendButton',
    'applyTagByName',
    'markCurrentConversationUnread'
  ]);

  // Actions safe to repeat: replaying them lands the page in the same state as
  // a single successful call, so a transient guest-view failure can be retried
  // and does not need to stop the bot for an uncertain state.
  //   clickConversationById - reopens the same conversation
  //   setReplyText          - rewrites the composer with the same shortcut
  //   applyTagByName        - guards on `alreadyApplied` before clicking
  // clickSendButton and markCurrentConversationUnread are deliberately absent:
  // replaying them can double-send a message or flip unread back off.
  const IDEMPOTENT_ACTION_METHODS = new Set([
    'clickConversationById',
    'setReplyText',
    'applyTagByName'
  ]);

  const TRANSIENT_PATTERNS = [
    /GUEST_VIEW_MANAGER_CALL/i,
    /Script failed to execute/i,
    /^\[object Object\]$/,
    /webview.*(loading|destroyed|hủy|huỷ)/i,
    /(loading|destroyed).*webview/i,
    /render process/i
    ,/AUTOMATION_TIMEOUT/i
    ,/window\.__PDB__.*(missing|undefined|not injected)/i
    ,/AUTOMATION_NOT_INJECTED/i
  ];

  const queueTails = new Map();

  function errorText(error) {
    if (!error) return '';
    if (typeof error === 'string') return error;
    const parts = [];
    if (error.message) parts.push(error.message);
    if (error.code) parts.push(String(error.code));
    if (error.name) parts.push(error.name);
    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') parts.push(json);
    } catch (_) {}
    const fallback = String(error);
    if (fallback && fallback !== '[object Object]') parts.push(fallback);
    return parts.filter(Boolean).join(' | ') || fallback;
  }

  function isTransientGuestViewError(error) {
    const text = errorText(error);
    return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
  }

  function getRetryAttempts(method) {
    if (READ_METHODS.has(method)) return 3;
    if (IDEMPOTENT_ACTION_METHODS.has(method)) return 2;
    if (ACTION_METHODS.has(method)) return 1;
    return 1;
  }

  function isActionMethod(method) {
    return ACTION_METHODS.has(method);
  }

  function isIdempotentActionMethod(method) {
    return IDEMPOTENT_ACTION_METHODS.has(method);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function runWithTimeout(execution, timeoutMs, method) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${method} timed out after ${timeoutMs}ms`);
        error.code = 'AUTOMATION_TIMEOUT';
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([execution, timeout]).finally(() => clearTimeout(timer));
  }

  function safeGetWebviewUrl(wv) {
    try {
      if (wv && typeof wv.getURL === 'function') return wv.getURL() || '';
    } catch (_) {}
    return wv?.src || '';
  }

  function sanitizeUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || ''));
      return `${parsed.origin}${parsed.pathname}`;
    } catch (_) {
      return '';
    }
  }

  function isWebviewDestroyed(wv) {
    if (!wv || typeof wv.isDestroyed !== 'function') return false;
    try { return Boolean(wv.isDestroyed()); } catch (_) { return false; }
  }

  function isWebviewLoading(wv) {
    if (!wv || typeof wv.isLoading !== 'function') return false;
    try { return Boolean(wv.isLoading()); } catch (_) { return false; }
  }

  function webviewReadyError(tab, label, reason) {
    const tabLabel = tab?.label || 'Webview';
    const url = sanitizeUrl(safeGetWebviewUrl(tab?.webview));
    return new Error(`${tabLabel}: ${label} webview loading/ready wait failed${url ? `, url=${url}` : ''} - ${reason}`);
  }

  function isWebviewReady(tab) {
    const wv = tab?.webview;
    if (!wv) return false;
    if (isWebviewDestroyed(wv)) return false;
    const generationReady = tab.completedGeneration == null
      || tab.completedGeneration === tab.loadGeneration;
    return Boolean(tab.loaded) && generationReady && !isWebviewLoading(wv);
  }

  function isTrackedReloadGeneration(tab) {
    return tab?.reloadGeneration != null && tab.reloadGeneration === tab.loadGeneration;
  }

  function shouldAcceptWebviewLoad(tab, options = {}) {
    const event = options.event || {};
    if (options.failure && Number(event.errorCode) === -3) return false;
    const eventGeneration = event.generation ?? event.detail?.generation;
    if (eventGeneration == null && tab?.pendingNavigationToken) return false;
    if (eventGeneration != null && eventGeneration !== tab?.loadGeneration) return false;
    const loadedUrl = String(options.loadedUrl || event.validatedURL || '');
    if (!isTrackedReloadGeneration(tab) && tab?.expectedNavigationUrl && loadedUrl && loadedUrl !== tab.expectedNavigationUrl) {
      return false;
    }
    return true;
  }

  function emitNavigationEvent(webview, name, detail) {
    if (typeof webview?.emit === 'function') {
      webview.emit(name, { detail, generation: detail.generation });
      return;
    }
    if (typeof webview?.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      webview.dispatchEvent(new CustomEvent(name, { detail }));
    }
  }

  function startTrackedNavigation(tab, targetUrl, load) {
    if (!tab?.webview) throw new TypeError('Tracked navigation requires a webview');
    const generation = Number(tab.loadGeneration || 0) + 1;
    const token = Object.freeze({ generation, targetUrl: String(targetUrl || '') });
    tab.loadGeneration = generation;
    tab.pendingNavigationToken = token;
    tab.reloadGeneration = null;
    tab.expectedNavigationUrl = token.targetUrl;
    tab.loaded = false;
    tab.loadState = 'loading';
    tab.loadError = null;
    tab.automationInjected = false;
    tab.injectionGeneration = -1;

    const startLoad = typeof load === 'function'
      ? load
      : (url) => tab.webview.loadURL(url);
    let execution;
    try {
      execution = Promise.resolve(startLoad(token.targetUrl));
    } catch (error) {
      execution = Promise.reject(error);
    }
    const promise = execution.then(() => {
      if (tab.pendingNavigationToken !== token) {
        return { ok: false, code: 'STALE_NAVIGATION', generation };
      }
      tab.pendingNavigationToken = null;
      tab.loaded = true;
      tab.completedGeneration = generation;
      tab.loadState = 'loaded';
      tab.loadError = null;
      emitNavigationEvent(tab.webview, 'pdb-navigation-ready', { generation });
      return { ok: true, generation };
    }, (error) => {
      if (tab.pendingNavigationToken !== token) {
        return { ok: false, code: 'STALE_NAVIGATION', generation };
      }
      tab.pendingNavigationToken = null;
      tab.loaded = false;
      tab.loadState = 'failed';
      tab.loadError = `${tab.label || 'Webview'} navigation failed`;
      emitNavigationEvent(tab.webview, 'pdb-navigation-failed', { generation });
      return { ok: false, code: 'NAVIGATION_FAILED', generation, error };
    });
    return { generation, token, promise };
  }

  function startGuestNavigationLoad(tab) {
    if (!tab) throw new TypeError('Guest navigation requires a tab');
    const untracked = !tab.pendingNavigationToken && tab.loadState !== 'loading';
    if (untracked) {
      tab.loadGeneration = Number(tab.loadGeneration || 0) + 1;
      tab.expectedNavigationUrl = '';
      tab.reloadGeneration = null;
    }
    tab.loaded = false;
    tab.loadState = 'loading';
    tab.loadError = null;
    tab.automationInjected = false;
    tab.injectionGeneration = -1;
    return Object.freeze({ generation: tab.loadGeneration, untracked });
  }

  function getReloadReadiness(tab) {
    const wv = tab?.webview;
    if (!wv) return { ok: false, reason: 'missing webview' };
    if (isWebviewDestroyed(wv)) return { ok: false, reason: 'webview destroyed' };
    if (typeof wv.reload !== 'function') return { ok: false, reason: 'webview reload unavailable' };
    if (isWebviewLoading(wv)) return { ok: false, reason: 'webview loading' };
    if (tab.loaded !== true) return { ok: false, reason: 'tab not loaded' };
    return { ok: true, webview: wv };
  }

  function snapshotReloadState(tab) {
    return {
      loaded: tab.loaded,
      loadState: tab.loadState,
      loadError: tab.loadError,
      automationInjected: tab.automationInjected,
      injectionGeneration: tab.injectionGeneration,
      loadGeneration: tab.loadGeneration,
      completedGeneration: tab.completedGeneration,
      expectedNavigationUrl: tab.expectedNavigationUrl,
      reloadGeneration: tab.reloadGeneration,
      pendingNavigationToken: tab.pendingNavigationToken
    };
  }

  function restoreReloadState(tab, snapshot) {
    tab.loaded = snapshot.loaded;
    tab.loadState = snapshot.loadState;
    tab.loadError = snapshot.loadError;
    tab.automationInjected = snapshot.automationInjected;
    tab.injectionGeneration = snapshot.injectionGeneration;
    tab.loadGeneration = snapshot.loadGeneration;
    tab.completedGeneration = snapshot.completedGeneration;
    tab.expectedNavigationUrl = snapshot.expectedNavigationUrl;
    tab.reloadGeneration = snapshot.reloadGeneration;
    tab.pendingNavigationToken = snapshot.pendingNavigationToken;
  }

  function startTrackedReload(tab, options = {}) {
    const ready = getReloadReadiness(tab);
    if (!ready.ok) {
      return { ok: false, code: 'WEBVIEW_NOT_READY', reason: ready.reason };
    }

    const snapshot = snapshotReloadState(tab);
    const generation = Number(tab.loadGeneration || 0) + 1;
    const targetUrl = String(options.targetUrl || safeGetWebviewUrl(ready.webview) || options.fallbackUrl || '');
    tab.loadGeneration = generation;
    tab.pendingNavigationToken = null;
    tab.reloadGeneration = generation;
    tab.expectedNavigationUrl = targetUrl;
    tab.loaded = false;
    tab.loadState = 'loading';
    tab.loadError = null;
    tab.automationInjected = false;
    tab.injectionGeneration = -1;

    try {
      ready.webview.reload();
    } catch (error) {
      restoreReloadState(tab, snapshot);
      return { ok: false, code: 'RELOAD_FAILED', error };
    }

    return { ok: true, generation, targetUrl };
  }

  function waitForWebviewReady(tab, options = {}) {
    const wv = tab?.webview;
    const label = options.label || 'executeJavaScript';
    const timeoutMs = Math.max(1, options.timeoutMs || DEFAULT_WEBVIEW_READY_TIMEOUT_MS);
    const expectedGeneration = options.generation;
    if (!wv) return Promise.reject(webviewReadyError(tab, label, 'missing webview'));
    if (isWebviewDestroyed(wv)) return Promise.reject(webviewReadyError(tab, label, 'webview destroyed'));
    if (isWebviewReady(tab)) return Promise.resolve(true);

    return new Promise((resolve, reject) => {
      let done = false;
      let timer = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
      if (typeof wv.removeEventListener === 'function') {
        wv.removeEventListener('did-finish-load', onFinish);
        wv.removeEventListener('dom-ready', onFinish);
        wv.removeEventListener('did-stop-loading', onFinish);
        wv.removeEventListener('did-fail-load', onFail);
          wv.removeEventListener('pdb-navigation-ready', onFinish);
          wv.removeEventListener('pdb-navigation-failed', onFail);
          wv.removeEventListener('render-process-gone', onGone);
        }
      };
      const finish = (fn) => {
        if (done) return;
        done = true;
        cleanup();
        fn();
      };
      const eventMatchesGeneration = (event = {}) => {
        if (expectedGeneration == null) return true;
        const eventGeneration = event.generation ?? event.detail?.generation;
        if (eventGeneration != null) return eventGeneration === expectedGeneration;
        return tab.loadGeneration === expectedGeneration
          && (tab.completedGeneration == null || tab.completedGeneration === expectedGeneration);
      };
      const onFinish = (event = {}) => {
        if (!eventMatchesGeneration(event)) return;
        finish(() => resolve(true));
      };
      const onFail = (event = {}) => {
        if (!eventMatchesGeneration(event)) return;
        if (Number(event.errorCode) === -3) return;
        finish(() => {
          const detail = [event.errorCode, event.errorDescription].filter(Boolean).join(' ');
          reject(webviewReadyError(tab, label, detail || 'load failed'));
        });
      };
      const onGone = (event = {}) => finish(() => {
        reject(webviewReadyError(tab, label, event.reason || 'render process gone'));
      });

      if (typeof wv.addEventListener === 'function') {
        wv.addEventListener('did-finish-load', onFinish);
        wv.addEventListener('dom-ready', onFinish);
        wv.addEventListener('did-stop-loading', onFinish);
        wv.addEventListener('did-fail-load', onFail);
        wv.addEventListener('pdb-navigation-ready', onFinish);
        wv.addEventListener('pdb-navigation-failed', onFail);
        wv.addEventListener('render-process-gone', onGone);
      }

      if (isWebviewReady(tab)) {
        finish(() => resolve(true));
        return;
      }

      timer = setTimeout(() => {
        finish(() => reject(webviewReadyError(tab, label, `timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
    });
  }

  function enqueueWebviewTask(task, options = {}) {
    const tabId = String(options.tabId || 'default');
    const tail = queueTails.get(tabId) || Promise.resolve();
    const run = tail.catch(() => {}).then(task);
    const settled = run.catch(() => {});
    queueTails.set(tabId, settled);
    settled.finally(() => {
      if (queueTails.get(tabId) === settled) queueTails.delete(tabId);
    });
    return run;
  }

  function enqueueTimedWebviewTask(task, options = {}) {
    const tabId = String(options.tabId || 'default');
    const previous = queueTails.get(tabId) || Promise.resolve();
    let releaseReservation;
    const reservation = new Promise((resolve) => { releaseReservation = resolve; });
    queueTails.set(tabId, reservation);

    const caller = previous.catch(() => {}).then(() => {
      const execution = Promise.resolve().then(task);
      execution.then(releaseReservation, releaseReservation);
      return runWithTimeout(execution, options.timeoutMs, options.method);
    });
    reservation.finally(() => {
      if (queueTails.get(tabId) === reservation) queueTails.delete(tabId);
    });
    return caller;
  }

  function buildRetryError(error, method, attempt, attempts) {
    const wrapped = new Error(`${method} transient automation failed after ${attempt}/${attempts}: ${errorText(error)}`);
    wrapped.cause = error;
    wrapped.transientGuestView = true;
    return wrapped;
  }

  async function executeWithRetry(run, options = {}) {
    const method = options.method || 'executeJavaScript';
    const requested = Math.max(1, options.attempts || getRetryAttempts(method));
    // A non-idempotent action may already have taken effect in the guest, so it
    // is never replayed - not even when a caller asks for extra attempts.
    const attempts = isActionMethod(method) && !isIdempotentActionMethod(method)
      ? 1
      : requested;
    const baseDelayMs = Math.max(0, options.baseDelayMs ?? 200);
    const timeoutMs = Math.max(1, options.timeoutMs || DEFAULT_AUTOMATION_TIMEOUT_MS);
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await enqueueTimedWebviewTask(run, {
          tabId: options.tabId,
          timeoutMs,
          method
        });
      } catch (error) {
        lastError = error;
        if (!isTransientGuestViewError(error) || attempt >= attempts) throw error;
        if (typeof options.onBeforeRetry === 'function') {
          await options.onBeforeRetry({ attempt: attempt + 1, method, error });
        }
        await delay(baseDelayMs * attempt);
      }
    }
    throw buildRetryError(lastError, method, attempts, attempts);
  }

  return {
    isTransientGuestViewError,
    DEFAULT_WEBVIEW_READY_TIMEOUT_MS,
    DEFAULT_AUTOMATION_TIMEOUT_MS,
    isActionMethod,
    isIdempotentActionMethod,
    getRetryAttempts,
    startTrackedNavigation,
    startGuestNavigationLoad,
    startTrackedReload,
    waitForWebviewReady,
    enqueueWebviewTask,
    executeWithRetry,
    _errorText: errorText,
    _shouldAcceptWebviewLoad: shouldAcceptWebviewLoad
  };
});
