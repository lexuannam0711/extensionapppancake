const crypto = require('crypto');
const fs = require('fs');

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function decodeSignature(signature) {
  const encoded = String(signature || '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Signature is invalid');
  const value = Buffer.from(encoded, 'base64');
  if (value.length !== 64) throw new Error('Signature is invalid');
  return value;
}

function verifyEd25519(payload, signature, publicKey) {
  try { return crypto.verify(null, Buffer.isBuffer(payload) ? payload : Buffer.from(payload), publicKey, decodeSignature(signature)); } catch (_) { return false; }
}

function signEd25519(payload, privateKey) {
  return crypto.sign(null, Buffer.isBuffer(payload) ? payload : Buffer.from(payload), privateKey).toString('base64');
}

module.exports = { sha256Buffer, sha256File, verifyEd25519, signEd25519 };