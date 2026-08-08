const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

function readPrivateKey() {
  const configured = process.env.RELEASE_SIGNING_PRIVATE_KEY || '';
  if (!configured) throw new Error('RELEASE_SIGNING_PRIVATE_KEY is required');
  return crypto.createPrivateKey(configured.includes('BEGIN') ? configured : Buffer.from(configured, 'base64').toString('utf8'));
}

async function main() {
  const output = path.resolve(process.argv[process.argv.indexOf('--output') + 1] || 'src/update/trusted-public-key.pem');
  const publicKey = crypto.createPublicKey(readPrivateKey()).export({ type: 'spki', format: 'pem' });
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, publicKey, { encoding: 'utf8', mode: 0o644 });
  console.log(`Created ${output}`);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });