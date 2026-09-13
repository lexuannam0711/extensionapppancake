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

function validateReleaseVersion({ tag = '', root = path.resolve(__dirname, '..') } = {}) {
  const versions = [readVersion(path.join(root, 'package.json')), readVersion(path.join(root, 'package-lock.json'))];
  if (new Set(versions).size !== 1) throw new Error(`Package versions must match: ${versions.join(', ')}`);
  const version = tag ? normalizeTag(tag) : versions[0];
  return { version, packageVersion: versions[0] };
}

if (require.main === module) {
  try {
    const explicitTag = arg('--tag');
    const isTagRef = process.env.GITHUB_REF_TYPE === 'tag';
    const tag = explicitTag || (isTagRef ? (process.env.GITHUB_REF_NAME || '') : '');
    const result = validateReleaseVersion({ tag });
    console.log(`Release version validated: ${result.version}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { normalizeTag, readVersion, validateReleaseVersion };
