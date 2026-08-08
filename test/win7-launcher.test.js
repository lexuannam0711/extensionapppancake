const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const launcher = fs.readFileSync(path.join(root, 'start-win7.bat'), 'utf8');
const buildScript = fs.readFileSync(path.join(root, 'scripts', 'build-win7.ps1'), 'utf8');

test('Win7 launcher passes an app path without a trailing quote', () => {
  assert.match(launcher, /electron\.exe" "%~dp0\."/i);
  assert.doesNotMatch(launcher, /electron\.exe" "%~dp0"/i);
});

test('Win7 build script validates the launcher before creating the archive', () => {
  assert.match(buildScript, /start-win7\.bat/);
  assert.match(buildScript, /%~dp0\\\./);
  assert.match(buildScript, /Electron 22 runtime was not installed/);
  assert.match(buildScript, /set-release-version\.js/);
});
