(function initShortcutLabels(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OneToolShortcutLabels = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const SHORTCUTS = Object.freeze({
    palette: Object.freeze({mac: '⌘K', other: 'Ctrl K'}),
    inspector: Object.freeze({mac: '⌥I', other: 'Alt I'}),
    open: Object.freeze({mac: '⌘O', other: 'Ctrl O'}),
    save: Object.freeze({mac: '⌘S', other: 'Ctrl S'}),
    reader: Object.freeze({mac: '⌃Space', other: 'Ctrl Space'}),
    settings: Object.freeze({mac: '⌘,', other: 'Ctrl ,'}),
  });

  function label(name, isMac) {
    const shortcut = SHORTCUTS[name];
    return shortcut ? shortcut[isMac ? 'mac' : 'other'] : '';
  }

  return {label, SHORTCUTS};
}));
