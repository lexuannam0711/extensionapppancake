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

test.beforeEach(async ({}, testInfo) => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdb-electron-e2e-'));
  const output = [];
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [electronMain],
    env: {
      ...process.env,
      PDB_E2E_ORIGIN: fixture.origin,
      PDB_E2E_USER_DATA_DIR: userDataDir
    }
  });
  app.process().stdout?.on('data', (chunk) => output.push({ stream: 'stdout', text: String(chunk) }));
  app.process().stderr?.on('data', (chunk) => output.push({ stream: 'stderr', text: String(chunk) }));
  const page = await app.firstWindow();
  page.on('console', (message) => output.push({ stream: 'renderer-console', text: message.text() }));
  page.on('pageerror', (error) => output.push({ stream: 'renderer-error', text: String(error.message || error) }));
  testInfo.pdb = { app, page, userDataDir, output, tracing: false, stage: 'wait-for-host-api' };
  try {
    await page.waitForFunction(() => window.e2e, null, { timeout: 5_000 });
  } catch (error) {
    throw new Error(`Host API unavailable: ${JSON.stringify(output.slice(-20))}`, { cause: error });
  }
  testInfo.pdb.stage = 'wait-for-guests';
  await withTimeout(page.evaluate(() => window.e2e.ready()), 8_000, 'guest readiness');
  testInfo.pdb.stage = 'start-tracing';
  await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  testInfo.pdb.tracing = true;
  testInfo.pdb.stage = 'ready';
});

test.afterEach(async ({}, testInfo) => {
  const state = testInfo.pdb;
  if (!state) return;
  try {
    if (testInfo.status !== testInfo.expectedStatus) {
      const screenshot = await state.page.screenshot({ fullPage: true }).catch(() => null);
      if (screenshot) {
        await testInfo.attach('electron-screenshot', { body: screenshot, contentType: 'image/png' });
      }
      const diagnostics = await state.page.evaluate(() => window.e2e.diagnostics()).catch(() => []);
      await testInfo.attach('diagnostics', {
        body: Buffer.from(JSON.stringify({ stage: state.stage, tabs: diagnostics, process: state.output.slice(-100) }, null, 2)),
        contentType: 'application/json'
      });
      if (state.tracing) {
        await state.page.context().tracing.stop({ path: testInfo.outputPath('trace.zip') });
        await testInfo.attach('trace', { path: testInfo.outputPath('trace.zip'), contentType: 'application/zip' });
      }
    } else if (state.tracing) {
      await state.page.context().tracing.stop();
    }
  } finally {
    await withTimeout(state.app.close(), 3_000, 'Electron close').catch(() => {
      state.app.process().kill();
    });
    await removeVerifiedTempDirectory(state.userDataDir);
  }
});

test('inactive tab receives unread and switching retains it', async ({}, testInfo) => {
  const { page } = testInfo.pdb;
  await page.evaluate(() => window.e2e.addUnread('bot2', 'conversation-2'));
  const whileInactive = await page.evaluate(() => window.e2e.read('bot2'));
  expect(whileInactive.rawCount).toBe(1);
  expect(whileInactive.items).toHaveLength(1);

  await page.evaluate(() => window.e2e.setActive('bot2'));
  const afterSwitch = await page.evaluate(() => window.e2e.read('bot2'));
  expect(afterSwitch.items.map((item) => item.id)).toEqual(['conversation-2']);
});

test('blocked bot1 does not delay bot2 by more than 250ms', async ({}, testInfo) => {
  const { page } = testInfo.pdb;
  await page.evaluate(() => window.e2e.addUnread('bot2', 'conversation-fast'));
  const blockedBot1 = page.evaluate(() => window.e2e.read('bot1', { block: true, timeoutMs: 500 })).catch(() => null);
  const startedAt = Date.now();
  const bot2 = await page.evaluate(() => window.e2e.read('bot2'));
  const elapsedMs = Date.now() - startedAt;

  expect(bot2.items.map((item) => item.id)).toEqual(['conversation-fast']);
  expect(elapsedMs).toBeLessThan(250);
  await page.evaluate(() => window.e2e.releaseReadBarrier('bot1'));
  await blockedBot1;
});

test('reload waits for current generation, reinjects and recovers', async ({}, testInfo) => {
  const { page } = testInfo.pdb;
  const slowNavigation = page.evaluate(
    (origin) => window.e2e.navigate('bot1', `${origin}/guest?tab=bot1&gate=old`),
    fixture.origin
  );
  await fixture.waitForGate('old');

  const current = await page.evaluate(
    (origin) => window.e2e.navigate('bot1', `${origin}/guest?tab=bot1`),
    fixture.origin
  );
  fixture.releaseGate('old');
  const old = await slowNavigation;

  expect(current).toMatchObject({ ok: true, generation: 3 });
  expect(new URL(current.href).searchParams.get('generation')).toBe('3');
  expect(old).toMatchObject({ ok: false, code: 'STALE_GENERATION', generation: 2 });
  const recovered = await page.evaluate(() => window.e2e.read('bot1'));
  expect(recovered).toMatchObject({ rawCount: 0, malformedCount: 0 });
});
