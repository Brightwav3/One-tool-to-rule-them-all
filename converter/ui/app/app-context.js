'use strict';
const shell = window.appWindow;
const $ = id => document.getElementById(id);
const work = $('work'), panel = $('panel'), panelBody = $('panelBody');
const contextMenu = $('contextMenu');
const panelResizeHandle = document.querySelector('[data-panel-resize]');
const isMac = shell?.platform === 'darwin';
const shortcutLabel = name => OneToolShortcutLabels.label(name, isMac);
const THEME_STORAGE = 'one-tool.theme';
let themeName = 'light';
let themeHydrated = false;
function readTheme() {
  try { return localStorage.getItem(THEME_STORAGE) === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}
function applyTheme(next, persist = true) {
  themeName = next === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = themeName;
  document.documentElement.style.colorScheme = themeName;
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE, themeName); } catch { /* storage may be unavailable */ }
    shell?.setTheme?.(themeName);
  }
}
applyTheme(readTheme(), false);
Promise.resolve(shell?.getTheme?.()).then(saved => {
  if (themeHydrated) return;
  if (saved !== 'dark' && saved !== 'light') {
    themeHydrated = true;
    return;
  }
  applyTheme(saved, false);
  try { localStorage.setItem(THEME_STORAGE, saved); } catch { /* storage may be unavailable */ }
  shell?.setTheme?.(saved);
  themeHydrated = true;
}).catch(() => { themeHydrated = true; });
function renderShortcutLabels() {
  document.querySelectorAll('[data-shortcut]').forEach(el => { el.textContent = shortcutLabel(el.dataset.shortcut); });
}
const pages = { convert: $('pageConvert'), creator: $('pageCreator'), editor: $('pageEditor') };
const setScrim = $('setScrim'), setWin = $('setWin');
