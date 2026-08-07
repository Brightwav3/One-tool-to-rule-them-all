
async function commitHistoryRename(input) {
  if (!input || input.disabled) return;
  const record = historyRecords.find(i => i.id === input.dataset.id);
  if (!record) return;
  const name = String(record.name || '');
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const next = input.value.trim();
  if (!next || next === stem) { input.value = stem; return; }
  try { await api('/api/history/rename', {id: record.id, name: next}, false); await loadHistory(); showToast('Renamed'); }
  catch (error) { showToast(error.message, false); input.value = stem; }
}
async function commitRename(input) {
  if (!input || input.disabled) return;
  const file = files.find(i => i.id === input.dataset.id);
  if (!file) return;
  const next = input.value.trim();
  if (!next || next === outputStem(file)) { input.value = outputStem(file); return; }
  try { await api('/api/rename', {id: file.id, name: next}); showToast('Renamed'); }
  catch (error) { showToast(error.message, false); input.value = outputStem(file); }
}
/* Renaming a written file is the same gesture as renaming a queued one: the
   inspector opens on that row with the name selected and ready to type. */
function startHistoryRename(id) {
  selectedHistory = id; selectedId = null; selectedQueueIds = new Set(); queueAnchorId = null;
  selectedHelper = null; pickerFor = null;
  render(true);
  setTimeout(() => { const input = $('renameField'); if (input && !input.disabled) { input.focus(); input.select(); } }, 0);
}
function startRename(id) {
  selectedId = id; selectedHelper = null; pickerFor = null;
  render(true);
  // after the panel has been rebuilt, put the caret in the field ready to type
  setTimeout(() => { const input = $('renameField'); if (input && !input.disabled) { input.focus(); input.select(); } }, 0);
}
document.addEventListener('focusout', event => {
  if (event.target?.dataset?.act === 'rename-file') commitRename(event.target);
  if (event.target?.dataset?.act === 'rename-history-file') commitHistoryRename(event.target);
});

function updateFieldFromControl(target) {
  const field = target.closest('[data-act="update-field"]');
  if (field && selectedId) api('/api/update', {id: selectedId, key: field.dataset.key, value: field.value}, false).catch(error => showToast(error.message, false));
}

document.addEventListener('input', event => {
  const target = event.target;
  if (target.id === 'palInput') { query = target.value; commandIndex = 0; renderOverlays(); return; }
  if (target.id === 'sheetSearch') { const caret = target.selectionStart; sheetQuery = target.value; renderOverlays();
    const again = $('sheetSearch'); if (again) { again.focus(); again.setSelectionRange(caret, caret); } return; }
  /* The settings pane is rebuilt on every keystroke, so the field it was typed in
     is put back exactly where it was rather than losing the caret. */
  if (target.id === 'setSearch') { const caret = target.selectionStart; setQuery = target.value; setOpenSel = null; renderSettings();
    const again = $('setSearch'); if (again) { again.focus(); again.setSelectionRange(caret, caret); } return; }
  if (target.id === 'crQuery' || target.id === 'crName' || target.dataset.crOpt) {
    const id = target.id, caret = target.selectionStart;
    if (target.dataset.crOpt) creator.setValue(target.dataset.crOpt, target.value);
    else if (id === 'crQuery') creator.state.query = target.value;
    else creator.state.name = target.value;
    renderCreator();
    const again = $(id); if (again) { again.focus(); again.setSelectionRange(caret, caret); }
    return;
  }
  updateFieldFromControl(target);
});
document.addEventListener('change', event => updateFieldFromControl(event.target));
