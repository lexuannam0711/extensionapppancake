(() => {
  const ICONS = {
    'arrow-right': '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    folder: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10l2 2h5.5A2.5 2.5 0 0 1 20 8.5v7A2.5 2.5 0 0 1 17.5 18h-11A2.5 2.5 0 0 1 4 15.5z"/>',
    lightbulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.75V16h8v-1.25A7 7 0 0 0 12 2z"/>',
    menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
    moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.5 6.5 0 0 0 21 12.8z"/>',
    pause: '<path d="M8 5v14"/><path d="M16 5v14"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    puzzle: '<path d="M8.5 3a2.5 2.5 0 0 1 5 0v2H17a2 2 0 0 1 2 2v3.5h-2a2.5 2.5 0 0 0 0 5h2V19a2 2 0 0 1-2 2h-3.5v-2a2.5 2.5 0 0 0-5 0v2H5a2 2 0 0 1-2-2v-3.5h2a2.5 2.5 0 0 0 0-5H3V7a2 2 0 0 1 2-2h3.5z"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 20v-4h-4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'
  };

  function svg(name) {
    const body = ICONS[name] || ICONS.menu;
    return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
  }

  function set(target, name) {
    if (!target) return;
    target.innerHTML = svg(name);
    target.dataset.icon = name;
  }

  function hydrate(root = document) {
    root.querySelectorAll('[data-icon]').forEach((el) => set(el, el.dataset.icon));
  }

  window.PDBIcons = { svg, set, hydrate };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => hydrate());
  } else {
    hydrate();
  }
})();
