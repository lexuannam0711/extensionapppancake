const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

test('all Pancake tabs share the persistent session partition', () => {
  assert.equal((indexHtml.match(/partition="persist:pancake"/g) || []).length, 3);
  assert.doesNotMatch(indexHtml, /partition="guest|partition="temp/i);
  assert.match(mainSource, /params\.partition !== 'persist:pancake'/);
});

test('login navigation is available to manual Tab 3', () => {
  assert.match(appSource, /function openLoginInTab\(tab/);
  assert.match(appSource, /openLoginInTab\(getTab\(activeWvTab\), \{ force: true \}\)/);
  assert.doesNotMatch(appSource, /function openLoginInTab\(tab[^]*if \(!tab\?\.botCapable\) return false/);
});

test('startup uses Pancake multi-pages for every tab and does not auto-open account', () => {
  assert.match(appSource, /DEFAULT_PANCAKE_URL/);
  assert.match(appSource, /Object\.values\(webviewTabs\)\.forEach\(\(tab\) => navigateWebview\(tab, pancakeUrl\)\)/);
  assert.match(appSource, /function showAuthRequiredState\(tab, error, \{ openLogin = false \} = \{\}/);
  assert.match(appSource, /if \(openLogin\) openLoginInTab\(tab\)/);
  assert.doesNotMatch(appSource, /function showAuthRequiredState\(tab, error\) \{[^]*\n  openLoginInTab\(tab\);/);
});
