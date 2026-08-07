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

/* ---------- editor ----------
   Grid, reader and pair, off one page model. Page bodies are placeholder rules until
   a backend can render real pages; every other value on screen is live state. */
const editor = OneToolEditorState.createEditorState({name: 'Untitled.pdf'});
/* Entrances belong to arriving, not to existing. Both screens rebuild their whole
   pane on every state change, so without this gate every click would replay the
   view's entrance and the screen would read as reloading. The helper returns its
   class only on the render that actually changed the view. */
let editorView = null, creatorView = null, settingsView = null;
let editorEntering = false, creatorEntering = false, settingsEntering = false;
let selbarShown = false, openMenuSeen = null, openHelperSeen = null;
const seenMarks = new Set(), seenEdits = new Set();
const enterEditor = cls => editorEntering ? cls : '';
const enterCreator = cls => creatorEntering ? cls : '';
const lineStyle = (line, big) => `width:${line.w};height:${line.head ? (big ? '8px' : '5px') : (big ? '4px' : '3px')};background:${line.head ? 'rgba(60,60,67,.34)' : 'var(--ink)'}`;
const isRotated = page => (((page.rot % 360) + 360) % 360) !== 0;
function pageCaption(page, index) {
  const rotated = isRotated(page);
  return `${index + 1}${rotated ? ' · rotated' : page.kind === 'Blank' ? ' · blank' : ''}`;
}
/* A rotated page keeps the cell it was given: it turns, and trades width for height
   so the long edge still fits. */
function thumbHtml(page, index, on, dim, act) {
  const rotated = isRotated(page);
  return `<button class="pthumb press" data-act="${act}" data-id="${page.id}" data-on="${on}" data-dim="${dim}">
    <span class="pthumb-box"><span class="pg" style="width:${rotated ? '138%' : '100%'};height:${rotated ? '72%' : '100%'};transform:rotate(${page.rot}deg)">
      ${page.lines.map(l => `<span class="ln" style="${lineStyle(l, false)}"></span>`).join('')}
    </span></span>
    <span class="tcap">${esc(pageCaption(page, index))}</span>
  </button>`;
}
/* Marks and edits animate in once, on the render that first shows them. Recording
   them after the paint is what keeps a later click from replaying the arrival. */
function rememberEditorMotion() {
  editor.state.pages.forEach(p => p.marks.forEach(m => seenMarks.add(m.id)));
  editor.state.edits.forEach(e => seenEdits.add(e.id));
}
function renderEditor() {
  const s = editor.state;
  /* The tool is part of the view: switching to Redact swaps the whole right pane,
     which is an arrival. Stepping pages or selecting is not. */
  const key = s.mode + ':' + (s.mode === 'reader' ? s.tool : '');
  editorEntering = editorView !== key;
  editorView = key;
  try { return renderEditorView(s); } finally { rememberEditorMotion(); }
}
function renderEditorView(s) {
  if (s.mode === 'pair') return renderEditorPair();
  const selIds = editor.selectedIds();
  const reader = s.mode === 'reader';
  // Like the Creator, the pane goes to the app's side panel — outside the
  // workspace card, so it does not run past its corner.
  pages.editor.innerHTML = `
    <div class="wk-row">
      ${reader ? editorRailHtml() : ''}
      <div class="wk-plain">
        ${reader ? editorReaderHtml() : editorGridHtml(selIds)}
      </div>
    </div>
    ${s.dragging ? editorDropHtml() : ''}`;
}
function renderEditorPanel() {
  const s = editor.state;
  panelBody.innerHTML = s.mode === 'pair' ? '' : `<div class="wk-side" data-inline="true" style="padding:14px 16px 12px;gap:14px">
      ${s.mode === 'reader' ? editorReaderPaneHtml() : editorGridPaneHtml()}
    </div>`;
}
function editorRailHtml() {
  return `<div class="ed-rail ${enterEditor("m-fade")}">
    ${editor.TOOLS.map(t => `<button class="tool press" data-act="ed-tool" data-tool="${t.id}" data-on="${t.id === editor.state.tool}" title="${esc(t.label)}" aria-label="${esc(t.label)}">${t.glyph}</button>`).join('')}
    <span class="ed-railrule"></span>
    <button class="tool press" data-act="ed-rotate" data-deg="-90" title="Rotate left" aria-label="Rotate left">↺</button>
    <button class="tool press" data-act="ed-rotate" data-deg="90" title="Rotate right" aria-label="Rotate right">↻</button>
  </div>`;
}
function editorGridHtml(selIds) {
  const s = editor.state;
  /* The bar fades in when a selection starts, not on every change to it. */
  const selbarEnter = selIds.length && !selbarShown ? ' m-fade' : '';
  selbarShown = selIds.length > 0;
  const header = selIds.length ? `
    <div class="ed-selbar${selbarEnter}">
      <span class="n">${selIds.length} page${selIds.length === 1 ? '' : 's'} selected</span>
      <span class="rule"></span>
      <button class="pbtn gh press" data-act="ed-rotate" data-deg="-90" style="color:var(--acc-text)">Rotate left</button>
      <button class="pbtn gh press" data-act="ed-rotate" data-deg="90" style="color:var(--acc-text)">Rotate right</button>
      <button class="pbtn gh press" data-act="ed-extract" style="color:var(--acc-text)">Extract to new PDF</button>
      <button class="pbtn gh press" data-act="ed-insert" style="color:var(--acc-text)">Insert after</button>
      <span style="flex:1"></span>
      <button class="pbtn gh press" data-act="ed-delete" style="color:var(--dang-t)">Delete</button>
      <button class="press" data-act="ed-deselect" style="font:500 12px var(--ui);color:var(--acc-text)">Deselect</button>
    </div>` : `
    <div class="ed-head">
      <div style="flex:1;min-width:0"><h1 class="wk-h1">${esc(s.name)}</h1></div>
      <span style="font-size:12px;color:var(--t3)">Click a page, then <span class="kbd" data-shortcut="reader">${shortcutLabel('reader')}</span> to open it</span>
      <button class="pbtn press" data-act="ed-select-all">Select all</button>
      <button class="pbtn press" data-act="ed-open-another">Open another</button>
    </div>`;
  const footerBits = [`${s.pages.length} pages`];
  if (selIds.length) footerBits.push(`${selIds.length} selected`);
  footerBits.push(s.edits.length ? `${s.edits.length} edits not saved` : 'no unsaved edits');
  return `${header}
    <div class="${enterEditor("m-grid")}" style="flex:1;min-height:0;overflow:auto;padding:16px 18px">
      <div class="ed-grid">
        ${s.pages.map((p, i) => thumbHtml(p, i, Boolean(s.sel[p.id]), selIds.length > 0 && !s.sel[p.id], 'ed-page')).join('')}
        <button class="pthumb press" data-act="ed-insert"><span class="pthumb-add">+</span><span class="tcap">Insert</span></button>
      </div>
    </div>
    <div class="ed-foot">
      <span style="flex:1;font-size:12.5px;color:var(--t2)">${esc(footerBits.join(' · '))}</span>
      <button class="pbtn press ${s.edits.length ? '' : 'off'}" data-act="ed-revert" style="box-shadow:none;font-weight:500">Revert</button>
      <button class="pbtn press" data-act="ed-save" data-copy="true">Save a copy</button>
      <button class="pbtn pri press" data-act="ed-save">Save<span class="kbd" data-shortcut="save" style="background:none;opacity:.7">${shortcutLabel('save')}</span></button>
    </div>`;
}
function editorReaderHtml() {
  const s = editor.state;
  const page = editor.current();
  const index = editor.currentIndex();
  const tool = editor.TOOLS.find(t => t.id === s.tool) || editor.TOOLS[0];
  if (!page) return `<div class="page-empty">This document has no pages left.</div>`;
  return `<div class="ed-toolbar ${enterEditor("m-fade")}">
      <span class="pchip" style="background:var(--acc-tint);color:var(--acc-text)">${esc(tool.label)}</span>
      <span style="flex:1;min-width:0;font-size:12px;color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(tool.help)}</span>
      <button class="pbtn gh press" data-act="ed-step" data-delta="-1" aria-label="Previous page">‹</button>
      <span class="ed-num" style="min-width:104px">Page ${index + 1} of ${s.pages.length}</span>
      <button class="pbtn gh press" data-act="ed-step" data-delta="1" aria-label="Next page">›</button>
      <span class="rule"></span>
      <button class="pbtn gh press" data-act="ed-zoom" data-delta="-16" aria-label="Zoom out">−</button>
      <span class="ed-num" style="min-width:38px">${s.zoom}%</span>
      <button class="pbtn gh press" data-act="ed-zoom" data-delta="16" aria-label="Zoom in">+</button>
      <span class="rule"></span>
      <button class="pbtn gh press" data-act="ed-grid" style="color:var(--acc-text);font-weight:600">All pages<span class="kbd" data-shortcut="reader">${shortcutLabel('reader')}</span></button>
    </div>
    <div class="ed-canvaswrap">
      <button class="pg ed-canvas ${enterEditor("m-zoom")}" data-act="ed-canvas" data-redact="${s.tool === 'redact'}" style="width:${Math.round(392 * s.zoom / 96)}px;transform:rotate(${page.rot}deg)">
        ${page.lines.map(l => `<span class="ln" style="${lineStyle(l, true)}"></span>`).join('')}
        ${page.marks.map(m => `<span class="ed-mark${seenMarks.has(m.id) ? "" : " m-fade"}" style="left:${m.x}%;top:${m.y}%;width:${m.w}%;height:${m.h}%"></span>`).join('')}
        <span class="ed-pageno">${index + 1}</span>
      </button>
    </div>
    <div class="ed-strip ${enterEditor("m-fade")}">
      ${s.pages.map((p, i) => `<button class="strip press" data-act="ed-open" data-id="${p.id}" data-on="${p.id === s.focus}" aria-label="Page ${i + 1}">
        ${p.lines.slice(0, 3).map(l => `<span class="ln" style="width:${l.w}"></span>`).join('')}
      </button>`).join('')}
    </div>`;
}
function editorGridPaneHtml() {
  const s = editor.state;
  return `<div class="${enterEditor("m-up")}" style="display:flex;align-items:flex-start;gap:10px">
      <span class="ptile acc" style="width:30px;height:38px;font-size:7px">PDF</span>
      <div style="flex:1;min-width:0">
        <div style="font:600 13px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</div>
        <div style="font:400 11.5px var(--mono);color:var(--t3)">${s.pages.length} pages · 402 MB</div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:7px">
      <span class="eyebrow-p">Document</span>
      <div class="pkv"><span class="k">Page size</span><span class="v">168 × 258 mm</span></div>
      <div class="pkv"><span class="k">PDF version</span><span class="v">1.7</span></div>
      <div class="pkv"><span class="k">Text layer</span><span class="v" style="color:${s.ocr ? 'var(--ok-t)' : 'var(--warn-t)'}">${s.ocr ? 'searchable' : 'none'}</span></div>
      <div class="pkv"><span class="k">Security</span><span class="v">open</span></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <span class="eyebrow-p">Whole document</span>
      <button class="pbtn press" data-act="ed-ocr" style="justify-content:space-between">Add OCR text layer<span class="pchip" style="background:${s.ocr ? 'var(--ok-tint)' : 'var(--warn-tint)'};color:${s.ocr ? 'var(--ok-t)' : 'var(--warn-t)'}">${s.ocr ? 'Done' : 'Needs Tesseract'}</span></button>
      <button class="pbtn press" data-act="ed-compress" style="justify-content:space-between">Compress images<span style="font:400 11px var(--mono);color:var(--t3)">−38%</span></button>
      <button class="pbtn press" data-act="ed-numbers" style="justify-content:space-between">Add page numbers</button>
    </div>
    <div class="ed-edits">
      <span class="eyebrow-p">Edits</span>
      ${s.edits.length
        ? s.edits.map(e => `<div class="ed-edit ${seenEdits.has(e.id) ? "" : "m-up"}"><span class="d"></span><span class="t">${esc(e.text)}</span></div>`).join('')
        : '<div style="font-size:12px;color:var(--t3)">Nothing changed yet.</div>'}
    </div>`;
}
function editorReaderPaneHtml() {
  const s = editor.state;
  const page = editor.current();
  const index = editor.currentIndex();
  const tool = editor.TOOLS.find(t => t.id === s.tool) || editor.TOOLS[0];
  const marks = page ? page.marks : [];
  const total = editor.totalMarks();
  const head = `<div class="${enterEditor("m-up")}"><div style="font-size:13.5px;font-weight:600">${esc(tool.label)}</div>
    <div style="font-size:12px;color:var(--t3);margin-top:2px">${s.tool === 'redact'
      ? `${marks.length} on this page · ${total} in the document`
      : `Page ${index + 1} of ${s.pages.length}`}</div></div>`;
  if (s.tool === 'redact') {
    const scopes = ['This page', `All ${s.pages.length}`];
    return `${head}
      <div style="display:flex;flex-direction:column;gap:6px">
        <span class="eyebrow-p">Marks on page ${index + 1}</span>
        ${marks.length
          ? marks.map(m => `<div class="ed-mark-row ${seenMarks.has(m.id) ? "" : "m-up"}"><span class="ed-mark-sw"></span><span style="flex:1;font-size:12px">Block, ${Math.round(m.w * 3.9)} × ${Math.round(m.h * 7)}</span><button class="press" data-act="ed-unmark" data-mark="${m.id}" style="color:var(--t4);font-size:13px" aria-label="Remove block">×</button></div>`).join('')
          : '<div class="ed-empty-marks">Click anywhere on the page to drop a redaction block.</div>'}
        <span style="font-size:11px;line-height:1.5;color:var(--t3)">Applying removes the underlying text and images permanently. This can't be undone after saving.</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <span class="eyebrow-p">Apply to</span>
        <div class="pseg">${scopes.map(n => `<button class="press" data-act="ed-scope" data-scope="${esc(n)}" data-on="${s.scope === n}">${esc(n)}</button>`).join('')}</div>
      </div>
      <div style="margin-top:auto;display:flex;flex-direction:column;gap:7px">
        <button class="pbtn pri press ${total ? '' : 'off'}" data-act="ed-apply-redactions" style="justify-content:center">${total ? `Apply ${total} redaction${total > 1 ? 's' : ''}` : 'Nothing to apply'}</button>
      </div>`;
  }
  return `${head}
    <div style="display:flex;flex-direction:column;gap:7px">
      <span class="eyebrow-p">This page</span>
      <div class="pkv"><span class="k">Kind</span><span class="v">${esc(page ? page.kind : '—')}</span></div>
      <div class="pkv"><span class="k">Rotation</span><span class="v">${page ? (((page.rot % 360) + 360) % 360) : 0}°</span></div>
      <div class="pkv"><span class="k">Text</span><span class="v" style="color:${page && page.text === 'Selectable' ? 'var(--ok-t)' : 'var(--warn-t)'}">${esc(page ? page.text : '—')}</span></div>
      <div class="pkv"><span class="k">Size</span><span class="v">${esc(page ? page.size : '—')}</span></div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px">
      <span class="eyebrow-p">Page actions</span>
      <button class="pbtn press" data-act="ed-rotate" data-deg="90" style="justify-content:space-between">Rotate right<span class="kbd">R</span></button>
      <button class="pbtn press" data-act="ed-extract" style="justify-content:space-between">Extract this page</button>
      <button class="pbtn press" data-act="ed-delete" style="justify-content:space-between;color:var(--dang-t)">Delete page<span class="kbd">⌫</span></button>
    </div>
    <div style="margin-top:auto;padding-top:12px;border-top:1px solid var(--sep);font-size:11px;line-height:1.5;color:var(--t3)">Press <span class="kbd" data-shortcut="reader">${shortcutLabel('reader')}</span> to go back to all pages. Arrow keys move between pages.</div>`;
}
function renderEditorPair() {
  const s = editor.state;
  const selIds = editor.selectedIds();
  const bSelIds = editor.bSelectedIds();
  pages.editor.innerHTML = `
    <div class="wk-row">
      <div class="wk-card ${enterEditor("m-left")}" style="flex:1;margin:0 4px 8px 8px">
        <div style="flex:none;display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--sep)">
          <span class="ptile acc" style="width:24px;height:30px;font-size:6px">PDF</span>
          <div style="flex:1;min-width:0">
            <div style="font:600 12.5px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</div>
            <div style="font:400 11px var(--mono);color:var(--t3)">${s.pages.length} pages · ${selIds.length} selected</div>
          </div>
        </div>
        <div style="flex:1;min-height:0;overflow:auto;padding:14px;background:var(--bg)">
          <div class="ed-pairgrid">${s.pages.map((p, i) => thumbHtml(p, i, Boolean(s.sel[p.id]), selIds.length > 0 && !s.sel[p.id], 'ed-page')).join('')}</div>
        </div>
        <div style="flex:none;display:flex;align-items:center;gap:12px;padding:10px 14px;border-top:1px solid var(--sep)">
          <span style="flex:1;font-size:12px;color:var(--t2)">402 MB · ${s.edits.length ? `${s.edits.length} edits` : 'no edits'}</span>
          <button class="pbtn press" data-act="ed-save">Save</button>
        </div>
      </div>
      <div class="ed-mid ${enterEditor("m-fade")}">
        <button class="pbtn press ${selIds.length ? '' : 'off'}" data-act="ed-move-right" style="background:var(--surface)">Move →</button>
        <button class="pbtn press ${bSelIds.length ? '' : 'off'}" data-act="ed-move-left" style="background:var(--surface)">← Move</button>
        <button class="pbtn gh press ${selIds.length ? '' : 'off'}" data-act="ed-copy-right" style="font-size:11.5px;color:var(--t3)">Copy →</button>
        <span class="rule"></span>
        <button class="pbtn gh press" data-act="ed-swap" style="font-size:11.5px;color:var(--t3)">Swap sides</button>
        <button class="pbtn gh press" data-act="ed-close-pair" style="font-size:11.5px;color:var(--t3)">Close</button>
        <span class="hint">Select pages on either side</span>
      </div>
      <div class="wk-card ${enterEditor("m-right")}" style="flex:1;margin:0 8px 8px 4px">
        <div style="flex:none;display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:1px solid var(--sep)">
          <span class="ptile" style="width:24px;height:30px;font-size:6px">PDF</span>
          <div style="flex:1;min-width:0">
            <div style="font:600 12.5px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.bName || '')}</div>
            <div style="font:400 11px var(--mono);color:var(--t3)">${s.bPages.length} pages · ${bSelIds.length} selected</div>
          </div>
        </div>
        <div style="flex:1;min-height:0;overflow:auto;padding:14px;background:var(--bg)">
          <div class="ed-pairgrid">
            ${s.bPages.map((p, i) => thumbHtml(p, i, Boolean(s.bSel[p.id]), bSelIds.length > 0 && !s.bSel[p.id], 'ed-bpage')).join('')}
            ${selIds.length ? `<div class="pthumb"><span class="ed-drop">${selIds.length} pages</span><span class="tcap" style="color:var(--acc-text)">move</span></div>` : ''}
          </div>
        </div>
        <div style="flex:none;display:flex;align-items:center;gap:12px;padding:10px 14px;border-top:1px solid var(--sep)">
          <span class="cr-path">${esc(`${outputFolder}/${s.bName || ''}`)}</span>
          <button class="pbtn pri press" data-act="ed-save-b">Save as new file</button>
        </div>
      </div>
    </div>
    ${s.dragging ? editorDropHtml() : ''}`;
}
function editorDropHtml() {
  return `<div class="ed-dropover"><div class="ed-dropcard m-up">
    <span class="ptile acc" style="width:52px;height:64px;border-radius:5px;font-size:10px;padding-bottom:6px">PDF</span>
    <span style="font-size:13.5px;font-weight:600">Drop to open beside this one</span>
    <span style="font-size:12px;color:var(--t2)">Both files stay open. Move pages between them.</span>
  </div></div>`;
}

/* ---------- creator ----------
   Format first: the container you pick decides the unit, the options and whether a
   helper is missing. Items are ordered explicitly, because the order is the output. */
const creator = OneToolCreatorState.createCreatorState({name: 'Untitled', dest: '~/Converted'});
const crFmtSize = OneToolCreatorState.fmtSize;
function installedHelpers() { return Object.fromEntries(helperNames().map(name => [name, helperFound(name)])); }
function renderCreator() {
  const s = creator.state;
  creatorEntering = creatorView !== s.stage;
  creatorView = s.stage;
  // The card fills the workspace; the output and recipes are rendered into the
  // app's side panel by renderCreatorPanel, the same place Convert puts its
  // inspector.
  pages.creator.innerHTML = `
    <div class="wk-row">
      <div class="wk-plain">
        ${s.stage === 'pick' ? creatorPickHtml() : creatorBuildHtml()}
      </div>
    </div>`;
}
function renderCreatorPanel() {
  const s = creator.state;
  panelBody.innerHTML = `<div class="wk-side" data-inline="true" style="padding:12px 16px 12px 14px;gap:14px">
      ${s.stage === 'build' ? creatorOutputHtml() : ''}
      ${creatorRecipesHtml()}
    </div>`;
}
function creatorPickHtml() {
  const s = creator.state;
  const q = s.query.trim().toLowerCase();
  const match = f => !q || `${f.id} ${f.title} ${f.desc}`.toLowerCase().includes(q);
  const groups = creator.GROUPS.map(g => ({name: g.name, items: g.items.filter(match)})).filter(g => g.items.length);
  return `<div class="cr-pickhead">
      <div style="flex:1;min-width:0">
        <h1 class="wk-h1">What are you making?</h1>
        <p class="wk-sub">Pick a container. Everything after that depends on it.</p>
      </div>
      <div class="inp" style="width:210px"><span style="font-size:11px;color:var(--t3)">&#8981;</span><input id="crQuery" data-live="true" value="${esc(s.query)}" placeholder="Filter containers" aria-label="Filter containers"></div>
    </div>
    <div class="cr-groups">
      ${groups.map(g => `<div class="cr-grouphead"><span class="eyebrow-p">${esc(g.name)}</span><span style="font:400 11px var(--mono);color:var(--t4)">${g.items.length}</span><span class="rule"></span></div>
        <div class="cr-cells">${g.items.map(creatorCellHtml).join('')}</div>`).join('')}
      ${groups.length ? '' : `<div style="padding:40px 0;text-align:center;font-size:12.5px;color:var(--t3)">Nothing matches “${esc(s.query)}”.</div>`}
    </div>
    <div class="ed-foot">
      <span style="flex:1;font-size:12.5px;color:var(--t2)">${esc(creator.format().title)} selected · next you choose what goes in it</span>
      <button class="pbtn pri press" data-act="cr-continue">Continue<span class="kbd" style="background:none;opacity:.7">⏎</span></button>
    </div>`;
}
/* A container that needs a helper you do not have is shown, badged and still
   pickable — the block belongs at Create, where it can be acted on. */
function creatorCellHtml(f) {
  const on = f.id === creator.state.fmt;
  const needs = f.needs && !helperFound(f.needs);
  const badge = needs ? `Needs ${f.needs}` : f.dis ? 'Unavailable' : '';
  return `<button class="fcell press" data-act="cr-format" data-format="${f.id}" data-on="${on}" data-dis="${Boolean(f.dis)}">
    <span class="t"><span class="ptile ${on ? 'acc' : ''}" style="width:22px;height:27px">${esc(f.id)}</span><b>${esc(f.title)}</b></span>
    <span class="d">${esc(f.desc)}</span>
    ${badge ? `<span class="badge">${esc(badge)}</span>` : ''}
  </button>`;
}
function creatorBuildHtml() {
  const s = creator.state;
  const f = creator.format();
  const items = creator.sortedItems();
  const installed = installedHelpers();
  const blocked = creator.isBlocked(installed);
  const sortLabel = s.sort === 'manual' ? 'Manual order' : s.sort === 'name' ? 'By name' : 'By size';
  const {size} = creator.estimate();
  return `<div class="cr-fmtbar">
      <span class="ptile acc" style="width:24px;height:30px">${esc(s.fmt)}</span>
      <b>Making a ${esc(f.title)}</b>
      <span class="d">${esc(f.desc)}</span>
      <button class="press" data-act="cr-back" style="font:600 12px var(--ui);color:var(--acc-text)">Change</button>
    </div>
    <div class="cr-listhead">
      <div style="flex:1;min-width:0"><h1 class="wk-h1">Contents</h1>
        <p class="wk-sub">${items.length} items · ${creator.totalUnits()} ${esc(f.unit.toLowerCase())} · ${s.sort === 'manual' ? 'in the order below' : `sorted by ${esc(s.sort)}`}</p></div>
      <button class="pbtn press" data-act="cr-sort">${sortLabel}<span style="font-size:9px;color:var(--t3)">▾</span></button>
      <button class="pbtn pri press" data-act="cr-add">Add items<span class="kbd" style="background:none;opacity:.7">${shortcutLabel('open')}</span></button>
    </div>
    <div class="cr-list">
      <div class="cr-cols">
        <span class="eyebrow-p" style="width:52px;flex:none">Order</span>
        <span style="width:26px;flex:none"></span>
        <span class="eyebrow-p" style="flex:1">Item</span>
        <span class="eyebrow-p" style="width:92px;flex:none">Kind</span>
        <span class="eyebrow-p" style="width:60px;flex:none;text-align:right">${esc(f.unit)}</span>
        <span class="eyebrow-p" style="width:70px;flex:none;text-align:right">Size</span>
        <span style="width:18px;flex:none"></span>
      </div>
      <div class="cr-rows">
        ${items.length ? items.map(creatorRowHtml).join('') : creatorEmptyHtml()}
        ${items.length ? `<button class="cr-more press" data-act="cr-add"><span style="flex:1">Drop more items here</span><span style="font-weight:600;color:var(--acc-text)">Choose files</span></button>` : ''}
      </div>
    </div>
    <div class="cr-foot">
      <span class="cr-path">${esc(creator.outputPath())}</span>
      ${blocked ? `<span class="cr-blocked">${esc(s.fmt)} needs ${esc(f.needs)}<button class="press" data-act="select-helper" data-helper="${esc(f.needs)}">Install</button></span>` : ''}
      ${s.job === 'running' ? `<span class="cr-prog"><span class="track"><span class="fill" style="width:${s.pct}%"></span></span><span style="font:500 11.5px var(--mono);color:var(--acc-text)">${s.pct}%</span></span>` : ''}
      ${s.job === 'done' ? `<span class="cr-done">Written · ${esc(crFmtSize(size))}</span>` : ''}
      <button class="pbtn pri press ${creator.canCreate(installed) ? '' : 'off'}" data-act="cr-create">${s.job === 'running' ? 'Creating…' : s.job === 'done' ? 'Create again' : 'Create file'}<span class="kbd" style="background:none;opacity:.7">⏎</span></button>
    </div>`;
}
function creatorRowHtml(item, index) {
  return `<div class="cr-row">
    <span class="cr-ord"><span class="n">${index + 1}</span>
      <span class="cr-nudge hov">
        <button class="press" data-act="cr-move" data-id="${item.id}" data-delta="-1" aria-label="Move up">▲</button>
        <button class="press" data-act="cr-move" data-id="${item.id}" data-delta="1" aria-label="Move down">▼</button>
      </span></span>
    <span class="ptile" style="width:26px;height:32px">${esc(item.ext)}</span>
    <span class="nm">${esc(item.name)}</span>
    <span class="cr-mono" style="width:92px;flex:none;font-weight:500;color:${item.kind === 'Text' ? 'var(--t3)' : 'var(--t2)'}">${esc(item.kind)}</span>
    <span class="cr-mono" style="width:60px;flex:none;text-align:right">${item.pages || '—'}</span>
    <span class="cr-mono" style="width:70px;flex:none;text-align:right">${esc(crFmtSize(item.size))}</span>
    <button class="press hov" data-act="cr-remove" data-id="${item.id}" style="width:18px;flex:none;text-align:center;color:var(--t3);font-size:13px" aria-label="Remove item">×</button>
  </div>`;
}
function creatorEmptyHtml() {
  const fmt = creator.state.fmt;
  return `<div class="cr-empty">
    <div class="box">${esc(fmt)}</div>
    <div style="font-size:13.5px;font-weight:600">Nothing in this ${esc(fmt)} yet</div>
    <div style="font-size:12.5px;color:var(--t2);text-align:center;max-width:280px;text-wrap:pretty">Add images, folders or existing archives. They go in the order you see here.</div>
    <button class="pbtn pri press" data-act="cr-add" style="margin-top:4px">Choose files</button>
  </div>`;
}
function creatorOutputHtml() {
  const s = creator.state;
  const f = creator.format();
  const {size, secs} = creator.estimate();
  return `<div>
      <div style="font-size:13.5px;font-weight:600">Output</div>
      <div style="font-size:12px;color:var(--t3);margin-top:2px">One file from ${s.items.length} items</div>
    </div>
    <div class="fld"><span class="lbl">File name</span>
      <div class="inp"><input id="crName" data-live="true" value="${esc(s.name)}" style="font:500 11.5px var(--mono)" aria-label="File name"><span class="cr-mono" style="color:var(--t3)">${esc(f.ext || `.${s.fmt.toLowerCase()}`)}</span></div>
    </div>
    <div class="fld"><span class="lbl">Save to</span>
      <div class="inp"><span style="flex:1;min-width:0;font:500 11.5px var(--mono);color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.dest)}</span><button class="press" data-act="cr-dest" style="font:600 11.5px var(--ui);color:var(--acc-text)">Change</button></div>
    </div>
    <div class="fld"><span class="lbl">${esc(s.fmt)} options</span>
      ${f.opts.length ? f.opts.map(creatorOptionHtml).join('') : '<span style="font-size:11.5px;color:var(--t3)">This container has no options.</span>'}
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;padding-top:12px;border-top:1px solid var(--sep)">
      <div class="pkv"><span class="k">Estimated size</span><span class="v">${esc(crFmtSize(size))}</span></div>
      <div class="pkv"><span class="k">Estimated time</span><span class="v">${secs > 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`}</span></div>
    </div>`;
}
function creatorOptionHtml(key) {
  const opt = creator.OPTS[key];
  if (!opt) return '';
  const value = creator.value(key);
  if (opt.kind === 'text') {
    return `<div style="display:flex;flex-direction:column;gap:5px;padding-top:4px">
      <span style="font-size:12px;color:var(--t2)">${esc(opt.label)}</span>
      <div class="inp"><input id="crOpt-${esc(key)}" data-live="true" data-cr-opt="${esc(key)}" type="${opt.secret ? 'password' : 'text'}"
        value="${esc(value == null ? '' : String(value))}" placeholder="${esc(opt.placeholder || '')}"
        style="font:500 11.5px var(--mono)" aria-label="${esc(opt.label)}"></div>
      ${opt.hint ? `<span style="font-size:11px;line-height:1.5;color:var(--t3)">${esc(opt.hint)}</span>` : ''}
    </div>`;
  }
  if (opt.kind === 'seg') {
    return `<div style="display:flex;flex-direction:column;gap:5px;padding-top:4px">
      <span style="font-size:12px;color:var(--t2)">${esc(opt.label)}</span>
      <div class="pseg">${opt.choices.map(c => `<button class="press" data-act="cr-opt" data-key="${key}" data-value="${esc(c)}" data-on="${c === value}">${esc(c)}</button>`).join('')}</div>
    </div>`;
  }
  return `<div style="display:flex;flex-direction:column;gap:5px;padding-top:4px">
    <button class="press" data-act="cr-toggle" data-key="${key}" role="switch" aria-checked="${Boolean(value)}" style="display:flex;align-items:center;gap:10px;width:100%;min-height:29px;padding:0 9px;border-radius:7px;box-shadow:inset 0 0 0 1px var(--sep2)">
      <span style="flex:1;font:500 12px var(--ui);color:var(--t1);text-align:left">${esc(opt.label)}</span>
      <span style="width:30px;height:18px;flex:none;border-radius:999px;padding:2px;display:flex;justify-content:${value ? 'flex-end' : 'flex-start'};background:${value ? 'var(--acc)' : 'var(--sep2)'};transition:background var(--d-quick) ease"><span style="width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2)"></span></span>
    </button>
    ${value && opt.hint ? `<span style="font-size:11px;line-height:1.5;color:var(--t3)">${esc(opt.hint)}</span>` : ''}
  </div>`;
}
const CREATOR_KINDS = {
  cbz: 'Archive', cbr: 'Archive', cb7: 'Archive', zip: 'Archive', '7z': 'Archive', rar: 'Archive',
  pdf: 'Document', epub: 'Document', docx: 'Document', odt: 'Document',
  png: 'Image', jpg: 'Image', jpeg: 'Image', webp: 'Image', tif: 'Image', tiff: 'Image', heic: 'Image',
  txt: 'Text', md: 'Text',
};
/* Items come from real files, so the list shows real names and real sizes. Page
   counts are not known until something opens the file, and are left blank rather
   than guessed. */
function creatorAddItems() {
  const input = $('crFiles');
  input.value = '';
  input.click();
}
function creatorTakeFiles(fileList) {
  const picked = [...fileList];
  if (!picked.length) return;
  creator.addItems(picked.map(file => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return {
      ext: (ext || 'file').toUpperCase().slice(0, 4),
      name: file.name,
      kind: CREATOR_KINDS[ext] || 'File',
      pages: 0,
      size: file.size / (1024 * 1024),
    };
  }));
  render(true);
}
/* The backend has no route that builds one file out of many yet, so Create runs the
   real progress treatment and then says plainly that nothing was written. */
let creatorTimer = null;
function creatorCreate() {
  const s = creator.state;
  if (!creator.canCreate(installedHelpers())) return;
  s.job = 'running'; s.pct = 0; render(true);
  clearInterval(creatorTimer);
  creatorTimer = setInterval(() => {
    s.pct += 5;
    if (s.pct >= 100) {
      clearInterval(creatorTimer); creatorTimer = null;
      s.pct = 100; s.job = 'done';
      showToast(`${creator.outputName()} is not written yet — Creator has no backend route`, false);
    }
    render(true);
  }, 100);
}
function creatorRecipesHtml() {
  const s = creator.state;
  const build = s.stage === 'build';
  return `<div style="display:flex;align-items:center;gap:8px;padding-top:${build ? '14px' : '2px'};border-top:${build ? '1px solid var(--sep)' : 'none'}">
      <span class="lbl" style="flex:1">Recipes</span>
      <button class="press" data-act="cr-save-recipe" style="font:600 11.5px var(--ui);color:var(--acc-text)">Save current</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:2px;margin-top:-8px">
      ${s.recipes.map(r => `<button class="rec press" data-act="cr-recipe" data-id="${esc(r.id)}" data-on="${r.id === s.recipe}">
        <span class="t"><span class="ptile ${r.id === s.recipe ? 'acc' : ''}" style="width:18px;height:22px;font-size:5.5px;box-shadow:none">${esc(r.ext)}</span><span class="n">${esc(r.name)}</span></span>
        <span class="m">${esc(r.dest)}</span>
      </button>`).join('')}
    </div>
    <div style="font-size:11px;line-height:1.5;color:var(--t3)">A recipe is a container plus its options, name pattern and destination.</div>`;
}

/* ---------- inspector ---------- */
function renderPanel() {
  if (page === 'creator') return renderCreatorPanel();
  if (page === 'editor') return renderEditorPanel();
  if (selectedHistory) return panelHistory();
  return selectedFile() ? panelFile() : panelBatch();
}
function panelFile() {
  const f = selectedFile(), tool = selectedTool(f), options = tool?.options || [];
  const primary = options.filter(o => ['title','creator'].includes(o.key));
  const extra = options.filter(o => !['title','creator'].includes(o.key));
  const index = files.findIndex(i => i.id === f.id) + 1;
  const kin = sameKind(f).length;
  panelBody.innerHTML = `
  <section class="canvas-inspector inspector" data-kind="${esc(f.from || 'file')}">
    <header class="section"><b>Editing ${index} of ${files.length} files</b><span class="sub">Changes apply to this file unless you say otherwise.</span></header>
    <div class="file">
      ${fileThumb(f, 'i-thumb')}
      <div class="file-copy"><span class="file-name">${esc(f.name)}</span>
        <span style="display:block;font-family:var(--font-mono);font-size:var(--text-xs);color:var(--text-secondary);margin-top:var(--space-2)">${esc(metaLine(f))}</span>
        <span class="i-route">${esc(f.from)} → ${esc(f.to || 'Choose')}</span></div>
      ${folderIcon(f.sourcePath)}
    </div>
    <div class="body">
      ${inspectorFacts(f, tool)}
      ${renameFieldHtml(f)}
      ${primary.length ? `<div class="divider inspector-metadata">${primary.map(o => fieldHtml(f, o)).join('')}</div>` : '<p class="hint">This converter has no per-file settings.</p>'}
      ${extra.length ? `<div class="divider">
        <button class="adv-toggle" data-act="toggle-advanced"><span class="chev" aria-hidden="true" data-flipped="${advanced}" style="transform:rotate(${advanced ? 180 : 0}deg)">${chevron()}</span>Conversion options</button>
        <div class="adv ${advanced ? 'open' : ''}"><div class="adv-in"><div class="adv-pad">
          ${extra.map(o => fieldHtml(f, o)).join('')}
          <div class="switch-row"><span>Keep original filenames</span><button class="switch ${keepNames ? 'on' : ''}" data-act="toggle-names" aria-pressed="${keepNames}"><i></i></button></div>
        </div></div></div></div>` : ''}
      <div class="scope"><span class="scope-label">Apply to</span><div class="scope-row"><button class="${scope === 'this' ? 'active' : ''}" data-act="set-scope" data-scope="this">This file</button><button class="${scope === 'selected' ? 'active' : ''}" data-act="set-scope" data-scope="selected">Selected files</button><button class="${scope === 'all' ? 'active' : ''}" data-act="set-scope" data-scope="all">All ${esc(f.from)}</button></div><p class="scope-note">${scope === 'this' ? 'Only this file will change.' : scope === 'selected' ? 'Changes apply to selected files.' : 'Changes apply to all matching files.'}</p></div>
      <div class="status">Changes are ready to apply.</div>
    </div>
    <footer class="foot"><div class="actions"><button class="action revert" data-act="reset-inspector">Revert</button><button class="action apply" data-act="apply-all" ${kin < 2 ? 'disabled' : ''}>Apply changes</button></div></footer>
  </section>`;
}
function outputName(raw) {
  return String(raw || '').split(/[\\/]/).pop();
}
function inspectorFacts(f, tool) {
  const ext = String(f.sourceExt || f.from || '').replace(/^\./, '').toUpperCase() || 'FILE';
  const size = fmtSize(f.sourceSize) || 'Size unknown';
  const kind = String(tool?.cat || 'File');
  const isComic = /comic|cbz|cbr|cb7/i.test(`${kind} ${ext}`);
  const isImage = /image|png|jpg|jpeg|webp|heic/i.test(`${kind} ${ext}`);
  const details = isComic ? `<div class="divider"><div class="divider-head"><span>Archive</span></div><div class="facts"><strong>Package detected</strong><span class="dot"></span><span class="ok">● Readable</span></div></div>` : isImage ? `<div class="divider"><div class="divider-head"><span>Image facts</span><span class="ok">● Readable</span></div><div class="facts"><strong>Source image</strong><span class="dot"></span><strong>Original dimensions</strong></div></div>` : `<div class="divider"><div class="divider-head"><span>File facts</span><span class="ok">● Readable</span></div><div class="facts"><strong>Ready to inspect</strong></div></div>`;
  return `<div class="divider inspector-facts"><div class="kv"><span class="k">Source</span><span class="v">${esc(ext)} · ${esc(size)}</span></div><div class="kv"><span class="k">Type</span><span class="v">${esc(kind)}</span></div>${tool?.blurb ? `<p class="inspector-note">${esc(tool.blurb)}</p>` : ''}</div>${details}`;
}
/* Renaming names the output, not the source: the file on disk is the user's and
   is never touched. The extension is shown but not editable, because it belongs
   to the chosen route — editing it here would write the wrong kind of file. */
function outputStem(f) {
  const name = outputName(f.out) || '';
  const ext = outputExt(f);
  return ext && name.toLowerCase().endsWith(ext.toLowerCase()) ? name.slice(0, -ext.length) : name;
}
function outputExt(f) {
  const name = outputName(f.out) || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}
function historyRenameFieldHtml(r, state) {
  const name = String(r.name || '');
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const locked = state === 'missing';
  return `<div class="divider inspector-rename">
    <div class="field">
      <label for="renameField">File name</label>
      <div class="rename-row">
        <input id="renameField" data-act="rename-history-file" data-id="${esc(r.id)}" value="${esc(stem)}"
          spellcheck="false" autocomplete="off" ${locked ? 'disabled' : ''}
          aria-describedby="renameHint">
        <span class="rename-ext" aria-hidden="true">${esc(ext)}</span>
      </div>
      <p class="rename-hint" id="renameHint">${locked ? 'The file is no longer where it was saved.' : 'Enter to save, Escape to undo. This renames the file on disk.'}</p>
    </div>
  </div>`;
}
function renameFieldHtml(f) {
  const locked = f.status === 'queued' || f.status === 'running';
  return `<div class="divider inspector-rename">
    <div class="field">
      <label for="renameField">Output name</label>
      <div class="rename-row">
        <input id="renameField" data-act="rename-file" data-id="${esc(f.id)}" value="${esc(outputStem(f))}"
          spellcheck="false" autocomplete="off" ${locked ? 'disabled' : ''}
          aria-describedby="renameHint">
        <span class="rename-ext" aria-hidden="true">${esc(outputExt(f))}</span>
      </div>
      <p class="rename-hint" id="renameHint">${locked ? 'The name is fixed while this file is converting.' : 'Enter to save, Escape to undo. The extension follows the route.'}</p>
    </div>
  </div>`;
}
function fieldHtml(f, option) {
  return `<div class="field"><label for="field-${esc(option.key)}">${esc(option.label)}</label>${optionControl(f, option)}</div>`;
}
function optionControl(f, option) {
  const value = f.opts?.[option.key] || '';
  const choices = {
    dpi: ['150', '300', '600'], format: ['jpg', 'png'], resize: ['original', '2400', '1600', '1200'],
    scale: ['1x', '2x', '3x'], bg: ['transparent', 'white'], codec: ['copy', 'libx264', 'libx265'],
  }[option.key];
  if (!choices) return `<input id="field-${esc(option.key)}" data-act="update-field" data-live="true" data-key="${esc(option.key)}" value="${esc(value)}" placeholder="${esc(option.placeholder || '')}">`;
  const selected = choices.includes(String(value)) ? String(value) : choices[0];
  return `<div class="option-select"><select id="field-${esc(option.key)}" data-act="update-field" data-live="true" data-key="${esc(option.key)}">${choices.map(choice => `<option value="${esc(choice)}" ${choice === selected ? 'selected' : ''}>${esc(choice)}</option>`).join('')}</select></div>`;
}
function panelBatch() {
  const blocked = files.filter(isBlocked).length;
  const dests = {};
  files.forEach(f => { const key = `${f.from} → ${f.to}`; dests[key] = (dests[key] || 0) + 1; });
  panelBody.innerHTML = `
    <section class="canvas-inspector inspector batch-inspector">
    <div class="i-sec"><b>${files.length ? 'Batch summary' : 'Nothing queued'}</b><span class="sub">${files.length ? 'Select a row to edit that file on its own.' : 'Drop files to begin.'}</span></div>
    <div class="i-body">
      ${files.length ? `<div class="stack">
        <div class="kv"><span class="k">Files queued</span><span class="v">${files.length}</span></div>
        <div class="kv"><span class="k">Need a helper</span><span class="v">${blocked}</span></div>
        <div class="kv"><span class="k">Destination</span><span class="v">${esc(commonFolder())}</span></div>
      </div>
      <div class="divider"><span class="eyebrow" style="margin-bottom:var(--space-2)">Destinations</span>
        <div class="stack">${Object.entries(dests).map(([route, n]) => `<div class="unlock"><span class="i-route" style="margin:0">${esc(route)}</span><span style="flex:1;font-size:var(--text-sm);color:var(--text-secondary)">${n} file${n === 1 ? '' : 's'}</span></div>`).join('')}</div>
      </div>`
      : `<p class="i-note">Once files are queued, this shows the batch at a glance — totals, destinations and shared settings. Select a row to edit that file on its own.</p>`}
    </div></section>`;
}
function panelHistory() {
  const r = historyRecords.find(i => i.id === selectedHistory);
  if (!r) { panelBody.innerHTML = `<div class="i-sec"><b>History</b><span class="sub">Select an output file to inspect it.</span></div>
    <div class="i-body"><p class="i-note">Files stay in history when their saved path disappears. Missing files are never hidden.</p></div>`; return; }
  const state = histState(r), meta = HIST_STATE[state] || HIST_STATE.completed;
  const settings = Object.entries(r.options || {});
  panelBody.innerHTML = `
    <div class="i-sec history-inspector"><b>Output details</b><span class="mono">${esc(r.from || '')} → ${esc(r.to || '')} · ${esc(fmtWhen(r.finishedAt))}</span></div>
    <div class="i-file history-inspector">${folderIcon(r.outputPath, 'history')}<div style="min-width:0"><b style="display:block;font-size:var(--text-base);font-weight:var(--weight-medium);line-height:var(--leading-snug);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name || 'Output file')}</b><span class="badge ${meta.cls}" style="margin-top:var(--space-2)">${meta.label}</span></div></div>
    <div class="i-body history-inspector">
      <div class="stack"><div class="history-stat"><span class="k">Output size</span><span class="v">${esc(fmtSize(r.size) || '—')}</span></div><div class="history-stat"><span class="k">Conversion</span><span class="v">${esc(r.conv || 'Recorded run')}</span></div></div>
      ${historyRenameFieldHtml(r, state)}
      <div class="divider"><span class="eyebrow" style="margin-bottom:var(--space-2)">Source file</span><div class="history-path">${esc(r.sourcePath || r.sourceName || 'Source path unavailable')}</div></div>
      <div class="divider"><span class="eyebrow" style="margin-bottom:var(--space-2)">Saved output</span><div class="history-path">${esc(r.outputPath || 'Output path unavailable')}</div></div>
      ${settings.length ? `<div class="divider"><span class="eyebrow" style="margin-bottom:var(--space-2)">Settings used</span><div class="stack">${settings.map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}</div></div>` : ''}
      ${r.error ? `<div class="warnbox">${esc(r.error)}</div>` : ''}
    </div>
    <div class="i-foot"><button class="btn btn-primary press" style="width:100%" data-act="requeue-one" data-id="${esc(r.id)}">Queue again</button>${state !== 'missing' ? `<button class="btn btn-secondary press" style="width:100%" data-act="reveal-history" data-path="${esc(r.outputPath || '')}">Show in folder</button>` : ''}</div>`;
}

/* ---------- actions ---------- */
function wireDrop(zone) {
  if (!zone) return;
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = async e => {
    e.preventDefault(); zone.classList.remove('over');
    pendingAdd = true; render(true);
    try {
    for (const file of [...e.dataTransfer.files]) {
      const source = shell?.getPathForFile?.(file) || file.path || '';
      try {
        if (source) await api('/api/add-path', {path: source});
        else {
          const res = await fetch('/api/upload', {method:'POST', headers:{'X-Filename':encodeURIComponent(file.name), 'X-File-Size':String(file.size)}, body:file});
          if (!res.ok) throw new Error('Upload failed');
          absorb(await res.json());
        }
      } catch (error) { showToast(error.message, false); }
    }
    } finally { pendingAdd = false; render(true); }
  };
}
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

document.querySelectorAll('.navbtn').forEach(b => b.onclick = () => setPage(b.dataset.page));
$('settingsBtn').onclick = () => settingsOpen ? closeSettings() : openSettings();
$('crFiles').onchange = event => creatorTakeFiles(event.target.files);

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
