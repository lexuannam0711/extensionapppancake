(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.PDBPancakeAutomationGate = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const ERROR_CODES = Object.freeze({
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    WRONG_PAGE: 'WRONG_PANCAKE_PAGE',
    UNTRUSTED: 'UNTRUSTED_AUTOMATION_ORIGIN'
  });
  const BLOCKED_RESULT_KEY = '__PDB_AUTOMATION_BLOCKED__';

  function sanitizeUrl(value) {
    try {
      const parsed = new URL(String(value || ''));
      return `${parsed.origin}${parsed.pathname}`;
    } catch (_) {
      return '';
    }
  }

  function createAutomationError(code, tabLabel, url) {
    const label = String(tabLabel || 'Bot');
    const safeUrl = sanitizeUrl(url);
    let message;

    if (code === ERROR_CODES.AUTH_REQUIRED) {
      message = `${label}: cần đăng nhập Pancake. Hãy đăng nhập trong tab này, sau đó bấm Reload rồi chạy lại bot.`;
    } else if (code === ERROR_CODES.WRONG_PAGE) {
      message = `${label}: đang ở sai trang Pancake${safeUrl ? `, url=${safeUrl}` : ''}`;
    } else {
      message = `${label}: blocked untrusted automation origin${safeUrl ? `, url=${safeUrl}` : ''}`;
    }

    const error = new Error(message);
    error.code = code;
    return error;
  }

  function classifySafely(classifyUrl, url) {
    if (typeof classifyUrl !== 'function') return 'untrusted';
    try {
      const result = classifyUrl(url);
      return result === 'app' || result === 'auth' ? result : 'untrusted';
    } catch (_) {
      return 'untrusted';
    }
  }

  function errorForPageState(pageState, tabLabel, url) {
    if (pageState?.kind === 'auth') {
      return createAutomationError(ERROR_CODES.AUTH_REQUIRED, tabLabel, url);
    }
    if (pageState?.kind === 'untrusted') {
      return createAutomationError(ERROR_CODES.UNTRUSTED, tabLabel, url);
    }
    return createAutomationError(ERROR_CODES.WRONG_PAGE, tabLabel, url);
  }

  function readCurrentUrl(options) {
    return typeof options.getUrl === 'function' ? options.getUrl() : options.url;
  }

  function assertAppUrl(options, url) {
    const urlKind = classifySafely(options.classifyUrl, url);
    if (urlKind === 'auth') {
      throw createAutomationError(ERROR_CODES.AUTH_REQUIRED, options.tabLabel, url);
    }
    if (urlKind !== 'app') {
      throw createAutomationError(ERROR_CODES.UNTRUSTED, options.tabLabel, url);
    }
  }

  async function prepareAutomation(options = {}) {
    const initialUrl = readCurrentUrl(options);
    if (initialUrl && String(initialUrl).trim() && initialUrl !== 'about:blank') {
      assertAppUrl(options, initialUrl);
    }
    if (typeof options.waitUntilReady === 'function') {
      await options.waitUntilReady();
    }
    const url = readCurrentUrl(options);
    assertAppUrl(options, url);
    if (typeof options.probePage !== 'function') {
      throw new TypeError('Pancake page probe is required');
    }

    const probeUrl = readCurrentUrl(options);
    assertAppUrl(options, probeUrl);
    const pageState = await options.probePage(Object.freeze({ url: probeUrl }));
    if (pageState?.kind !== 'chat' || pageState?.isChatPage !== true) {
      throw errorForPageState(pageState, options.tabLabel, probeUrl);
    }
    if (typeof options.injectAutomation !== 'function') {
      throw new TypeError('Pancake automation injector is required');
    }
    const injectionUrl = readCurrentUrl(options);
    assertAppUrl(options, injectionUrl);
    const result = await options.injectAutomation(pageState, Object.freeze({ url: injectionUrl }));
    const blockedPageState = result?.[BLOCKED_RESULT_KEY];
    if (blockedPageState) {
      throw errorForPageState(blockedPageState, options.tabLabel, readCurrentUrl(options));
    }
    return result;
  }

  function isAuthRequiredError(error) {
    return error?.code === ERROR_CODES.AUTH_REQUIRED;
  }

  return Object.freeze({
    ERROR_CODES,
    BLOCKED_RESULT_KEY,
    prepareAutomation,
    isAuthRequiredError,
    sanitizeUrl
  });
});
