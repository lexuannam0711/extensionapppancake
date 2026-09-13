const fs = require('fs/promises');
const path = require('path');
const asar = require('@electron/asar');

const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const BLOCKED_PATHS = [
  /(^|[\\/])\.env(?:\.|$)/i,
  /(^|[\\/])server[\\/]data(?:[\\/]|$)/i,
  /(^|[\\/])uploads(?:[\\/]|$)/i,
  /(^|[\\/])(?:\.git|\.claude|\.agents|\.gitnexus|\.remember|\.cache|test-results|playwright-report)(?:[\\/]|$)/i,
  /\.(?:pem|key|p12|pfx)$/i
];
const SECRET_PATTERNS = [/AI_API_KEY\s*=\s*/i, /OPENAI_API_KEY\s*=\s*/i, /GEMINI_API_KEY\s*=\s*/i, /TELEGRAM_BOT_TOKEN\s*=\s*/i, /TELEGRAM_CHAT_ID\s*=\s*/i, /SUPABASE_SERVICE_ROLE_KEY\s*=\s*/i, /SUPABASE_JWT_SECRET\s*=\s*/i, /RELEASE_SIGNING_PRIVATE_KEY\s*=\s*/i, /BEGIN [A-Z ]*PRIVATE KEY/i];

async function collectFiles(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Artifact contains a symbolic link: ${path.relative(root, fullPath)}`);
    if (entry.isDirectory()) files.push(...await collectFiles(root, fullPath));
    else files.push(fullPath);
  }
  return files;
}

function isTrustedPublicKey(relative) {
  const normalized = relative.replaceAll('\\', '/').toLowerCase();
  return normalized === 'src/update/trusted-public-key.pem' || normalized === 'update/trusted-public-key.pem' || normalized.endsWith('/src/update/trusted-public-key.pem') || normalized.endsWith('/update/trusted-public-key.pem');
}

function isBlockedPath(relative) {
  const normalized = relative.replaceAll('\\', '/').toLowerCase();
  if (isTrustedPublicKey(relative)) return false;
  return path.basename(relative).toLowerCase() !== '.env.example' && BLOCKED_PATHS.some((pattern) => pattern.test(normalized));
}

function isBinary(content) {
  return content.includes(0);
}

function findViolations(relative, content) {
  const violations = [];
  if (isBlockedPath(relative)) violations.push(`blocked path: ${relative}`);
  if (content.length <= MAX_TEXT_BYTES && !isBinary(content)) {
    const text = content.toString('utf8');
    if (path.basename(relative).toLowerCase() !== '.env.example' && SECRET_PATTERNS.some((pattern) => pattern.test(text))) violations.push(`secret pattern: ${relative}`);
  }
  return violations;
}

async function auditAsar(archivePath, relativeArchive) {
  const extractionRoot = await fs.mkdtemp(path.join(require('os').tmpdir(), 'pdb-asar-audit-'));
  try {
    asar.extractAll(archivePath, extractionRoot);
    const extractedFiles = await collectFiles(extractionRoot);
    const violations = [];
    for (const filePath of extractedFiles) {
      const entry = path.relative(extractionRoot, filePath);
      const relative = `${relativeArchive}/${entry}`;
      const stats = await fs.stat(filePath);
      if (isBlockedPath(entry)) violations.push(`blocked path: ${relative}`);
      if (entry.split(/[\\/]/).includes('node_modules')) continue;
      if (stats.size > MAX_TEXT_BYTES) continue;
      violations.push(...findViolations(relative, await fs.readFile(filePath)));
    }
    return violations;
  } finally {
    await fs.rm(extractionRoot, { recursive: true, force: true });
  }
}
async function auditArtifact(root) {
  const resolvedRoot = path.resolve(root);
  const files = await collectFiles(resolvedRoot);
  const violations = [];
  for (const filePath of files) {
    const relative = path.relative(resolvedRoot, filePath);
    if (path.extname(filePath).toLowerCase() === '.asar') {
      violations.push(...await auditAsar(filePath, relative));
      continue;
    }
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_TEXT_BYTES) {
      if (isBlockedPath(relative)) violations.push(`blocked path: ${relative}`);
      continue;
    }
    const content = await fs.readFile(filePath);
    if (relative.split(/[\\\\/]/).includes('node_modules')) {
      if (isBlockedPath(relative)) violations.push(`blocked path: ${relative}`);
      continue;
    }
    violations.push(...findViolations(relative, content));
  }
  if (violations.length) throw new Error(`Artifact audit failed:\n${violations.join('\n')}`);
  return { root: resolvedRoot, files: files.length };
}

if (require.main === module) {
  auditArtifact(process.argv[2] || '.').then((result) => console.log(`Artifact audit passed: ${result.files} files`)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { auditArtifact, BLOCKED_PATHS, SECRET_PATTERNS, isBlockedPath };
