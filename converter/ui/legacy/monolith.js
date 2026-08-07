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


let tools=[], toolMap={}, files=[], counts={ready:0,helper:0,soon:0}, historyRecords=[];
let outputFolder='~/Converted', outputFolders=[];
let page='convert', selectedId=null, pickerFor=null, sheetFor=null, sheetPick=null, sheetCat=null, sheetQuery='';
/* The sidebar is not a thing you open — it is the detail of whatever is selected,
   so it appears when there is something to detail and leaves when there is not.
   Creator and Editor carry their own inspector, so the shared one stays away. */
/* The inspector is the app's one side panel, outside the workspace card. The
   Creator's output and recipes belong to it too, so they sit beside the
   workspace rather than inside it and its rounded corner. */
const inspectorHasContext = () =>
  (page === 'convert' && Boolean(selectedId || selectedHistory))
  || page === 'creator'
  || (page === 'editor' && editor.state.mode !== 'pair');
/* null preserves the selection-driven default. Alt+I sets an explicit user
   choice, including opening the batch sidebar before anything is selected. */
let inspectorOpen = null;
const inspectorVisible = () => inspectorOpen ?? inspectorHasContext();
let paletteOpen=false, query='', commandIndex=0;
let scope='this', advanced=true, keepNames=true, selectedHelper=null, selectedHistory=null;
let histFilter='all', histSort='newest', checked=new Set(), historyAnchorId=null;
let actionStatus='idle', toastTimer=null, lastSignature='';
let archivePromptId=null, archivePromptError='';
const archivePromptSeen = new Set();
let folderMenuState='closed', folderMenuTimer=null, contextTarget=null, contextMenuTimer=null;
let selectedQueueIds=new Set(), queueAnchorId=null;
const PANEL_WIDTH_STORAGE = 'one-tool.panel-width';
let panelWidth = 308, panelResizeSession = null;
/* Settings. The pane is app-wide preference, not per-document, so its values live
   in localStorage rather than in the backend's per-file state. Helpers is a
   category in here now; the installer list is still driven by the live registry. */
const SETTINGS_STORAGE = 'one-tool.settings';
const APP_VERSION = '3.2';
let settingsOpen=false, setTab='general', setQuery='', setVals={}, setOpenSel=null, setOpenHelper=null, setCopied=null;
let setCopiedTimer=null, installingHelper=null;
setVals = readSettings();
/* One-shot motion cues. Each set is filled when a real state transition is seen in
   absorb(), consumed by the next render, then cleared — so an unrelated re-render
   (selecting a row, opening a popover) never replays an entrance. */
let prevStatus = new Map(), prevCount = null, prevHelperDot = false, seenIds = new Set();
let freshRows = new Set(), freshDone = new Set(), freshError = new Set();
let countFresh = false, dotFresh = false, pendingAdd = false, bootstrapped = false;

const RANK = {ready:0, helper:1, soon:2};
const selectedFile = () => files.find(f => f.id === selectedId) || null;
function applyQueueSelection(event, id) {
  const result = OneToolSelectionState.updateSelection({
    ids: files.map(file => file.id), selected: [...selectedQueueIds], anchorId: queueAnchorId, targetId: id,
    shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey,
  });
  selectedQueueIds = new Set(result.selected);
  queueAnchorId = result.anchorId;
  selectedId = selectedQueueIds.has(id) ? id : [...selectedQueueIds][0] || null;
  pickerFor = null;
  selectedHistory = null;
  render(true);
}
/* Ticking a box is about the list, not about which kind of row it is, so the
   range a shift-click covers is the visible list in full. */
function applyRowCheck(event, id) {
  const rows = visibleRows();
  const result = OneToolSelectionState.updateSelection({
    ids: rows.map(row => row.id), selected: [...checked], anchorId: historyAnchorId, targetId: id,
    shift: event.shiftKey, toggle: true,
  });
  checked = new Set(result.selected);
  historyAnchorId = result.anchorId;
  render(true);
}
const checkedOfKind = kind => { const rows = convertRows(); return [...checked].filter(id => rows.find(row => row.id === id)?.kind === kind); };
function applyHistorySelection(event, id, forceToggle=false) {
  const rows = visibleHistory();
  const result = OneToolSelectionState.updateSelection({
    ids: rows.map(record => record.id), selected: [...checked], anchorId: historyAnchorId, targetId: id,
    shift: event.shiftKey, toggle: forceToggle || event.ctrlKey || event.metaKey,
  });
  checked = new Set(result.selected);
  historyAnchorId = result.anchorId;
  selectedHistory = id;
  selectedQueueIds = new Set(); queueAnchorId = null; selectedId = null;
  render(true);
}
const selectedTool = f => f ? toolMap[f.conv] : null;
const routeCandidates = f => tools.filter(t => t.from === f?.from).sort((a,b) => (RANK[a.state]??3)-(RANK[b.state]??3) || a.to.localeCompare(b.to));
const isBlocked = f => f?.status === 'error' && /isn.t installed|needs|helper/i.test(f.errorTitle || f.error || '');
const sameKind = f => files.filter(i => i.from === f.from);
const scopeLabel = f => {
  if (scope === 'this' || !f) return scope === 'this' ? 'This file' : 'All matching files';
  const n = sameKind(f).length;
  return n === 1 ? `The 1 ${f.from} file` : `All ${n} ${f.from} files`;
};
const helperNames = () => [...new Set(tools.flatMap(t => [t.helper?.name, ...(t.requirements||[]).map(r => r.name)]).filter(Boolean))];
const helperData = name => {
  const direct = tools.find(i => i.helper?.name === name)?.helper;
  if (direct) return direct;
  const requirement = tools.flatMap(i => i.requirements || []).find(i => i.name === name);
  return requirement || {name, why:`${name} is used by one or more converters.`, cmd:'', url:'', download:'', found:false};
};
const helperFound = name => Boolean(helperData(name).found);
const helperTools = name => tools.filter(t => t.helper?.name === name || t.requirements?.some(r => r.name === name));
const waitingOn = name => files.filter(f => toolMap[f.conv]?.helper?.name === name && isBlocked(f));
const destCount = () => new Set(tools.map(t => t.to)).size;
const commonFolder = () => { if (!files.length) return outputFolder || '~/Converted'; const raw = files[0].out || outputFolder || '~/Converted'; return raw.replace(/[\\/][^\\/]+$/, '') || outputFolder || '~/Converted'; };
const routeStateLabel = t => t.state === 'ready' ? 'Ready' : t.state === 'helper' ? 'Needs helper' : 'Not built yet';
const routeStateClass = t => t.state === 'ready' ? 'ready' : t.state === 'helper' ? 'helper' : '';

function readPanelWidth() {
  try {
    const stored = localStorage.getItem(PANEL_WIDTH_STORAGE);
    return OneToolPanelResize.clampPanelWidth(stored === null ? 308 : stored, window.innerWidth);
  } catch { return OneToolPanelResize.clampPanelWidth(308, window.innerWidth); }
}
/* One width for every inspector in the app — the Convert panel and the panes
   Creator and Editor carry — so dragging one does not leave the others disagreeing
   about how wide an inspector is. */
function setPanelWidth(next, persist=true) {
  panelWidth = OneToolPanelResize.clampPanelWidth(next, window.innerWidth);
  const collapsed = OneToolPanelResize.isPanelCollapsed(panelWidth);
  document.documentElement.style.setProperty('--panel-width', `${panelWidth}px`);
  panel.dataset.collapsed = String(collapsed);
  /* A closed panel has to stay findable: the app marks the state so the handle
     can move fully inside the window and show its edge. */
  document.getElementById('app').dataset.panel = panelWidth === 0 ? 'closed' : 'open';
  document.querySelectorAll('.wk-side').forEach(side => { side.dataset.collapsed = String(collapsed); });
  document.querySelectorAll('[data-panel-resize]').forEach(handle => {
    handle.setAttribute('aria-valuenow', String(panelWidth));
  });
  if (persist) {
    try { localStorage.setItem(PANEL_WIDTH_STORAGE, String(panelWidth)); } catch { /* storage may be unavailable */ }
  }
}
function startPanelResize(event) {
  if (event.button !== undefined && event.button !== 0) return;
  const handle = event.target.closest?.('[data-panel-resize]');
  if (!handle) return;
  event.preventDefault();
  panelResizeSession = {startX: event.clientX, startWidth: panelWidth};
  work.dataset.resizing = 'true';
  document.body.classList.add('is-resizing-panel');
  handle.setPointerCapture?.(event.pointerId);
}
function movePanelResize(event) {
  if (!panelResizeSession) return;
  setPanelWidth(OneToolPanelResize.widthFromDrag(
    panelResizeSession.startWidth,
    panelResizeSession.startX,
    event.clientX,
    window.innerWidth,
  ), false);
}
/* Dragged past the point where the pane blanks, it closes on release rather than
   leaving an unreadable strip of panel behind. Dragging the handle back out
   brings it straight back. */
function settlePanelWidth() {
  setPanelWidth(OneToolPanelResize.snapPanelWidth(panelWidth));
}
function finishPanelResize() {
  if (!panelResizeSession) return;
  panelResizeSession = null;
  work.dataset.resizing = 'false';
  document.body.classList.remove('is-resizing-panel');
  settlePanelWidth();
}

setPanelWidth(readPanelWidth(), false);
/* Creator and Editor rebuild their pane on every render, so their handle is a new
   element each time. Listening on the document keeps one wiring for all of them. */
document.addEventListener('pointerdown', startPanelResize);
document.addEventListener('keydown', event => {
  const handle = event.target.closest?.('[data-panel-resize]');
  if (!handle) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const step = event.key === 'ArrowRight' ? 16 : -16;
  // Opening a closed panel from the keyboard goes straight to the width where
  // it is readable, rather than stepping through widths that re-close it.
  setPanelWidth(panelWidth === 0 && step > 0 ? OneToolPanelResize.MIN_WIDTH : panelWidth + step);
  settlePanelWidth();
});
document.addEventListener('pointermove', movePanelResize);
document.addEventListener('pointerup', finishPanelResize);
document.addEventListener('pointercancel', finishPanelResize);
window.addEventListener('resize', () => setPanelWidth(panelWidth, false));

