function readSettings() {
  try { const raw = JSON.parse(localStorage.getItem(SETTINGS_STORAGE) || '{}'); return raw && typeof raw === 'object' ? raw : {}; }
  catch { return {}; }
}
function writeSettings() { try { localStorage.setItem(SETTINGS_STORAGE, JSON.stringify(setVals)); } catch {} }
/* An unset value is the row's default, so a stored file only ever holds what the
   user actually changed and a new default reaches an existing install. */
function settingValue(row) {
  if (row.id === 'theme') return setVals.theme || (themeName === 'dark' ? 'Dark' : 'Light');
  const stored = setVals[row.id];
  if (row.kind === 'switch') return stored === undefined ? Boolean(row.on) : Boolean(stored);
  if (row.kind === 'select') return stored === undefined ? row.opts[0] : stored;
  return row.value;
}
function setSetting(id, value) {
  setVals[id] = value; writeSettings();
  if (id === 'theme') applyTheme(value === 'Dark' ? 'dark' : value === 'Light' ? 'light' : systemTheme());
}
const systemTheme = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
const missingHelpers = () => helperNames().filter(name => !helperFound(name));
