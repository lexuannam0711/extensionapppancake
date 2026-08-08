(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.PDBPancakeUrlPolicy = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const PANCAKE_MULTI_PAGES_URL = 'https://pancake.vn/multi_pages';
  const PANCAKE_CHAT_URL = PANCAKE_MULTI_PAGES_URL;
  const PANCAKE_LOGIN_URL = 'https://account.pancake.vn/login';
  const DEFAULT_PANCAKE_URL = PANCAKE_MULTI_PAGES_URL;
  const APP_HOSTS = Object.freeze([
    'pancake.vn',
    'www.pancake.vn',
    'pages.fm',
    'www.pages.fm'
  ]);
  const AUTH_HOSTS = Object.freeze([
    'account.pancake.vn',
    'facebook.com',
    'www.facebook.com'
  ]);

  function parseHttpsUrl(value) {
    try {
      const parsed = new URL(String(value || '').trim());
      return parsed.protocol === 'https:' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function classifyPancakeUrl(value) {
    const parsed = parseHttpsUrl(value);
    if (!parsed || parsed.port || parsed.username || parsed.password) return 'untrusted';
    const host = parsed.hostname.toLowerCase();
    if (APP_HOSTS.includes(host)) return 'app';
    if (AUTH_HOSTS.includes(host)) return 'auth';
    return 'untrusted';
  }

  function isAllowedAutomationUrl(value) {
    return classifyPancakeUrl(value) === 'app';
  }

  function normalizeBotUrl(value) {
    const parsed = parseHttpsUrl(value);
    if (!parsed || classifyPancakeUrl(parsed.href) !== 'app') return '';
    return parsed.href;
  }

  function resolveChatEntryUrl(value) {
    const parsed = parseHttpsUrl(value);
    if (!parsed || classifyPancakeUrl(parsed.href) !== 'app') return '';
    return PANCAKE_MULTI_PAGES_URL;
  }

  function resolvePreferredPancakeUrl() {
    return DEFAULT_PANCAKE_URL;
  }

  return {
    PANCAKE_MULTI_PAGES_URL,
    PANCAKE_CHAT_URL,
    PANCAKE_LOGIN_URL,
    DEFAULT_PANCAKE_URL,
    classifyPancakeUrl,
    isAllowedAutomationUrl,
    normalizeBotUrl,
    resolveChatEntryUrl,
    resolvePreferredPancakeUrl
  };
});
