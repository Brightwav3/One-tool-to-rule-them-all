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

/* ---------- server ---------- */
async function api(route, body, rerender=true) {
  const res = await fetch(route, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body || {})});
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
  if (rerender) absorb(data);
  return data;
}
function absorb(data) {
  if (Array.isArray(data.files)) files = data.files;
  if (typeof data.outputFolder === 'string' && data.outputFolder) outputFolder = data.outputFolder;
  if (Array.isArray(data.outputFolders)) outputFolders = data.outputFolders;
  if (data.counts) counts = data.counts;
  if (Array.isArray(data.tools)) setTools(data.tools);
  const fileIds = new Set(files.map(file => file.id));
  selectedQueueIds = new Set([...selectedQueueIds].filter(id => fileIds.has(id)));
  if (queueAnchorId && !fileIds.has(queueAnchorId)) queueAnchorId = null;
  if (selectedId && !files.some(f => f.id === selectedId)) selectedId = files[0]?.id || null;
  if (!selectedId && files.length) selectedId = files[0].id;
  noteTransitions();
  const passwordFile = files.find(f => f.status === 'error' && /password|encrypted|data error/i.test(`${f.errorTitle || ''} ${f.error || ''}`) && !archivePromptSeen.has(f.id));
  if (passwordFile) { archivePromptSeen.add(passwordFile.id); archivePromptId = passwordFile.id; archivePromptError = ''; }
  render();
}
function noteTransitions() {
  files.forEach((f, index) => {
    const before = prevStatus.get(f.id);
    // rows arriving — stagger the first six only
    if (!seenIds.has(f.id)) { seenIds.add(f.id); if (bootstrapped && index < 6) freshRows.add(f.id); }
    if (before !== undefined && before !== f.status) {
      if (f.status === 'done') { freshDone.add(f.id); }
      if (f.status === 'error' && !isBlocked(f)) { freshError.add(f.id); haptic([12, 40, 12]); }
    }
    prevStatus.set(f.id, f.status);
  });
  [...prevStatus.keys()].forEach(id => { if (!files.some(f => f.id === id)) { prevStatus.delete(id); seenIds.delete(id); } });

  if (prevCount !== null && prevCount !== files.length) countFresh = true;
  prevCount = files.length;

  const dot = counts.helper > 0;
  if (dot && !prevHelperDot) dotFresh = true;
  prevHelperDot = dot;

  if (pendingAdd && files.length) pendingAdd = false;

  // batch finished — every file settled, at least one written
  const settled = files.length && files.every(f => f.status === 'done' || f.status === 'error');
  const anyDone = files.some(f => f.status === 'done');
  const nextActionStatus = OneToolActionState.nextActionStatus(actionStatus, files);
  if (nextActionStatus !== actionStatus) {
    actionStatus = nextActionStatus;
  }
  if (settled && anyDone && !batchAnnounced) { batchAnnounced = true; haptic(18); showToast('Batch finished', true, commonFolder()); loadHistory(); }
  if (!settled) batchAnnounced = false;

  bootstrapped = true;
}
let batchAnnounced = false;
/* Haptics are used for exactly two events: a finished batch and an unreadable file. */
function haptic(pattern) { try { navigator.vibrate?.(pattern); } catch { /* unsupported */ } }
/* Containers build one file out of many and accept no dropped file, so they are
   kept out of the Convert view's routes entirely and handed to the Creator. */
let containers = [];
function setTools(list) {
  const all = list || [];
  containers = all.filter(t => t.multi);
  tools = all.filter(t => !t.multi);
  toolMap = byId(tools, 'id');
}
async function loadHistory() {
  try { const res = await fetch('/api/history'); const data = await res.json();
    historyRecords = Array.isArray(data.history) ? data.history : []; render(); }
  catch (error) { showToast(error.message, false); }
}

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

/* ---------- queue ---------- */
function chevron(size = 12, part = '') {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" ${STROKE}><path class="${part}" d="M4 6.5L8 10.5 12 6.5"/></svg>`;
}
/* The path is centred on the viewBox rather than drawn by eye: its bounding box
   runs 5–19 across and 7.15–16.85 down, so both midpoints land on 12 and the
   mark sits square inside the checkbox at every size. */
function tickIcon(size = 12, cls = '') {
  return `<svg class="ic ic-tick ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.05 L9.8 16.85 L19 7.15"/></svg>`;
}
/* Format is carried by a filled pill inside the page rather than by mono text
   scaled below the type ramp, and each family keeps its own token colour. */
function thumbKind(f) {
  if (f?.kind === 'image') return {label: 'IMG', tint: 'var(--success)', pages: false, photo: true};
  if (f?.kind === 'comic') return {label: 'CBZ', tint: 'var(--warning)', pages: true, photo: false};
  return {label: String(f?.from || 'FILE').toUpperCase().slice(0, 4), tint: 'var(--accent)', pages: (f?.units || 0) > 1, photo: false};
}
function fileThumb(f, cls = 'thumb') {
  const k = thumbKind(f);
  const back = k.pages ? `<rect class="ia-page2" x="5" y="5" width="34" height="48" rx="3" style="fill:var(--surface-sunken);stroke:var(--border-subtle)" stroke-width="1.2"/>` : '';
  const body = k.photo
    ? `<circle cx="13" cy="14" r="3.5" style="fill:var(--border-default)"/><path class="ia-drop" d="M4 30l8-9 7 8 5-4 11 10v10H4V30Z" style="fill:var(--border-default)" opacity=".55"/>`
    : `<path d="M8 12h20M8 18h20M8 24h13" style="stroke:var(--border-default)" stroke-width="1.4" stroke-linecap="round"/>`;
  const corner = k.pages || k.photo ? '' : `<path class="ia-corner" d="M27 1h1l7 7v1h-6a2 2 0 0 1-2-2V1Z" style="fill:var(--surface-sunken);stroke:var(--border-default)" stroke-width="1.2"/>`;
  return `<span class="${cls}" aria-hidden="true"><svg viewBox="0 0 44 56" role="img" aria-label="${esc(k.label)} file">
    ${back}
    <rect x="1" y="1" width="34" height="48" rx="3" style="fill:var(--surface-card);stroke:var(--border-default)" stroke-width="1.2"/>
    ${body}
    ${corner}
    <rect x="6" y="33" width="24" height="12" rx="2.5" style="fill:${k.tint}"/>
    <text x="18" y="42" text-anchor="middle" font-size="8" font-family="var(--font-mono)" style="fill:var(--text-inverse)">${esc(k.label)}</text>
  </svg></span>`;
}
function folderIcon(path, revealKind='queue') {
  const isOutput = revealKind === 'output' || revealKind === 'history';
  const label = isOutput ? 'Open output location' : 'Open source location';
  return `<button class="file-folder press" data-act="reveal-file" data-path="${esc(path || '')}" data-reveal-kind="${revealKind}" aria-label="${label}">
    <svg class="folder" width="48" height="48" viewBox="0 0 48 48" role="img" aria-label="Folder">
      <path d="M4 13a4 4 0 0 1 4-4h9.2a4 4 0 0 1 2.8 1.2L23 13h17a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V13Z" fill="#2563EB"/>
      <rect class="fdr-sheet" x="8" y="25" width="32" height="9" rx="1.5" fill="#EFF6FF"/>
      <path class="fdr-front" d="M4 17a4 4 0 0 1 4-4h32a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V17Z" fill="#3B82F6"/>
    </svg>
  </button>`;
}
function metaLine(f) {
  const bits = [];
  if (f.units > 1) bits.push(`${f.units} pages`);
  else if (f.kind === 'image') bits.push('image');
  const size = fmtSize(f.sourceSize || 0);
  if (size) bits.push(size);
  return bits.join(' · ');
}
function statusText(f) {
  if (isBlocked(f)) { const helper = (f.errorTitle || '').replace(/ isn't installed.*/i, '').trim(); return helper ? `needs ${helper}` : 'needs a helper'; }
  if (f.status === 'error') return f.errorTitle || 'could not convert';
  if (f.status === 'done') return `done · ${fmtSize(f.size)}`;
  if (f.status === 'running') return f.units ? `page ${Math.max(1, f.doneUnits || 1)} of ${f.units}` : 'working…';
  if (f.status === 'queued') return 'waiting';
  return 'ready';
}
function statusClass(f) { if (isBlocked(f)) return 'blocked'; if (f.status === 'error') return 'failed'; if (f.status === 'done') return 'done'; return ''; }
function pct(f) { if (f.status === 'done') return 100; if (!f.units) return 0; return Math.max(0, Math.min(100, Math.round((f.doneUnits || 0) / f.units * 100))); }

/* Shimmer marks work whose progress genuinely cannot be counted. Anywhere a real page
   count exists, the determinate bar carries the information instead. */
const indeterminate = f => f.status === 'running' && !f.units;
function skeletonHtml() {
  const widths = [['58%','34%'], ['46%','28%'], ['64%','38%'], ['52%','31%']];
  return `<div class="skel">${widths.map(([w1, w2], i) => `<div class="skel-row">
    <span class="skel-b pulse" style="width:34px;height:44px;border-radius:var(--radius-xs);animation-delay:${i * 60}ms"></span>
    <span style="flex:1;display:flex;flex-direction:column;gap:var(--space-2)">
      <i class="skel-b pulse" style="height:10px;width:${w1};animation-delay:${i * 60}ms"></i>
      <i class="skel-b pulse" style="height:9px;width:${w2};animation-delay:${i * 60 + 120}ms"></i></span>
    <span class="skel-b pulse" style="width:96px;height:26px;border-radius:var(--radius-pill);animation-delay:${i * 60 + 60}ms"></span>
    <span class="skel-b pulse" style="width:132px;height:10px;animation-delay:${i * 60 + 180}ms"></span>
  </div>`).join('')}</div>`;
}
function folderMenuHtml() {
  if (folderMenuState === 'closed') return '';
  const rows = outputFolders.map(folder => `
    <div class="path-row">
      <button class="path-pick press" data-act="select-folder" data-folder="${esc(folder)}" role="menuitem">
        <span class="check">${folder === outputFolder ? tickIcon(11) : ''}</span><span class="path-label" title="${esc(folder)}">${esc(folder)}</span>
      </button>
      <button class="forget-path press" data-act="forget-folder" data-folder="${esc(folder)}" aria-label="Remove ${esc(folder)} from recent folders">${ICON.remove}</button>
    </div>`).join('');
  return `<div id="folderMenu" class="path-menu t-dropdown ${folderMenuState === 'open' ? 'is-open' : 'is-closing'}" data-origin="top-right" role="menu" aria-hidden="${folderMenuState !== 'open'}">
    <span class="menu-title">Recent folders</span>
    ${rows || '<div class="path-empty">No saved folders yet.</div>'}
    <div class="path-foot"><button class="link press" data-act="folder">Choose another folder…</button></div>
  </div>`;
}
function destinationHtml() {
  const folder = commonFolder();
  return `<div class="dest">
    <button class="dest-trigger press" data-act="toggle-folder-menu" aria-haspopup="menu" aria-expanded="${folderMenuState === 'open'}">
      <span class="k">Save to</span><span class="v" title="${esc(folder)}">${esc(folder)}</span><span class="chev" aria-hidden="true">${chevron()}</span>
    </button>
    <button class="link press" data-act="folder">Change</button>
    ${folderMenuHtml()}
  </div>`;
}
function routePopover(f, open) {
  const candidates = routeCandidates(f);
  const body = candidates.length
    ? candidates.map(t => `<button class="opt press ${t.id === f.conv ? 'current' : ''}" data-act="choose-route" data-id="${esc(f.id)}" data-converter="${esc(t.id)}" ${t.state === 'soon' ? 'disabled' : ''}>
        <span class="ck">${t.id === f.conv ? tickIcon(11) : ''}</span><span class="nm">${esc(t.to)}</span><span class="st ${routeStateClass(t)}">${routeStateLabel(t)}</span></button>`).join('')
    : `<p style="margin:0;padding:var(--space-3);font-size:var(--text-sm);color:var(--text-tertiary)">No route from ${esc(f.from)}.</p>`;
  return `<span class="pop" data-open="${open}">
    <span class="pop-card">
      <span class="pop-title">Choose output format</span>
      <span class="pop-body">${body}</span>
      <span class="pop-foot"><span class="note">Only formats ${esc(f.from)} can become.</span><button class="btn btn-accent btn-sm press" data-act="open-sheet" data-id="${esc(f.id)}">Browse all ${destCount()}</button></span>
    </span>
    <span class="scope-card"><span class="eyebrow" style="flex:none">Scope</span><button class="scope press" data-act="cycle-scope">${esc(scopeLabel(f))}<span class="chev" aria-hidden="true">${chevron()}</span></button></span>
  </span>`;
}

