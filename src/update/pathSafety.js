const path = require('path');

function assertSafePath(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Path is outside install root: ${candidate}`);
  return resolvedCandidate;
}

function safeJoin(root, ...parts) {
  return assertSafePath(root, path.join(root, ...parts));
}

function assertSafeArchiveEntry(root, entryName) {
  const normalized = String(entryName || '').replaceAll('\\', '/');
  if (!normalized || normalized.includes('\0') || normalized.includes(':') || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) throw new Error(`Unsafe archive entry: ${entryName}`);
  const segments = normalized.split('/');
  if (segments.some((segment) => /[ .]$/.test(segment) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(segment))) throw new Error(`Unsafe archive entry: ${entryName}`);
  return assertSafePath(root, path.join(root, ...segments));
}

module.exports = { assertSafePath, safeJoin, assertSafeArchiveEntry };