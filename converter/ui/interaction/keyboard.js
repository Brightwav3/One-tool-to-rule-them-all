
function openPalette() { paletteOpen = true; query = ''; commandIndex = 0; pickerFor = null; render(true); setTimeout(() => $('palInput')?.focus(), 0); }

document.addEventListener('keydown', event => {
  const key = (event.key || '').toLowerCase();
  // The rename field owns Enter and Escape while it has focus, so Escape undoes
  // the edit instead of closing whatever else is open behind the inspector.
  if (event.target?.dataset?.act === 'rename-file') {
    if (key === 'enter') { event.preventDefault(); commitRename(event.target); return; }
    if (key === 'escape') {
      event.preventDefault(); event.stopPropagation();
      const file = files.find(i => i.id === event.target.dataset.id);
      event.target.value = file ? outputStem(file) : event.target.value;
      event.target.blur();
      return;
    }
  }
  if (event.target?.dataset?.act === 'rename-history-file') {
    if (key === 'enter') { event.preventDefault(); commitHistoryRename(event.target); return; }
    if (key === 'escape') {
      event.preventDefault(); event.stopPropagation();
      const record = historyRecords.find(i => i.id === event.target.dataset.id);
      const name = String(record?.name || ''), dot = name.lastIndexOf('.');
      event.target.value = dot > 0 ? name.slice(0, dot) : name;
      event.target.blur();
      return;
    }
  }
  if ((event.metaKey || event.ctrlKey) && key === 'k') { event.preventDefault(); paletteOpen ? (paletteOpen = false, render(true)) : openPalette(); return; }
  if (event.altKey && key === 'i') { event.preventDefault(); inspectorOpen = !inspectorVisible(); if (inspectorOpen && panelWidth === 0) setPanelWidth(OneToolPanelResize.MIN_WIDTH); return render(true); }
  /* Escape closes one layer at a time: an open settings menu first, then the sheet. */
  if (key === 'escape' && settingsOpen) {
    if (setOpenSel) { setOpenSel = null; return render(true); }
    return closeSettings();
  }
  if ((event.metaKey || event.ctrlKey) && key === ',') { event.preventDefault(); return settingsOpen ? closeSettings() : openSettings(); }
  /* The editor owns the keyboard only while it is the visible page and nothing is
     layered over it, so the queue's own shortcuts are never shadowed. */
  if (page === 'editor' && !settingsOpen && !paletteOpen && document.activeElement?.tagName !== 'INPUT') {
    const mode = editor.state.mode;
    if (event.ctrlKey && (event.code === 'Space' || key === ' ')) { event.preventDefault(); editor.toggleMode(); return render(true); }
    if ((event.metaKey || event.ctrlKey) && key === 's') { event.preventDefault(); editor.saved(); showToast(`${editor.state.pages.length} pages written`); return render(true); }
    if (key === 'escape' && mode === 'reader') { event.preventDefault(); editor.toGrid(); return render(true); }
    if (mode === 'reader') {
      if (key === 'arrowright' || key === 'arrowdown') { event.preventDefault(); editor.step(1); return render(true); }
      if (key === 'arrowleft' || key === 'arrowup') { event.preventDefault(); editor.step(-1); return render(true); }
      if (key === 'r') { event.preventDefault(); editor.rotate(90); return render(true); }
    }
    if ((key === 'backspace' || key === 'delete') && editor.targets().length) { event.preventDefault(); editor.remove(); return render(true); }
  }
  if (key === 'escape') { closeContextMenu(); closeFolderMenu(); paletteOpen = false; pickerFor = null; sheetFor = null; return render(true); }
  if (paletteOpen && (key === 'arrowdown' || key === 'arrowup' || key === 'enter')) {
    const items = [...document.querySelectorAll('.pal-item')];
    if (key === 'arrowdown') { commandIndex = Math.min(items.length - 1, commandIndex + 1); event.preventDefault(); renderOverlays(); }
    else if (key === 'arrowup') { commandIndex = Math.max(0, commandIndex - 1); event.preventDefault(); renderOverlays(); }
    else if (items[commandIndex]) { items[commandIndex].click(); event.preventDefault(); }
    return;
  }
  if (key === 'enter' && !paletteOpen && !sheetFor && document.activeElement?.tagName !== 'INPUT' && page === 'convert') { event.preventDefault(); convert(); }
});

