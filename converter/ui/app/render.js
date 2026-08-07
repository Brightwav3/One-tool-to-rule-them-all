/* ---------- render ---------- */
function signature() {
  return JSON.stringify([page, selectedId, inspectorVisible(), pickerFor, sheetFor, sheetPick, sheetCat, sheetQuery, paletteOpen, query, commandIndex,
    scope, advanced, keepNames, selectedHelper, selectedHistory, histFilter, histSort, [...checked], [...selectedQueueIds], queueAnchorId, historyAnchorId, actionStatus, outputFolder, outputFolders, folderMenuState,
    pendingAdd, countFresh, dotFresh, [...freshRows], [...freshDone], [...freshError],
    files.map(f => [f.id, f.name, f.from, f.to, f.conv, f.status, f.units, f.doneUnits, f.size, f.sourceSize, f.errorTitle, JSON.stringify(f.opts||{})]),
    tools.map(t => [t.id, t.state, t.helper?.found]), counts,
    historyRecords.map(r => [r.id, r.state, r.presence, r.size])]);
}
function render(force=false) {
  const next = signature();
  if (!force && next === lastSignature) return;
  // never rebuild the pane out from under a field the user is typing in
  const active = document.activeElement;
  const typing = active && (active.tagName === 'INPUT') && active.dataset.live === 'true';
  if (typing && !force) { lastSignature = next; return; }
  lastSignature = next;

  document.querySelectorAll('.navbtn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $('settingsBtn').setAttribute('aria-expanded', String(settingsOpen));
  const dotEl = $('helperDot');
  dotEl.hidden = !(counts.helper > 0);
  dotEl.classList.toggle('is-fresh', dotFresh);
  Object.entries(pages).forEach(([key, el]) => el.dataset.active = String(key === page));
  const panelVisible = inspectorVisible();
  panel.dataset.open = String(panelVisible);
  document.getElementById('app').dataset.inspector = String(panelVisible);
  /* Nothing to resize when there is no panel, so the handle goes with it. */
  if (panelResizeHandle) panelResizeHandle.hidden = !panelVisible;

  renderConvert(); renderCreator(); renderEditor(); renderSettings(); renderPanel(); renderOverlays();
  /* The panes were just rebuilt, so hand them the current width and collapse state. */
  setPanelWidth(panelWidth, false);
  renderShortcutLabels();
  // the cues have now been painted; clear them so nothing replays on the next render
  freshRows.clear(); freshDone.clear(); freshError.clear();
  countFresh = false; dotFresh = false;
}

