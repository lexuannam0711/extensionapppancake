'use strict';

const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFixtureServer } = require('./fixture/fixture-server');

const projectRoot = path.resolve(__dirname, '../..');
const electronMain = path.join(__dirname, 'fixture/electron-main.js');
const electronExecutable = require('electron');

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

test.beforeAll(async () => {
  fixture = createFixtureServer(projectRoot);
  fixture.origin = await fixture.listen();
});

test.afterAll(async () => {
  await fixture.close();
});

test('blank inactive webview lazy-loads when activated', async ({}, testInfo) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdb-electron-e2e-'));
  const output = [];
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [electronMain],
    env: {
      ...process.env,
      PDB_E2E_ORIGIN: fixture.origin,
      PDB_E2E_USER_DATA_DIR: userDataDir,
      PDB_E2E_HOST_PATH: '/lazy-host'
    }
  });

  try {
    app.process().stdout?.on('data', (chunk) => output.push({ stream: 'stdout', text: String(chunk) }));
    app.process().stderr?.on('data', (chunk) => output.push({ stream: 'stderr', text: String(chunk) }));
    const page = await app.firstWindow();
    page.on('console', (message) => output.push({ stream: 'renderer-console', text: message.text() }));
    page.on('pageerror', (error) => output.push({ stream: 'renderer-error', text: String(error.message || error) }));

    try {
      await page.waitForFunction(() => window.e2e, null, { timeout: 5_000 });
      await withTimeout(page.evaluate(() => window.e2e.ready(['bot1'])), 8_000, 'lazy host readiness');
    } catch (error) {
      throw new Error(`Lazy host unavailable: ${JSON.stringify(output.slice(-20))}`, { cause: error });
    }

    const before = await page.evaluate(() => window.e2e.diagnostics().find((tab) => tab.id === 'manual'));
    expect(['', 'about:blank']).toContain(before.href);

    const activation = await page.evaluate(
      (origin) => window.e2e.activateLazy('manual', `${origin}/guest?tab=manual`),
      fixture.origin
    );
    expect(activation.triggered).toBe(true);

    await withTimeout(page.evaluate(() => window.e2e.waitLoaded('manual')), 5_000, 'manual lazy-load');
    const after = await page.evaluate(() => window.e2e.diagnostics().find((tab) => tab.id === 'manual'));
    expect(after.loaded).toBe(true);
    expect(after.pathname).toBe('/guest');
    expect(new URL(after.href).searchParams.get('tab')).toBe('manual');
  } finally {
    await withTimeout(app.close(), 3_000, 'Electron close').catch(() => {
      app.process().kill();
    });
    await removeVerifiedTempDirectory(userDataDir);
  }
});
