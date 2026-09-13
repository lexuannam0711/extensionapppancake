(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.PDBWebviewTabNavigation = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function normalizeWebviewUrl(value) {
    return String(value || '').trim().toLowerCase();
  }

  function isBlankWebviewUrl(value) {
    const normalized = normalizeWebviewUrl(value);
    return normalized === '' || normalized === 'about:blank';
  }

  function isTabLoading(tab) {
    if (tab?.loadState === 'loading') return true;
    if (tab?.pendingNavigationToken) return true;
    try {
      return Boolean(tab?.webview?.isLoading?.());
    } catch (_) {
      return false;
    }
  }

  function shouldLazyLoadWebview(tab, currentUrl) {
    if (!tab?.webview) return false;
    if (isTabLoading(tab)) return false;
    return isBlankWebviewUrl(currentUrl);
  }

  return {
    isBlankWebviewUrl,
    shouldLazyLoadWebview
  };
});
