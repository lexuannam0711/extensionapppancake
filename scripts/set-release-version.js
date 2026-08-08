const fs = require('fs');
const { parseVersion } = require('../src/update/manifest');

function argValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  return values;
}

function getVersion(packageJson) {
  const version = String(packageJson.version || '').trim();
  parseVersion(version);
  if (packageJson.packages && packageJson.packages[''] && packageJson.packages[''].version !== version) throw new Error('Lock root version must match package version');
  return version;
}

function setReleaseVersion(files, version) {
  const normalizedVersion = String(version || '').replace(/^v/, '');
  parseVersion(normalizedVersion);
  const packages = files.map((filePath) => ({ filePath, packageJson: JSON.parse(fs.readFileSync(filePath, 'utf8')) }));
  const versions = packages.map(({ packageJson }) => getVersion(packageJson));
  if (new Set(versions).size !== 1) throw new Error(`Package versions must match: ${versions.join(', ')}`);
  for (const { filePath, packageJson } of packages) {
    packageJson.version = normalizedVersion;
    if (packageJson.packages && packageJson.packages['']) packageJson.packages[''].version = normalizedVersion;
    fs.writeFileSync(filePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  }
  return normalizedVersion;
}

if (require.main === module) {
  try {
    const versionIndex = process.argv.indexOf('--version');
    const version = versionIndex >= 0 ? process.argv[versionIndex + 1] : '';
    const files = argValues('--file');
    if (!version || !files.length) throw new Error('Usage: node scripts/set-release-version.js --version <version> --file <package.json> [--file <lockfile>]');
    console.log(`Set release version ${setReleaseVersion(files, version)}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { getVersion, setReleaseVersion };
