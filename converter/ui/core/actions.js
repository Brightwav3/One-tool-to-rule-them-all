/* ---------- actions ---------- */
async function chooseRoute(file, converterId) {
  const targets = scope === 'this' ? [file] : sameKind(file);
  try {
    for (const target of targets) await api('/api/route', {id: target.id, converter: converterId});
    pickerFor = null;
    showToast(targets.length === 1 ? 'Route changed' : `Route changed for ${targets.length} files`);
    render(true);
  } catch (error) { showToast(error.message, false); }
}
async function applyAll() {
  const file = selectedFile(); if (!file) return;
  const targets = sameKind(file);
  try {
    for (const target of targets) {
      if (target.id === file.id) continue;
      for (const key of ['title','creator']) if (file.opts?.[key] !== undefined) await api('/api/update', {id: target.id, key, value: file.opts[key]}, false);
    }
    showToast(`Applied to ${targets.length} files`);
  } catch (error) { showToast(error.message, false); }
}
async function convert() {
  if (actionStatus !== 'idle') return;
  const ready = files.filter(f => f.status === 'idle' && !isBlocked(f)).map(f => f.id);
  if (!ready.length) return;
  setActionStatus('pending');
  try { await api('/api/convert', {ids: ready}); showToast('Conversion started'); }
  catch (error) { setActionStatus('error'); showToast(error.message, false); }
}
async function unlockArchive() {
  const id = archivePromptId, input = $('archivePassword'), password = input?.value || '';
  if (!id) return;
  if (!password) { archivePromptError = 'Enter the archive password to continue.'; renderOverlays(); input?.focus(); return; }
  const button = document.querySelector('.archive-unlock');
  if (button) { button.disabled = true; button.textContent = 'Unlocking…'; }
  try {
    await api('/api/update', {id, key:'password', value:password}, false);
    archivePromptId = null; archivePromptError = '';
    await api('/api/convert', {ids:[id]});
    showToast('Archive unlocked', true);
  } catch (error) {
    archivePromptError = error.message;
    if (button) { button.disabled = false; button.textContent = 'Unlock archive'; }
    renderOverlays();
  }
}
async function historyAction(route, body, message) {
  try { await api(route, body); await loadHistory(); showToast(message); }
  catch (error) { showToast(error.message, false); }
}
function setPage(next) {
  page = next; pickerFor = null; sheetFor = null; paletteOpen = false;
  if (next !== 'convert') selectedHistory = null;
  if (next === 'convert') loadHistory();
  render(true);
}
function openSettings(tab) {
  settingsOpen = true; paletteOpen = false; sheetFor = null; pickerFor = null;
  setOpenSel = null; setQuery = '';
  if (tab) setTab = tab;
  render(true);
}
function closeSettings() { settingsOpen = false; setOpenSel = null; render(true); }

function dropdownCloseMs() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dropdown-close-dur')) || 150;
}
function openFolderMenu() {
  if (folderMenuTimer) { clearTimeout(folderMenuTimer); folderMenuTimer = null; }
  folderMenuState = 'open';
  render(true);
}
function closeFolderMenu(animate=true) {
  if (folderMenuState === 'closed') return;
  if (folderMenuTimer) clearTimeout(folderMenuTimer);
  if (!animate) { folderMenuState = 'closed'; render(true); return; }
  folderMenuState = 'closing';
  render(true);
  folderMenuTimer = setTimeout(() => { folderMenuState = 'closed'; folderMenuTimer = null; render(true); }, dropdownCloseMs());
}

async function copyText(value, message) {
  if (!value || !navigator.clipboard) return;
  await navigator.clipboard.writeText(value);
  showToast(message);
}
function revealTargetForRow(row) {
  const isHistory = row?.dataset.context === 'history-file';
  if (!isHistory) {
    /* the output only exists once the file has been written */
    const file = files.find(item => item.id === row?.dataset.id);
    if (file?.status === 'done' && file.out) return {path: file.out, history: true};
    return {path: '', history: false};
  }
  const record = isHistory
    ? historyRecords.find(item => item.id === row?.dataset.id)
    : files.find(item => item.id === row?.dataset.id);
  return {path: isHistory ? record?.outputPath : record?.sourcePath, history: isHistory};
}
async function revealFile(path, history=false) {
  if (!path) return;
  await api(history ? '/api/history/reveal' : '/api/reveal', {path}, false);
}
async function revealRow(row) {
  const target = revealTargetForRow(row);
  try { await revealFile(target.path, target.history); }
  catch (error) { showToast(error.message, false); }
}
