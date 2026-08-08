'use strict';

// Locks the Electron runtime facts that the guest-console correlation in
// src/renderer/app.js depends on. If Electron changes any of these, the
// correlation silently stops attaching hints rather than failing loudly, so
// these assertions are the only thing standing between us and dead code.
//
// Measured on Electron 34.5.8 (Windows) via test/e2e/guest-console-probe.spec.js.

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFixtureServer } = require('./fixture/fixture-server');

const projectRoot = path.resolve(__dirname, '../..');
const electronMain = path.join(__dirname, 'fixture/electron-main.js');
const electronExecutable = require('electron');

// Must stay in sync with GUEST_CONSOLE_CORRELATION_MS in src/renderer/app.js.
const GUEST_CONSOLE_CORRELATION_MS = 5000;

let fixture;

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function removeVerifiedTempDirectory(directory) {
  const resolved = path.resolve(directory);
  const expectedPrefix = path.resolve(os.tmpdir(), 'pdb-electron-e2e-');
  if (!resolved.startsWith(expectedPrefix)) throw new Error('Refusing to delete an unverified E2E directory');
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

// Mirrors the console-message listener and getGuestConsoleHint() in app.js so a
// divergence in the real listener's logic shows up as a failure here.
function installRecorder(correlationMs) {
  const webview = document.querySelector('webview[data-tab="bot1"]');
  window.__recorder = { seen: [], recorded: null };
  webview.addEventListener('console-message', (event) => {
    window.__recorder.seen.push({ levelType: typeof event.level, level: event.level });
    if (Number(event.level) < 2) return;
    window.__recorder.recorded = {
      text: String(event.message || '').slice(0, 300),
      source: `${String(event.sourceId || '').split('/').pop()}:${event.line || 0}`,
      at: Date.now()
    };
  });
  window.__recorder.reset = () => {
    window.__recorder.seen = [];
    window.__recorder.recorded = null;
  };
  window.__recorder.hint = () => {
    const recorded = window.__recorder.recorded;
    if (!recorded) return '';
    if (Date.now() - recorded.at > correlationMs) return '';
    return `${recorded.text}${recorded.source ? ` @ ${recorded.source}` : ''}`;
  };
}

async function launchHost(userDataDir) {
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [electronMain],
    env: {
      ...process.env,
      PDB_E2E_ORIGIN: fixture.origin,
      PDB_E2E_USER_DATA_DIR: userDataDir,
      PDB_E2E_HOST_PATH: '/host'
    }
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.e2e, null, { timeout: 5_000 });
  await withTimeout(page.evaluate(() => window.e2e.ready(['bot1'])), 8_000, 'host readiness');
  await page.evaluate(installRecorder, GUEST_CONSOLE_CORRELATION_MS);
  return { app, page };
}

test.beforeAll(async () => {
  fixture = createFixtureServer(projectRoot);
  fixture.origin = await fixture.listen();
});

test.afterAll(async () => {
  await fixture.close();
});

test.describe('guest console correlation runtime contract', () => {
  let app;
  let page;
  let userDataDir;

  test.beforeAll(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdb-electron-e2e-'));
    ({ app, page } = await launchHost(userDataDir));
  });

  test.afterAll(async () => {
    await withTimeout(app.close(), 3_000, 'Electron close').catch(() => app.process().kill());
    await removeVerifiedTempDirectory(userDataDir);
  });

  test('event.level is numeric, so the Number(level) < 2 filter is meaningful', async () => {
    const result = await page.evaluate(async () => {
      const webview = document.querySelector('webview[data-tab="bot1"]');
      window.__recorder.reset();
      await webview.executeJavaScript("console.error('LEVEL_SHAPE')", true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return window.__recorder.seen;
    });
    expect(result.length).toBeGreaterThan(0);
    // A string level would make Number(level) NaN, and NaN < 2 is false, which
    // would record every message instead of only errors.
    for (const event of result) expect(event.levelType).toBe('number');
    expect(result.some((event) => event.level === 3)).toBe(true);
  });

  test('console.log stays below the threshold and records nothing', async () => {
    const result = await page.evaluate(async () => {
      const webview = document.querySelector('webview[data-tab="bot1"]');
      window.__recorder.reset();
      await webview.executeJavaScript("console.log('CHATTER')", true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { seen: window.__recorder.seen, hint: window.__recorder.hint() };
    });
    expect(result.seen.some((event) => event.level === 1)).toBe(true);
    expect(result.hint).toBe('');
  });

  test('console.warn sits exactly on the threshold and is recorded', async () => {
    const result = await page.evaluate(async () => {
      const webview = document.querySelector('webview[data-tab="bot1"]');
      window.__recorder.reset();
      await webview.executeJavaScript("console.warn('WARNING_TEXT')", true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { seen: window.__recorder.seen, hint: window.__recorder.hint() };
    });
    expect(result.seen.some((event) => event.level === 2)).toBe(true);
    expect(result.hint).toContain('WARNING_TEXT');
  });

  test('a throw inside executeJavaScript surfaces as a guest console error', async () => {
    // This is the whole premise of the feature: Electron hands the renderer only
    // "Script failed to execute", and the real message stays guest-side. If this
    // stops holding, the correlation has nothing to attach and is dead code.
    const result = await page.evaluate(async () => {
      const webview = document.querySelector('webview[data-tab="bot1"]');
      window.__recorder.reset();
      let rejected = null;
      try {
        // userGesture=false matches executeInTab in app.js.
        await webview.executeJavaScript("(() => { throw new Error('GUEST_SIDE_CAUSE') })()", false);
      } catch (error) {
        rejected = String((error && error.message) || error);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      return { rejected, hint: window.__recorder.hint() };
    });
    expect(result.rejected).toContain('GUEST_VIEW_MANAGER_CALL');
    expect(result.rejected).toContain('Script failed to execute');
    // The renderer-side error never names the cause...
    expect(result.rejected).not.toContain('GUEST_SIDE_CAUSE');
    // ...but the guest console does, which is what the hint recovers.
    expect(result.hint).toContain('GUEST_SIDE_CAUSE');
  });

  test('a throw from an injected window.__PDB__-style function is captured', async () => {
    const result = await page.evaluate(async () => {
      const webview = document.querySelector('webview[data-tab="bot1"]');
      window.__recorder.reset();
      // Two-stage shape: automation injected once, then called per operation.
      await webview.executeJavaScript(
        'window.__fake = { getUnreadConversations: () => { throw new Error("DOM_SELECTOR_MISSING") } }; true',
        true
      );
      try {
        await webview.executeJavaScript('window.__fake.getUnreadConversations()', false);
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 500));
      return window.__recorder.hint();
    });
    expect(result).toContain('DOM_SELECTOR_MISSING');
  });

  test('a guest error older than the correlation window is not attached', async () => {
    const result = await page.evaluate(async (correlationMs) => {
      const webview = document.querySelector('webview[data-tab="bot1"]');
      window.__recorder.reset();
      await webview.executeJavaScript("console.error('STALE_NOISE')", true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const fresh = window.__recorder.hint();
      // Age the record past the window instead of sleeping through it.
      window.__recorder.recorded.at -= correlationMs + 1000;
      return { fresh, aged: window.__recorder.hint() };
    }, GUEST_CONSOLE_CORRELATION_MS);
    expect(result.fresh).toContain('STALE_NOISE');
    expect(result.aged).toBe('');
  });

  test('sourceId is empty for injected code, so the hint carries no usable location', async () => {
    // Documents a real limitation: app.js injects automation as a concatenated
    // string (see injectAutomation), and V8 gives anonymous eval'd scripts no
    // source name. Every hint therefore renders ":1" as its location. Appending
    // a `//# sourceURL=` pragma to the injected source fixes this; until that
    // lands, this test pins the current behaviour so the change is visible.
    const result = await page.evaluate(async () => {
      const webview = document.querySelector('webview[data-tab="bot1"]');
      window.__recorder.reset();
      try {
        await webview.executeJavaScript("(() => { throw new Error('NO_SOURCE_ID') })()", false);
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 500));
      return window.__recorder.recorded;
    });
    expect(result.text).toContain('NO_SOURCE_ID');
    expect(result.source).toBe(':1');
  });

  test('a //# sourceURL pragma restores file and line in the hint', async () => {
    // Proves the fix works before we commit to it: the same injected-then-called
    // shape, but with the pragma, reports the line within the injected source.
    const result = await page.evaluate(async () => {
      const webview = document.querySelector('webview[data-tab="bot1"]');
      window.__recorder.reset();
      const source = [
        '// line 1',
        '// line 2',
        'window.__pragmaFake = () => {',
        '  throw new Error("PRAGMA_LOCATED")',
        '};',
        'true',
        '//# sourceURL=pdb-automation.js'
      ].join('\n');
      await webview.executeJavaScript(source, true);
      try {
        await webview.executeJavaScript('window.__pragmaFake()', false);
      } catch (_) {}
      await new Promise((resolve) => setTimeout(resolve, 500));
      return window.__recorder.recorded;
    });
    expect(result.text).toContain('PRAGMA_LOCATED');
    expect(result.source).toBe('pdb-automation.js:4');
  });
});
