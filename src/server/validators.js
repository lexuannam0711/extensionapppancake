function isShortcut(text) {
  return /^\/\d+$/.test(String(text || '').trim());
}

function sanitizeShortcut(text) {
  const cleaned = String(text || '').trim();
  if (!isShortcut(cleaned)) throw new Error(`Invalid shortcut: ${cleaned}`);
  return cleaned;
}

function validateShortcutOnly(result, shortcuts) {
  const list = Array.isArray(shortcuts) ? shortcuts : [];
  if (!result || !result.shortcut) {
    return { shortcut: null, confidence: 0, reason: 'No shortcut' };
  }
  const shortcut = String(result.shortcut).trim();
  if (!isShortcut(shortcut)) {
    return { shortcut: null, confidence: 0, reason: 'Invalid shortcut format' };
  }
  const exists = list.some((item) => item.shortcut === shortcut);
  if (!exists) {
    return { shortcut: null, confidence: 0, reason: 'Shortcut not found in imported list' };
  }
  return {
    shortcut,
    confidence: Math.max(0, Math.min(1, Number(result.confidence || 0))),
    reason: String(result.reason || '')
  };
}

function validateTopSuggestions(suggestions, shortcuts) {
  const list = Array.isArray(shortcuts) ? shortcuts : [];
  const seen = new Set();
  return (Array.isArray(suggestions) ? suggestions : [])
    .filter((s) => s && isShortcut(s.shortcut))
    .filter((s) => list.some((item) => item.shortcut === String(s.shortcut).trim()))
    .filter((s) => {
      const shortcut = String(s.shortcut).trim();
      if (seen.has(shortcut)) return false;
      seen.add(shortcut);
      return true;
    })
    .slice(0, 3)
    .map((s) => ({
      shortcut: String(s.shortcut).trim(),
      topic: String(s.topic || list.find((item) => item.shortcut === String(s.shortcut).trim())?.topic || ''),
      confidence: Math.max(0, Math.min(1, Number(s.confidence || 0))),
      reason: String(s.reason || '')
    }));
}

module.exports = { isShortcut, sanitizeShortcut, validateShortcutOnly, validateTopSuggestions };
