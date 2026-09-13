const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isDevToolsEnabled,
  withDevToolsPreference
} = require('../src/devtoolsPolicy');

test('DevTools are enabled by default so operators can inspect the app and guests', () => {
  assert.equal(isDevToolsEnabled({ env: {}, argv: ['electron', '.'] }), true);
});

test('DevTools can be enabled with a truthy environment flag', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.equal(isDevToolsEnabled({ env: { PDB_ENABLE_DEVTOOLS: value }, argv: [] }), true, value);
  }
});

test('DevTools can be enabled with the --devtools argument', () => {
  assert.equal(isDevToolsEnabled({ env: {}, argv: ['electron', '.', '--devtools'] }), true);
});

test('webPreferences are copied before applying the DevTools preference', () => {
  const original = { contextIsolation: true, nodeIntegration: false };
  const updated = withDevToolsPreference(original, true);

  assert.notEqual(updated, original);
  assert.deepEqual(original, { contextIsolation: true, nodeIntegration: false });
  assert.deepEqual(updated, { contextIsolation: true, nodeIntegration: false, devTools: true });
});
