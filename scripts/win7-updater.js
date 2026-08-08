const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { spawn } = require('child_process');
const path = require('path');
const { downloadAndApplyWin7Update, getDefaultFetch, withChannel, PRESERVED_INSTALL_PATHS } = require('../src/update/win7-updater');
const { restoreDirectoryBackup } = require('../src/update/rollback');

const execFileAsync = promisify(execFile);

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function requireArg(name) {
  const value = readArg(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function readInstalledVersion(installDir) {
  for (const fileName of ['package.json', 'package.win7.json']) {
    try {
      const packageJson = JSON.parse(await fs.readFile(path.join(installDir, fileName), 'utf8'));
      if (packageJson.version) return String(packageJson.version);
    } catch (_) {}
  }
  return '';
}

function launchAppAndWait(executable, appPath, { spawnImpl = spawn, waitMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    let settled = false;
    let timer;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const child = spawnImpl(executable, [appPath], { detached: true, stdio: 'ignore', windowsHide: true, env: environment });
    child.once?.('error', fail);
    child.once?.('exit', (code, signal) => fail(new Error(`Updated app exited during startup: ${code ?? signal ?? 'unknown'}`)));
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref?.();
      resolve(child);
    }, waitMs);
  });
}

async function extractWithPowerShell(archivePath, destination) {
  const command = 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force';
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command, archivePath, destination], { windowsHide: true });
}

async function main() {
  const manifestUrl = requireArg('--manifest-url');
  const installDir = path.resolve(requireArg('--install-dir'));
  const publicKeyPath = path.resolve(requireArg('--public-key'));
  const currentVersion = readArg('--current-version') || await readInstalledVersion(installDir);
  const appExe = readArg('--app-exe');
  const appPath = path.resolve(readArg('--app-path') || installDir);
  const publicKey = await fs.readFile(publicKeyPath, 'utf8');
  const allowedHosts = String(process.env.UPDATE_ALLOWED_HOSTS || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  const manifestOrigin = new URL(manifestUrl);
  if (manifestOrigin.protocol !== 'https:' || manifestOrigin.username || manifestOrigin.password || manifestOrigin.port || !allowedHosts.length || !allowedHosts.includes(manifestOrigin.hostname.toLowerCase())) throw new Error('Manifest host is not allowed');
  const response = await getDefaultFetch(undefined, { allowedHosts })(withChannel(manifestUrl, 'win7', currentVersion));
  if (!response.ok) throw new Error(`Manifest request failed: ${response.status}`);
  if (response.status === 204) {
    process.stdout.write('Current\\n');
    return;
  }
  if (response.url && !allowedHosts.includes(new URL(response.url).hostname.toLowerCase())) throw new Error('Manifest redirect host is not allowed');
  const manifest = await response.json();
  const result = await downloadAndApplyWin7Update({
    manifest,
    installDir,
    publicKey,
    allowedHosts,
    extractArchive: extractWithPowerShell,
    currentVersion,
    preservePaths: PRESERVED_INSTALL_PATHS
  });
  process.stdout.write(`Updated ${result.manifest.version}\n`);
  if (appExe) {
    const resolvedExe = path.resolve(appExe);
    const relativeExe = path.relative(installDir, resolvedExe);
    if (relativeExe === '..' || relativeExe.startsWith('..' + path.sep) || path.isAbsolute(relativeExe)) throw new Error('App executable is outside install directory');
    const relativeAppPath = path.relative(installDir, appPath);
    if (relativeAppPath === '..' || relativeAppPath.startsWith('..' + path.sep) || path.isAbsolute(relativeAppPath)) throw new Error('App path is outside install directory');
    try {
      await launchAppAndWait(resolvedExe, appPath);
      if (result.backupDir) await fs.rm(result.backupDir, { recursive: true, force: true });
    } catch (error) {
      if (result.backupDir) {
        await restoreDirectoryBackup({ currentDir: installDir, backupDir: result.backupDir });
        await launchAppAndWait(resolvedExe, appPath).catch(() => {});
      }
      throw error;
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { launchAppAndWait, readInstalledVersion };
