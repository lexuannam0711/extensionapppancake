const fs = require('fs/promises');
const path = require('path');
const { assertSafePath } = require('./pathSafety');

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch (_) { return false; }
}

async function assertNoLinks(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) throw new Error(`Update tree contains a link: ${entryPath}`);
    if (stats.isDirectory()) await assertNoLinks(entryPath);
  }
}

async function copyTree(source, destination) {
  const stats = await fs.lstat(source);
  if (stats.isSymbolicLink()) throw new Error(`Preserved update path contains a link: ${source}`);
  if (stats.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source)) await copyTree(path.join(source, entry), path.join(destination, entry));
    return;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function copyPreservedPaths({ currentDir, backupDir, preservePaths }) {
  for (const relativePath of preservePaths) {
    const source = assertSafePath(backupDir, path.join(backupDir, relativePath));
    const destination = assertSafePath(currentDir, path.join(currentDir, relativePath));
    if (!(await exists(source))) continue;
    await fs.rm(destination, { recursive: true, force: true });
    await copyTree(source, destination);
  }
}

async function applyDirectoryUpdate({ currentDir, stagingDir, backupDir, preservePaths = [], cleanupBackup = false }) {
  const parent = path.dirname(currentDir);
  assertSafePath(parent, currentDir);
  assertSafePath(parent, stagingDir);
  assertSafePath(parent, backupDir);
  await fs.mkdir(parent, { recursive: true });
  if (!(await exists(stagingDir))) throw new Error('Update staging directory is missing');
  await assertNoLinks(stagingDir);
  await fs.rm(backupDir, { recursive: true, force: true });
  const hadCurrent = await exists(currentDir);
  if (hadCurrent) await fs.rename(currentDir, backupDir);
  try {
    await fs.rename(stagingDir, currentDir);
    if (hadCurrent) await copyPreservedPaths({ currentDir, backupDir, preservePaths });
  } catch (error) {
    if (hadCurrent) {
      await fs.rm(currentDir, { recursive: true, force: true });
      await fs.rename(backupDir, currentDir).catch(() => {});
    }
    throw error;
  }
  if (cleanupBackup) await fs.rm(backupDir, { recursive: true, force: true });
  return { currentDir, backupDir: hadCurrent ? backupDir : null };
}

async function restoreDirectoryBackup({ currentDir, backupDir }) {
  const parent = path.dirname(currentDir);
  assertSafePath(parent, currentDir);
  assertSafePath(parent, backupDir);
  if (!(await exists(backupDir))) throw new Error('Update backup is missing');
  await fs.rm(currentDir, { recursive: true, force: true });
  await fs.rename(backupDir, currentDir);
  return currentDir;
}

module.exports = { applyDirectoryUpdate, restoreDirectoryBackup };
