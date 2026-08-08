const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { parseManifest, canonicalManifestPayload } = require('../src/update/manifest');
const { sha256File, signEd25519 } = require('../src/update/integrity');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function required(name) {
  const value = arg(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function readPrivateKey() {
  const configured = process.env.RELEASE_SIGNING_PRIVATE_KEY || '';
  if (!configured) throw new Error('RELEASE_SIGNING_PRIVATE_KEY is required');
  const pem = configured.includes('BEGIN') ? configured : Buffer.from(configured, 'base64').toString('utf8');
  return crypto.createPrivateKey(pem);
}

async function main() {
  const artifactPath = path.resolve(required('--artifact'));
  const version = required('--version').replace(/^v/, '');
  const channel = required('--channel');
  const artifactUrl = required('--url');
  const outputPath = path.resolve(required('--output'));
  const releaseNotesPath = arg('--release-notes');
  const unsigned = {
    version,
    channel,
    minSupportedVersion: arg('--min-supported-version') || version,
    artifactUrl,
    sha256: await sha256File(artifactPath),
    signature: Buffer.alloc(64).toString('base64'),
    releaseNotes: releaseNotesPath ? await fs.readFile(path.resolve(releaseNotesPath), 'utf8') : ''
  };
  const signature = signEd25519(canonicalManifestPayload(unsigned), readPrivateKey());
  const manifest = parseManifest({ ...unsigned, signature });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Created ${outputPath}`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { readPrivateKey };