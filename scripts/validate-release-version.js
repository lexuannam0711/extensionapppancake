const fs = require('fs');
const path = require('path');
const { parseVersion } = require('../src/update/manifest');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function normalizeTag(tag) {
  const value = String(tag || '').trim();
  if (!/^v\d+\.\d+\.\d+$/.test(value)) throw new Error(`Release tag must match v<major>.<minor>.<patch>: ${value}`);
  const version = value.slice(1);
  parseVersion(version);
  return version;
}

function readVersion(filePath) {
  const packageJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const version = String(packageJson.version || '').trim();
  parseVersion(version);
  return version;
}

function validateReleaseVersion({ tag = process.env.GITHUB_REF_NAME || '', root = path.resolve(__dirname, '..') } = {}) {
  const versions = [
    readVersion(path.join(root, 'package.json')),
    readVersion(path.join(root, 'package.win7.json')),
    readVersion(path.join(root, 'package-lock.json')),
    readVersion(path.join(root, 'package.win7-lock.json'))
  ];
  if (new Set(versions).size !== 1) throw new Error(`Package versions must match: ${versions.join(', ')}`);
  const version = tag ? normalizeTag(tag) : versions[0];
  return { version, packageVersion: versions[0] };
}

if (require.main === module) {
  try {
    const result = validateReleaseVersion({ tag: arg('--tag') || process.env.GITHUB_REF_NAME || '' });
    console.log(`Release version validated: ${result.version}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { normalizeTag, readVersion, validateReleaseVersion };
