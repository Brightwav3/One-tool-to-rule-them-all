document.querySelectorAll('.navbtn').forEach(b => b.onclick = () => setPage(b.dataset.page));
$('settingsBtn').onclick = () => settingsOpen ? closeSettings() : openSettings();
$('crFiles').onchange = event => creatorTakeFiles(event.target.files);
$('edFiles').onchange = event => OneToolEditorActions.takeFiles(event.target.files);

/* Dropping a PDF on the editor opens it beside the one already there. The overlay
   only appears while a file is genuinely over the window. */
pages.editor.addEventListener('dragover', event => {
  event.preventDefault();
  if (!editor.state.dragging) { editor.state.dragging = true; render(true); }
});
pages.editor.addEventListener('dragleave', event => {
  if (pages.editor.contains(event.relatedTarget)) return;
  if (editor.state.dragging) { editor.state.dragging = false; render(true); }
});
pages.editor.addEventListener('drop', event => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  editor.state.dragging = false;
  editor.openPair(file ? file.name : 'Untitled — extras.pdf');
  showToast(`${editor.state.bName} opened beside this one`);
  render(true);
});
$('searchBtn').onclick = openPalette;
$('winMin').onclick = () => shell?.minimize?.();
$('winMax').onclick = () => shell?.toggleMaximize?.();
$('winClose').onclick = () => shell?.close?.();

if (shell?.platform) {
  document.body.classList.add(shell.platform === 'darwin' ? 'is-mac' : 'is-electron');
  shell.onState?.(state => {
    const icon = $('winMaxIcon');
    if (icon) icon.innerHTML = state.maximized
      ? '<path d="M2.5 2.5h6v6h-6z"/><path d="M1.5 1.5h6v1"/>'
      : '<rect x=".5" y=".5" width="9" height="9"/>';
  });
  shell.onUpdateState?.(() => {});
}

Promise.all([
  fetch('/api/tools').then(r => r.json()),
  fetch('/api/state').then(r => r.json()),
]).then(([toolData, state]) => { setTools(toolData.tools || []); absorb(state); loadHistory(); })
  .catch(error => showToast(error.message, false));

setInterval(async () => {
  try { const res = await fetch('/api/state'); absorb(await res.json()); }
  catch { /* server may be restarting */ }
}, 700);
