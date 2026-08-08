const { classifyPancakeUrl } = require('./renderer/pancakeUrlPolicy');

function isAllowedGuestNavigation(value) {
  return classifyPancakeUrl(value) !== 'untrusted';
}

function resolveGuestNavigation(value) {
  const kind = classifyPancakeUrl(value);
  if (kind === 'untrusted') return Object.freeze({ action: 'deny', kind });

  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch (_) {
    return Object.freeze({ action: 'deny', kind: 'untrusted' });
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, '') || '/';
  if (host === 'account.pancake.vn'
    || ((host === 'pancake.vn' || host === 'www.pancake.vn' || host === 'pages.fm' || host === 'www.pages.fm')
      && ['/login', '/signin', '/sign-in'].includes(path))) {
    return Object.freeze({ action: 'same-webview', kind: 'pancake-auth' });
  }
  if (kind === 'auth') return Object.freeze({ action: 'popup', kind: 'external-auth' });
  return Object.freeze({ action: 'allow', kind: 'app' });
}

module.exports = { isAllowedGuestNavigation, resolveGuestNavigation };
