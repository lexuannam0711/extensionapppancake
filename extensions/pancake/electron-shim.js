// ---------------------------------------------------------------------------
// Electron compatibility shim for the Pancake MV3 extension.
// Electron's extension runtime does not implement some Chrome APIs
// (declarativeContent, parts of contextMenus, etc.). The extension's
// background service worker calls them at startup (e.g.
// chrome.declarativeContent.onPageChanged), which throws and aborts the
// service worker registration. We polyfill the missing pieces with harmless
// no-op stubs so the worker can register and the rest of the extension runs.
// ---------------------------------------------------------------------------
(function () {
  try {
    const g = (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined' ? globalThis : this);
    if (!g.chrome) g.chrome = {};
    const chrome = g.chrome;

    // Generic no-op event object matching chrome.events.Event shape.
    function makeEvent() {
      return {
        addListener() {},
        removeListener() {},
        hasListener() { return false; },
        addRules() {},
        removeRules() {},
        getRules() {}
      };
    }

    // declarativeContent: the API that crashes background.js on startup.
    if (!chrome.declarativeContent) {
      chrome.declarativeContent = {
        onPageChanged: makeEvent(),
        PageStateMatcher: function PageStateMatcher() {},
        ShowAction: function ShowAction() {},
        ShowPageAction: function ShowPageAction() {},
        SetIcon: function SetIcon() {},
        RequestContentScript: function RequestContentScript() {}
      };
    } else if (!chrome.declarativeContent.onPageChanged) {
      chrome.declarativeContent.onPageChanged = makeEvent();
    }

    // contextMenus may be partially missing in Electron.
    if (!chrome.contextMenus) {
      chrome.contextMenus = {
        create() {},
        update() {},
        remove() {},
        removeAll() {},
        onClicked: makeEvent()
      };
    }

    // Guard a couple of other commonly-touched optional namespaces.
    if (!chrome.action) chrome.action = { onClicked: makeEvent(), setBadgeText() {}, setIcon() {}, setTitle() {} };
    if (chrome.runtime && !chrome.runtime.onInstalled) chrome.runtime.onInstalled = makeEvent();
  } catch (_) {
    // Never let the shim itself break the worker.
  }
})();
