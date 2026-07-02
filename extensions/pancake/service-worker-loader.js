import './electron-shim.js';

self.addEventListener('error', (event) => {
  console.warn('[pancake-extension] background error:', event.message || event.error);
  event.preventDefault();
});

self.addEventListener('unhandledrejection', (event) => {
  console.warn('[pancake-extension] background rejection:', event.reason);
  event.preventDefault();
});

import('./assets/background.js-B_9N00PA.js').catch((error) => {
  console.warn('[pancake-extension] background import failed:', error);
});
