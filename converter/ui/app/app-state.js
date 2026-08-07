

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
