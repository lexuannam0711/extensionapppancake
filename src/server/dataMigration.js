const fs = require('fs/promises');
const path = require('path');

const DATA_SCHEMA_VERSION = 1;
const MIGRATED_FILES = ['settings.json', 'shortcuts.json', 'logs.json', 'examples.json', 'review-queue.json'];

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch (_) { return false; }
}

async function copyDirectoryIfMissing(source, destination) {
  if (!(await exists(source))) return false;
  await fs.mkdir(destination, { recursive: true });
  let copied = false;
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (await exists(destinationPath)) continue;
    if (entry.isDirectory()) await fs.cp(sourcePath, destinationPath, { recursive: true, errorOnExist: false });
    else await fs.copyFile(sourcePath, destinationPath);
    copied = true;
  }
  return copied;
}

async function copyFileIfMissing(source, destination) {
  if (!(await exists(source)) || (await exists(destination))) return false;
  await fs.copyFile(source, destination);
  return true;
}

async function listDataFiles(dataRoot) {
  try { return await fs.readdir(dataRoot); } catch (_) { return []; }
}

async function createBackup(dataRoot) {
  const backupRoot = path.join(path.dirname(dataRoot), 'backups');
  const backupPath = path.join(backupRoot, `${path.basename(dataRoot)}-${Date.now()}`);
  await fs.mkdir(backupRoot, { recursive: true });
  await fs.cp(dataRoot, backupPath, { recursive: true, errorOnExist: false });
  return backupPath;
}

async function migrateData({ dataRoot, legacyRoot, uploadsRoot, legacyUploadsRoot }) {
  const resolvedDataRoot = path.resolve(dataRoot);
  const resolvedLegacyRoot = path.resolve(legacyRoot || dataRoot);
  await fs.mkdir(resolvedDataRoot, { recursive: true });
  const metadataPath = path.join(resolvedDataRoot, 'metadata.json');
  if (await exists(metadataPath)) {
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      if (Number(metadata.dataSchemaVersion) >= DATA_SCHEMA_VERSION) return { migrated: false, backupPath: null };
    } catch (_) {}
  }
  const existingFiles = (await listDataFiles(resolvedDataRoot)).filter((file) => file !== 'metadata.json');
  const backupPath = existingFiles.length ? await createBackup(resolvedDataRoot) : null;
  let copied = 0;
  if (resolvedDataRoot !== resolvedLegacyRoot) {
    for (const file of MIGRATED_FILES) {
      if (await copyFileIfMissing(path.join(resolvedLegacyRoot, file), path.join(resolvedDataRoot, file))) copied += 1;
    }
  }
  if (uploadsRoot && legacyUploadsRoot && path.resolve(uploadsRoot) !== path.resolve(legacyUploadsRoot)) {
    if (await copyDirectoryIfMissing(path.resolve(legacyUploadsRoot), path.resolve(uploadsRoot))) copied += 1;
  }
  const metadata = JSON.stringify({
    dataSchemaVersion: DATA_SCHEMA_VERSION,
    migratedAt: new Date().toISOString(),
    source: resolvedDataRoot === resolvedLegacyRoot ? 'existing-runtime-data' : resolvedLegacyRoot
  }, null, 2);
  const metadataTemp = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(metadataTemp, metadata, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await fs.rename(metadataTemp, metadataPath);
  return { migrated: copied > 0 || Boolean(backupPath), copied, backupPath };
}

module.exports = { DATA_SCHEMA_VERSION, MIGRATED_FILES, migrateData };