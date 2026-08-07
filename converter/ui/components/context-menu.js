function contextItem(label, action, icon, options={}) {
  return `<button class="ctx-item ${options.danger ? 'danger' : ''}" data-context-act="${action}" ${options.disabled ? 'disabled' : ''} role="menuitem">
    <span class="ctx-icon" aria-hidden="true">${icon}</span><span>${label}</span>
  </button>`;
}
function contextItems(target) {
  if (target.type === 'queue-file') return [
    contextItem('Select file', 'select-queue', ICON.select),
    contextItem('Rename output…', 'rename-queue', ICON.rename, {disabled: target.status === 'queued' || target.status === 'running'}),
    contextItem('Change output format', 'route-queue', ICON.route, {disabled: target.status === 'queued' || target.status === 'running'}),
    contextItem('Show input in Explorer', 'reveal-source', ICON.reveal, {disabled: !target.sourcePath}),
    contextItem('Show output in Explorer', 'reveal-queue-output', ICON.reveal, {disabled: !target.out || target.status !== 'done'}),
    contextItem('Copy source path', 'copy-source', ICON.copy, {disabled: !target.sourcePath}),
    '<div class="ctx-sep" role="separator"></div>',
    contextItem(target.ids.length > 1 ? `Remove ${target.ids.length} files from queue` : 'Remove from queue', 'remove-queue', ICON.remove, {danger: true}),
  ];
  if (target.type === 'history-file') return [
    contextItem('Select output', 'select-history', ICON.select),
    contextItem('Rename file…', 'rename-history', ICON.rename, {disabled: target.state === 'missing'}),
    contextItem('Show input in Explorer', 'reveal-history-input', ICON.reveal, {disabled: !target.sourcePath}),
    contextItem('Show output in Explorer', 'reveal-output', ICON.reveal, {disabled: target.state === 'missing'}),
    contextItem('Copy output path', 'copy-output', ICON.copy, {disabled: !target.outputPath}),
    contextItem(target.ids.length > 1 ? `Convert ${target.ids.length} again` : 'Convert again', 'requeue-history', ICON.again, {disabled: !target.sourcePath}),
    '<div class="ctx-sep" role="separator"></div>',
    contextItem(target.ids.length > 1 ? `Delete ${target.ids.length} from history` : 'Delete from history', 'delete-history', ICON.remove, {danger: true}),
  ];
  return [
    contextItem('Select helper', 'select-helper', ICON.select),
    contextItem('Check again', 'recheck-helper', ICON.again),
    target.url ? contextItem('Open official page', 'open-helper-url', ICON.external) : '',
  ].filter(Boolean);
}
function contextTargetFromRow(row, x, y) {
  const type = row.dataset.context;
  if (type === 'queue-file') {
    const file = files.find(item => item.id === row.dataset.id);
    return file && {...file, type, ids: [...selectedQueueIds], x, y};
  }
  if (type === 'history-file') {
    const record = historyRecords.find(item => item.id === row.dataset.id);
    return record && {...record, type, ids: [...checked], state: histState(record), x, y};
  }
  const name = row.dataset.helper;
  const data = helperData(name);
  return {type, name, url: data.url || '', x, y};
}
function renderContextMenu() {
  if (!contextTarget) return;
  const label = contextTarget.type === 'helper' ? contextTarget.name : contextTarget.name || contextTarget.sourceName || contextTarget.outputPath || 'File';
  contextMenu.innerHTML = `<div class="ctx-label" title="${esc(label)}">${esc(label)}</div>${contextItems(contextTarget).join('')}`;
  contextMenu.setAttribute('aria-hidden', 'false');
}
function openContextMenu(event, row) {
  closeFolderMenu(false);
  /* cancel a fade still running from the last menu, or it will hide this one */
  if (contextMenuTimer) { clearTimeout(contextMenuTimer); contextMenuTimer = null; }
  contextMenu.classList.remove('is-closing');
  contextMenu.setAttribute('aria-hidden', 'false');
  if (row.dataset.context === 'queue-file') {
    if (!selectedQueueIds.has(row.dataset.id)) {
      selectedQueueIds = new Set([row.dataset.id]);
      queueAnchorId = row.dataset.id;
    }
    selectedId = row.dataset.id;
  }
  if (row.dataset.context === 'history-file') {
    if (!checked.has(row.dataset.id)) {
      checked = new Set([row.dataset.id]);
      historyAnchorId = row.dataset.id;
    }
    selectedHistory = row.dataset.id;
  }
  contextTarget = contextTargetFromRow(row, event.clientX, event.clientY);
  if (!contextTarget) return;
  if (contextTarget.type === 'queue-file') contextTarget.ids = [...selectedQueueIds];
  if (contextTarget.type === 'history-file') contextTarget.ids = [...checked];
  if (contextTarget.type === 'helper') selectedHelper = contextTarget.name;
  render(true);
  renderContextMenu();
  contextMenu.style.left = `${event.clientX}px`;
  contextMenu.style.top = `${event.clientY}px`;
  contextMenu.classList.remove('is-closing');
  requestAnimationFrame(() => {
    const gap = 8;
    contextMenu.style.left = `${Math.max(gap, Math.min(event.clientX, window.innerWidth - contextMenu.offsetWidth - gap))}px`;
    contextMenu.style.top = `${Math.max(gap, Math.min(event.clientY, window.innerHeight - contextMenu.offsetHeight - gap))}px`;
    contextMenu.classList.add('is-open');
  });
}
function closeContextMenu(animate=true) {
  if (!contextTarget) return;
  if (contextMenuTimer) clearTimeout(contextMenuTimer);
  contextMenu.classList.remove('is-open');
  /* The menu is closed the moment it is asked to close; only the fade is left
     on a timer. Holding the target until the timer fired meant a right-click
     during the fade reopened the menu and was then torn down by the old timer. */
  contextTarget = null;
  if (!animate) {
    contextMenu.classList.remove('is-closing');
    contextMenu.setAttribute('aria-hidden', 'true');
    return;
  }
  contextMenu.classList.add('is-closing');
  contextMenuTimer = setTimeout(() => {
    contextMenu.classList.remove('is-closing');
    contextMenu.setAttribute('aria-hidden', 'true');
    contextMenuTimer = null;
  }, dropdownCloseMs());
}
async function handleContextAction(action, target) {
  if (!target) return;
  if (action === 'select-queue' || action === 'route-queue') {
    selectedId = target.id; selectedHistory = null; pickerFor = action === 'route-queue' ? target.id : null; return render(true);
  }
  if (action === 'rename-queue') return startRename(target.id);
  if (action === 'reveal-source') return api('/api/reveal', {path: target.sourcePath}, false);
  if (action === 'reveal-queue-output') return api('/api/reveal', {path: target.out}, false);
  if (action === 'copy-source') return copyText(target.sourcePath, 'Source path copied');
  if (action === 'remove-queue') { selectedQueueIds = new Set(); queueAnchorId = null; return api('/api/remove-many', {ids: target.ids}); }
  if (action === 'rename-history') return startHistoryRename(target.id);
  if (action === 'select-history') { selectedHistory = target.id; selectedId = null; selectedQueueIds = new Set(); queueAnchorId = null; return render(true); }
  if (action === 'reveal-history-input') return api('/api/reveal', {path: target.sourcePath}, false);
  if (action === 'reveal-output') return api('/api/history/reveal', {path: target.outputPath}, false);
  if (action === 'copy-output') return copyText(target.outputPath, 'Output path copied');
  if (action === 'requeue-history') { const ids = target.ids; checked.clear(); historyAnchorId = null; return historyAction('/api/history/requeue', {ids}, `${ids.length} queued again`); }
  if (action === 'delete-history') { const ids = target.ids; checked.clear(); historyAnchorId = null; return historyAction('/api/history/delete', {ids}, `${ids.length} removed from history`); }
  if (action === 'select-helper') { setOpenHelper = target.name; return openSettings('helpers'); }
  if (action === 'recheck-helper') return api('/api/recheck');
  if (action === 'open-helper-url') return api('/api/open-url', {url: target.url}, false);
}
