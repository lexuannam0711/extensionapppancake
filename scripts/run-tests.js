const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testDir = path.resolve(__dirname, '..', 'test');
const testFiles = fs.readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => path.join('test', f));

// Use test-concurrency=1 to prevent port collisions between Express server tests on Windows runners
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], {
  stdio: 'inherit',
  shell: false
});

process.exit(result.status ?? 1);
