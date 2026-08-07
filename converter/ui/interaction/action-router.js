
document.addEventListener('pointerdown', event => {
  if (contextTarget && !contextMenu.contains(event.target)) closeContextMenu();
}, true);
document.addEventListener('contextmenu', event => {
  const row = event.target.closest('[data-context]');
  if (!row) { closeContextMenu(); return; }
  event.preventDefault();
  openContextMenu(event, row);
});
document.addEventListener('click', async event => {
  const menuItem = event.target.closest('[data-context-act]');
  if (!menuItem) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const action = menuItem.dataset.contextAct;
  const target = contextTarget;
  closeContextMenu();
  try { await handleContextAction(action, target); }
  catch (error) { showToast(error.message, false); }
});

document.addEventListener('click', async event => {
  if (folderMenuState !== 'closed' && !event.target.closest('.dest')) closeFolderMenu();
  /* Only one settings menu is ever open, and anywhere outside it closes it. */
  if (setOpenSel && !event.target.closest('.set-selwrap')) { setOpenSel = null; render(true); }
  const el = event.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if ((act === 'close-sheet' || act === 'close-palette' || act === 'close-settings') && el === event.target.closest('.scrim') && event.target.closest('[data-stop]')) return;
  // Double-click opens the output file whenever the row has written one. A row
  // that has not been converted yet has nothing to open, so it falls back to
  // renaming what it is going to write. Renaming itself lives in the context
  // menu, which every row has.
  if (event.detail === 2 && (act === 'select-row' || act === 'select-history')) {
    event.preventDefault();
    const target = revealTargetForRow(el);
    if (target.path) return revealFile(target.path, target.history).catch(error => showToast(error.message, false));
    const file = files.find(i => i.id === el.dataset.id);
    if (file && file.status !== 'queued' && file.status !== 'running') return startRename(file.id);
    return;
  }
  if (event.detail === 2 && act === 'select-history') {
    event.preventDefault();
    return revealRow(el);
  }

  switch (act) {
    case 'toggle-folder-menu': return folderMenuState === 'open' ? closeFolderMenu() : openFolderMenu();
    case 'select-folder': try { await api('/api/set-folder', {folder: el.dataset.folder}); closeFolderMenu(false); } catch (e) { showToast(e.message, false); } return;
    case 'forget-folder': event.stopPropagation(); try { await api('/api/forget-folder', {folder: el.dataset.folder}); } catch (e) { showToast(e.message, false); } return;
    case 'select-row': return applyQueueSelection(event, el.dataset.id);
    case 'reveal-file': event.stopPropagation(); return revealFile(el.dataset.path, el.dataset.revealKind === 'history').catch(error => showToast(error.message, false));
    // The picker acts on the row it belongs to, so opening it on a row outside an
    // existing multi-selection drops that selection rather than leaving two sets
    // of rows looking chosen at once.
    case 'toggle-picker': event.stopPropagation(); selectedId = el.dataset.id;
      if (!selectedQueueIds.has(el.dataset.id)) { selectedQueueIds = new Set(); queueAnchorId = null; }
      pickerFor = pickerFor === el.dataset.id ? null : el.dataset.id; return render(true);
    case 'choose-route': { event.stopPropagation(); const f = files.find(i => i.id === el.dataset.id); if (f) await chooseRoute(f, el.dataset.converter); return; }
    case 'open-sheet': event.stopPropagation(); sheetFor = el.dataset.id;
      sheetPick = files.find(i => i.id === sheetFor)?.to || null; sheetCat = null; sheetQuery = ''; pickerFor = null; return render(true);
    case 'cycle-scope': event.stopPropagation(); scope = scope === 'this' ? 'all' : 'this'; return render(true);
    case 'set-scope': event.stopPropagation(); scope = el.dataset.scope; return render(true);
    case 'reset-inspector': return render(true);
    case 'add': pendingAdd = true; render(true);
      try { await api('/api/pick-files'); } catch (e) { showToast(e.message, false); }
      finally { pendingAdd = false; render(true); } return;
    case 'folder': closeFolderMenu(false); try { await api('/api/pick-folder', {}); showToast('Destination updated'); } catch (e) { showToast(e.message, false); } return;
    case 'remove': event.stopPropagation(); try { await api('/api/remove', {id: el.dataset.id}); } catch (e) { showToast(e.message, false); } return;
    case 'clear': try { await api('/api/clear'); } catch (e) { showToast(e.message, false); } return;
    case 'convert': return convert();
    case 'palette': return openPalette();
    case 'toggle-advanced': advanced = !advanced; return render(true);
    case 'toggle-names': keepNames = !keepNames; return render(true);
    case 'apply-all': return applyAll();
    case 'select-helper': event.stopPropagation(); setOpenHelper = el.dataset.helper; return openSettings('helpers');
    case 'close-settings': return closeSettings();

    /* editor */
    case 'ed-page': editor.select(Number(el.dataset.id), {additive: event.metaKey || event.ctrlKey || event.shiftKey});
      if (event.detail === 2) editor.openReader(Number(el.dataset.id));
      return render(true);
    case 'ed-bpage': editor.selectB(Number(el.dataset.id), {additive: event.metaKey || event.ctrlKey || event.shiftKey}); return render(true);
    case 'ed-open': editor.openReader(Number(el.dataset.id)); return render(true);
    case 'ed-grid': editor.toGrid(); return render(true);
    case 'ed-tool': editor.state.tool = el.dataset.tool; return render(true);
    case 'ed-step': editor.step(Number(el.dataset.delta)); return render(true);
    case 'ed-zoom': editor.setZoom(Number(el.dataset.delta)); return render(true);
    case 'ed-scope': editor.state.scope = el.dataset.scope; return render(true);
    case 'ed-select-all': editor.selectAll(); return render(true);
    case 'ed-deselect': editor.deselect(); return render(true);
    case 'ed-rotate': editor.rotate(Number(el.dataset.deg)); return render(true);
    case 'ed-insert': editor.insert(); return render(true);
    case 'ed-delete': editor.remove(); return render(true);
    case 'ed-revert': editor.state.pages = OneToolEditorState.makePages();
      editor.state.sel = {}; editor.state.edits = []; editor.state.ocr = false; return render(true);
    case 'ed-extract': {
      const n = editor.targets().length || 1;
      editor.log(`Extracted ${n} page${n > 1 ? 's' : ''}`);
      showToast(`${n} page${n > 1 ? 's' : ''} extracted to a new PDF`);
      return render(true);
    }
    case 'ed-ocr': editor.addOcr(); showToast('Text layer added'); return render(true);
    case 'ed-compress': editor.log('Compressed images to 150 dpi'); showToast('402 MB → 249 MB'); return render(true);
    case 'ed-numbers': editor.log('Added page numbers, bottom centre'); return render(true);
    case 'ed-unmark': editor.removeMark(Number(el.dataset.mark)); return render(true);
    case 'ed-apply-redactions': {
      const n = editor.applyRedactions();
      if (n) showToast(`${n} redaction${n > 1 ? 's' : ''} applied`);
      return render(true);
    }
    /* Only the redact tool draws on the page, so every other tool leaves the click
       to the canvas itself. */
    case 'ed-canvas': {
      if (editor.state.tool !== 'redact') return;
      const box = el.getBoundingClientRect();
      editor.addMark(((event.clientX - box.left) / box.width) * 100, ((event.clientY - box.top) / box.height) * 100);
      return render(true);
    }
    case 'ed-save': editor.saved(); showToast(`${editor.state.pages.length} pages written`); return render(true);
    case 'ed-save-b': showToast(`${editor.state.bPages.length} pages written to ${editor.state.bName}`); return render(true);
    case 'ed-open-another': editor.openPair('Untitled — extras.pdf'); return render(true);
    case 'ed-close-pair': editor.closePair(); return render(true);
    case 'ed-move-right': editor.moveRight(); return render(true);
    case 'ed-copy-right': editor.moveRight({copy: true}); return render(true);
    case 'ed-move-left': editor.moveLeft(); return render(true);
    case 'ed-swap': editor.swapSides(); return render(true);

    /* creator */
    case 'cr-format': creator.chooseFormat(el.dataset.format);
      if (event.detail === 2) creator.toBuild();
      return render(true);
    case 'cr-continue': creator.toBuild(); return render(true);
    case 'cr-back': creator.toPick(); return render(true);
    case 'cr-sort': creator.cycleSort(); return render(true);
    case 'cr-move': creator.moveItem(Number(el.dataset.id), Number(el.dataset.delta)); return render(true);
    case 'cr-remove': creator.removeItem(Number(el.dataset.id)); return render(true);
    case 'cr-opt': creator.setValue(el.dataset.key, el.dataset.value); return render(true);
    case 'cr-toggle': creator.setValue(el.dataset.key, !creator.value(el.dataset.key)); return render(true);
    /* Destinations come from the folders the app already knows about, so the picker
       cycles real paths rather than invented ones. */
    case 'cr-dest': {
      const folders = outputFolders.length ? outputFolders : [outputFolder];
      creator.state.dest = folders[(folders.indexOf(creator.state.dest) + 1) % folders.length];
      return render(true);
    }
    case 'cr-recipe': creator.pickRecipe(el.dataset.id); return render(true);
    case 'cr-save-recipe': creator.saveRecipe(); showToast('Recipe saved'); return render(true);
    case 'cr-add': return creatorAddItems();
    case 'cr-create': return creatorCreate();
    case 'settings-tab': setTab = el.dataset.tab; setQuery = ''; setOpenSel = null; return render(true);
    case 'settings-toggle': { const row = setRow(el.dataset.id); if (row) setSetting(row.id, !settingValue(row)); return render(true); }
    case 'settings-menu': event.stopPropagation(); setOpenSel = setOpenSel === el.dataset.id ? null : el.dataset.id; return render(true);
    case 'settings-pick': event.stopPropagation(); setSetting(el.dataset.id, el.dataset.value); setOpenSel = null; return render(true);
    case 'settings-helper': setOpenHelper = setOpenHelper === el.dataset.helper ? null : el.dataset.helper; return render(true);
    case 'settings-copy': {
      event.stopPropagation();
      if (navigator.clipboard) await navigator.clipboard.writeText(el.dataset.command || '');
      setCopied = el.dataset.helper;
      if (setCopiedTimer) clearTimeout(setCopiedTimer);
      setCopiedTimer = setTimeout(() => { setCopied = null; setCopiedTimer = null; render(true); }, 1200);
      return render(true);
    }
    case 'settings-action': {
      const id = el.dataset.id;
      /* Clearing the list is a history delete of every record — the files it points
         at are never touched, only the entries that remember them. */
      if (id === 'clearRecent') {
        const ids = historyRecords.map(r => r.id);
        if (!ids.length) { showToast('No recent files to clear'); return; }
        return historyAction('/api/history/delete', {ids}, `${ids.length} removed from history`);
      }
      if (id === 'reset') { setVals = {}; writeSettings(); applyTheme(systemTheme()); showToast('Settings reset'); return render(true); }
      return;
    }
    case 'copy-command': if (navigator.clipboard) { await navigator.clipboard.writeText(el.dataset.command || ''); showToast('Command copied'); } return;
    case 'download-helper': {
      event.stopPropagation();
      installingHelper = el.dataset.name; render(true);
      try { await shell.downloadDependency({url: el.dataset.url, name: el.dataset.name}); showToast('Helper downloaded'); }
      catch (error) { showToast(error.message, false); }
      finally { installingHelper = null; render(true); }
      return;
    }
    case 'recheck': event.stopPropagation(); try { await api('/api/recheck'); showToast('Registry checked again'); } catch (e) { showToast(e.message, false); } return;
    case 'open-url': try { await api('/api/open-url', {url: el.dataset.url}); } catch (e) { showToast(e.message, false); } return;
    case 'close-archive': archivePromptId = null; archivePromptError = ''; return render(true);
    case 'unlock-archive': return unlockArchive();
    case 'history-filter': histFilter = el.dataset.filter; return render(true);
    case 'history-sort': { const order = Object.keys(SORTS); histSort = order[(order.indexOf(histSort) + 1) % order.length]; return render(true); }
    case 'select-history': return applyHistorySelection(event, el.dataset.id);
    case 'check-history': { event.stopPropagation(); return applyRowCheck(event, el.dataset.id); }
    case 'check-all': { event.stopPropagation(); const rows = visibleRows();
      const allOn = rows.length > 0 && rows.every(r => checked.has(r.id));
      rows.forEach(r => allOn ? checked.delete(r.id) : checked.add(r.id)); return render(true); }
    case 'history-deselect': checked.clear(); historyAnchorId = null; return render(true);
    case 'history-requeue': { const ids = checkedOfKind('history');
      if (ids.length) await historyAction('/api/history/requeue', {ids}, `${ids.length} queued again`);
      checked.clear(); historyAnchorId = null; return render(true); }
    case 'history-delete': { const queued = checkedOfKind('queue'), written = checkedOfKind('history');
      if (queued.length) await api('/api/remove-many', {ids: queued});
      if (written.length) await historyAction('/api/history/delete', {ids: written}, `${written.length} removed from history`);
      checked.clear(); historyAnchorId = null; selectedQueueIds = new Set(); queueAnchorId = null; return render(true); }
    case 'requeue-one': return historyAction('/api/history/requeue', {ids: [el.dataset.id]}, 'Queued again');
    case 'reveal-history': try { await api('/api/history/reveal', {path: el.dataset.path}); } catch (e) { showToast(e.message, false); } return;
    case 'close-sheet': sheetFor = null; return render(true);
    case 'sheet-category': sheetCat = el.dataset.category; return render(true);
    case 'sheet-pick': sheetPick = el.dataset.to; return render(true);
    case 'apply-sheet': { const f = sheetFile(); const t = tools.find(i => i.from === f?.from && i.to === sheetPick);
      if (f && t) { await chooseRoute(f, t.id); sheetFor = null; render(true); } return; }
    case 'close-palette': paletteOpen = false; return render(true);
    case 'palette-conversion': { const t = toolMap[el.dataset.id]; if (!t) return;
      page = 'convert'; const f = selectedFile();
      if (f && f.from === t.from) await chooseRoute(f, t.id);
      else showToast(`${t.label} is ${routeStateLabel(t).toLowerCase()}`, t.state === 'ready');
      paletteOpen = false; return render(true); }
    case 'palette-action': { const action = el.dataset.action; paletteOpen = false;
      if (action === 'add') { try { await api('/api/pick-files'); } catch (e) { showToast(e.message, false); } }
      else if (action === 'history') { setPage('convert'); historySlot.scrollIntoView({behavior:'smooth', block:'start'}); }
      else if (action === 'helpers') openSettings('helpers');
      else if (action === 'settings') openSettings();
      else setPage(action);
      return render(true); }
  }
});
