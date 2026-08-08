'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function html(body, script = '') {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}<script>${script}</script></body></html>`;
}

function hostScript() {
  return String.raw`
    const tabs = new Map();
    const readyWaiters = new Map();

    function getTab(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('Unknown test tab');
      return tab;
    }

    function resolveReady(tabId) {
      const waiters = readyWaiters.get(tabId) || [];
      readyWaiters.delete(tabId);
      for (const resolve of waiters) resolve();
    }

    for (const webview of document.querySelectorAll('webview')) {
      const tabId = webview.dataset.tab;
      const tab = {
        id: tabId,
        label: tabId,
        webview,
        loaded: false,
        loadState: 'idle',
        expectedNavigationUrl: '',
        loadGeneration: 1,
        injectionGeneration: 0
      };
      tabs.set(tabId, tab);
      webview.addEventListener('did-start-loading', () => {
        tab.loaded = false;
        tab.loadState = 'loading';
      });
      webview.addEventListener('did-finish-load', () => {
        tab.loaded = true;
        tab.loadState = 'loaded';
        resolveReady(tabId);
      });
    }

    async function waitLoaded(tabId) {
      const tab = getTab(tabId);
      if (tab.loaded) return;
      await new Promise((resolve) => {
        const waiters = readyWaiters.get(tabId) || [];
        readyWaiters.set(tabId, [...waiters, resolve]);
      });
    }

    async function inject(tabId, generation = getTab(tabId).loadGeneration) {
      const tab = getTab(tabId);
      const source = '(() => {'
        + 'window.__PDB__={'
        + 'generation:' + JSON.stringify(generation) + ','
        + 'getUnreadConversations:()=>window.PDBPancakeDom.collectUnreadConversations(document),'
        + 'getGeneration:()=>({generation:' + JSON.stringify(generation) + ',href:location.href})'
        + '};return window.__PDB__.generation})()';
      const result = await tab.webview.executeJavaScript(source, true);
      if (tab.loadGeneration !== generation) return { ok: false, code: 'STALE_GENERATION' };
      tab.injectionGeneration = result;
      return { ok: true, generation: result };
    }

    function targetWithGeneration(target, generation) {
      return target + (target.includes('?') ? '&' : '?') + 'generation=' + generation;
    }

    function safeWebviewUrl(webview) {
      try {
        const url = webview.getURL();
        if (url) return url;
      } catch (_) {}
      return webview.src || '';
    }

    async function read(tabId, options = {}) {
      const tab = getTab(tabId);
      const method = options.method || 'getUnreadConversations';
      return window.PDBWebviewAutomation.executeWithRetry(async () => {
        if (options.block) {
          return tab.webview.executeJavaScript('window.__e2eReadBarrier', true);
        }
        const source = '(() => {'
          + 'if(!window.__PDB__)throw new Error("AUTOMATION_NOT_INJECTED");'
          + 'return window.__PDB__[' + JSON.stringify(method) + ']()})()';
        return tab.webview.executeJavaScript(source, true);
      }, {
        tabId,
        method,
        timeoutMs: options.timeoutMs || 800,
        baseDelayMs: 20,
        onBeforeRetry: async () => inject(tabId)
      });
    }

    async function navigate(tabId, target) {
      const tab = getTab(tabId);
      const generation = tab.loadGeneration + 1;
      tab.loadGeneration = generation;
      tab.loaded = false;
      tab.loadState = 'loading';
      tab.expectedNavigationUrl = targetWithGeneration(target, generation);
      tab.webview.loadURL(tab.expectedNavigationUrl);
      try {
        await window.PDBWebviewAutomation.waitForWebviewReady(tab, {
          generation,
          timeoutMs: 5000,
          label: 'e2e navigation'
        });
        if (tab.loadGeneration !== generation) return { ok: false, code: 'STALE_GENERATION', generation };
        const injected = await inject(tabId, generation);
        if (!injected.ok) return injected;
        const state = await read(tabId, { method: 'getGeneration' });
        return { ok: state.generation === generation, generation, href: state.href };
      } catch (error) {
        if (tab.loadGeneration !== generation) {
          return { ok: false, code: 'STALE_GENERATION', generation };
        }
        return { ok: false, code: 'NAVIGATION_FAILED', generation, message: String(error && error.message || error) };
      }
    }

    function activateLazy(tabId, target) {
      const tab = getTab(tabId);
      for (const [id, item] of tabs) tab.webview.classList.toggle('active', id === tabId);
      const currentUrl = safeWebviewUrl(tab.webview);
      const shouldLoad = window.PDBWebviewTabNavigation.shouldLazyLoadWebview(tab, currentUrl);
      if (shouldLoad) {
        const generation = tab.loadGeneration + 1;
        tab.loadGeneration = generation;
        tab.loaded = false;
        tab.loadState = 'loading';
        tab.expectedNavigationUrl = targetWithGeneration(target, generation);
        tab.webview.src = tab.expectedNavigationUrl;
      }
      return { triggered: shouldLoad, currentUrl, expectedNavigationUrl: tab.expectedNavigationUrl };
    }

    window.e2e = {
      async ready(tabIds = ['bot1', 'bot2']) {
        await Promise.all(tabIds.map(waitLoaded));
        await Promise.all(tabIds.map((id) => inject(id)));
        return true;
      },
      waitLoaded,
      setActive(tabId) {
        for (const [id, tab] of tabs) tab.webview.classList.toggle('active', id === tabId);
      },
      async addUnread(tabId, id) {
        return getTab(tabId).webview.executeJavaScript('window.addUnread(' + JSON.stringify(id) + ')', true);
      },
      read,
      releaseReadBarrier(tabId) {
        return getTab(tabId).webview.executeJavaScript('window.__releaseE2eReadBarrier()', true);
      },
      activateLazy,
      navigate,
      diagnostics() {
        return Array.from(tabs.values(), ({ id, loaded, loadState, expectedNavigationUrl, loadGeneration, injectionGeneration, webview }) => {
          const href = safeWebviewUrl(webview);
          let pathname = href;
          try { pathname = new URL(href).pathname; } catch (_) {}
          return { id, loaded, loadState, expectedNavigationUrl, loadGeneration, injectionGeneration, href, pathname };
        });
      }
    };
  `;
}

function guestScript() {
  return String.raw`
    window.__e2eReadBarrier = new Promise((resolve) => { window.__releaseE2eReadBarrier = resolve; });
    window.addUnread = (id) => {
      const row = document.createElement('div');
      row.className = 'conversation-list-item unread';
      row.id = id;
      row.innerHTML = '<span class="name-text">Customer</span><span class="snippet-text">Message</span>';
      document.querySelector('#conversations').appendChild(row);
      return id;
    };
  `;
}

function createFixtureServer(projectRoot) {
  const gates = new Map();
  const sources = {
    '/webviewAutomation.js': fs.readFileSync(path.join(projectRoot, 'src/renderer/webviewAutomation.js'), 'utf8'),
    '/webviewTabNavigation.js': fs.readFileSync(path.join(projectRoot, 'src/renderer/webviewTabNavigation.js'), 'utf8'),
    '/pancakeDom.js': fs.readFileSync(path.join(projectRoot, 'src/renderer/pancakeDom.js'), 'utf8')
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (sources[url.pathname]) {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end(sources[url.pathname]);
      return;
    }
    if (url.pathname === '/host') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html(`
        <style>
          #stack { display:grid; width:900px; height:560px; }
          webview { grid-area:1/1; width:100%; height:100%; opacity:0; z-index:0; pointer-events:none; }
          webview.active { opacity:1; z-index:1; pointer-events:auto; }
        </style>
        <div id="stack">
          <webview class="active" data-tab="bot1" partition="persist:pancake-e2e" src="/guest?tab=bot1&generation=1"></webview>
          <webview data-tab="bot2" partition="persist:pancake-e2e" src="/guest?tab=bot2&generation=1"></webview>
        </div>
        <script src="/webviewAutomation.js"></script>
      `, hostScript()));
      return;
    }
    if (url.pathname === '/lazy-host') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html(`
        <style>
          #stack { display:grid; width:900px; height:560px; }
          webview { grid-area:1/1; width:100%; height:100%; opacity:0; z-index:0; pointer-events:none; }
          webview.active { opacity:1; z-index:1; pointer-events:auto; }
        </style>
        <div id="stack">
          <webview class="active" data-tab="bot1" partition="persist:pancake-e2e" src="/guest?tab=bot1&generation=1"></webview>
          <webview data-tab="manual" partition="persist:pancake-e2e" src="about:blank"></webview>
        </div>
        <script src="/webviewTabNavigation.js"></script>
        <script src="/webviewAutomation.js"></script>
      `, hostScript()));
      return;
    }
    if (url.pathname === '/guest') {
      const gate = url.searchParams.get('gate');
      if (gate) {
        gates.set(gate, { response, requestedAt: Date.now() });
        server.emit('fixture-gate', gate);
        request.on('close', () => gates.delete(gate));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html(`
        <style>.conversation-list-item { width:220px; height:36px; }</style>
        <div id="conversations"></div>
        <script src="/pancakeDom.js"></script>
      `, guestScript()));
      return;
    }
    response.writeHead(404).end();
  });

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      return `http://127.0.0.1:${address.port}`;
    },
    waitForGate(name) {
      if (gates.has(name)) return Promise.resolve();
      return new Promise((resolve) => {
        const listener = (gate) => {
          if (gate !== name) return;
          server.off('fixture-gate', listener);
          resolve();
        };
        server.on('fixture-gate', listener);
      });
    },
    releaseGate(name) {
      const gate = gates.get(name);
      if (!gate) return false;
      gates.delete(name);
      gate.response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      gate.response.end(html('<div id="conversations"></div><script src="/pancakeDom.js"></script>', guestScript()));
      return true;
    },
    async close() {
      for (const name of Array.from(gates.keys())) this.releaseGate(name);
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createFixtureServer };
