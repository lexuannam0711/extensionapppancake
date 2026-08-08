const fs = require('fs/promises');
const path = require('path');

async function writePrivateFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, value, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

function createEncryptedTokenStore({ safeStorage, filePath }) {
  if (!safeStorage || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
    throw new Error('Electron safeStorage is required');
  }
  return Object.freeze({
    async save(token) {
      if (typeof token !== 'string' || !token) throw new Error('Token must be a non-empty string');
      if (safeStorage.isEncryptionAvailable && !safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable');
      const encrypted = safeStorage.encryptString(token).toString('base64');
      await writePrivateFile(filePath, encrypted);
    },
    async load() {
      try {
        const encrypted = Buffer.from(await fs.readFile(filePath, 'utf8'), 'base64');
        return safeStorage.decryptString(encrypted);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('Encrypted token cannot be read');
      }
    },
    async clear() {
      await fs.rm(filePath, { force: true });
    }
  });
}

module.exports = { createEncryptedTokenStore };