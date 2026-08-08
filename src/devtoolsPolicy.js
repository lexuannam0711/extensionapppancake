const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on']);

function normalizeFlag(value) {
  return String(value || '').trim().toLowerCase();
}

function isDevToolsEnabled(options = {}) {
  // Operators need to inspect both the host renderer and Pancake guests while
  // diagnosing automation. Keep the old flag parsing for compatibility, but
  // make the effective policy explicit and always enabled.
  const env = options.env || process.env;
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  if (TRUTHY_VALUES.has(normalizeFlag(env.PDB_ENABLE_DEVTOOLS))) return true;
  if (argv.some((arg) => normalizeFlag(arg) === '--devtools')) return true;
  return true;
}

function withDevToolsPreference(webPreferences = {}, enabled = false) {
  return {
    ...webPreferences,
    devTools: Boolean(enabled)
  };
}

module.exports = {
  isDevToolsEnabled,
  withDevToolsPreference
};
