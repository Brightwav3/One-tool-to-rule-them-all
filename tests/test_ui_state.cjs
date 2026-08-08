const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const mainJs = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(__dirname, '..', 'app', 'preload.js'), 'utf8');
/* First, as in index.html: it installs the nextLocalId global that editor state
   calls. Required for the side effect, not for the return value. */
require('../converter/ui/core/ids.js');
const actionState = require('../converter/ui/interaction/action-state.js');
const panelResize = require('../converter/ui/interaction/panel-resize.js');
const shortcutLabels = require('../converter/ui/interaction/shortcut-labels.js');
const selectionState = require('../converter/ui/interaction/selection-state.js');

const {inlinedIndexHtml, rawIndexHtml: readRawIndexHtml} = require('./ui-source.cjs');
/* index.html with its stylesheet and scripts inlined, so these assertions
   keep testing the UI rather than which file each rule ended up in. */
const indexHtml = inlinedIndexHtml();
/* The shell itself, for the assertions about which scripts it loads. */
const rawIndexHtml = readRawIndexHtml();
const fidelioB = fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'fidelioB.svg'), 'utf8');
const fidelioW = fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'fidelioW.svg'), 'utf8');
assert.match(rawIndexHtml, /<script src="\/interaction\/action-state\.js"><\/script>/);
assert.match(rawIndexHtml, /<script src="\/interaction\/panel-resize\.js"><\/script>/);
assert.match(rawIndexHtml, /<script src="\/interaction\/selection-state\.js"><\/script>/);
assert.match(rawIndexHtml, /<script src="\/interaction\/shortcut-labels\.js"><\/script>/);
assert.doesNotMatch(rawIndexHtml, /<script src="\/ui\/interaction\/action-state\.js"><\/script>/);

assert.equal(
  actionState.nextActionStatus('pending', [{status: 'running'}]),
  'pending',
);
assert.equal(
  actionState.nextActionStatus('pending', [{status: 'done'}]),
  'success',
);
assert.equal(
  actionState.nextActionStatus('pending', [{status: 'error'}]),
  'idle',
);
assert.equal(
  actionState.nextActionStatus('pending', [{status: 'done'}, {status: 'error'}]),
  'success',
);
assert.equal(
  actionState.nextActionStatus('idle', [{status: 'done'}]),
  'success',
);
assert.equal(
  actionState.nextActionStatus('success', [{status: 'done'}]),
  'success',
);
assert.equal(
  actionState.nextActionStatus('success', []),
  'idle',
);
assert.equal(
  actionState.nextActionStatus('success', [{status: 'idle'}]),
  'idle',
);
assert.equal(
  actionState.actionButtonClass('success'),
  'btn btn-primary press go success',
);
assert.equal(
  actionState.actionButtonClass('idle'),
  'btn btn-primary press go',
);
assert.match(indexHtml, /class="\$\{OneToolActionState\.actionButtonClass\(actionStatus\)\}"/);
assert.match(indexHtml, /\.go\.success\[disabled\]\{background:var\(--ok-t\);color:#fff\}/);
assert.match(indexHtml, /\$\{ready && !busy && actionStatus === 'idle' \? '' : 'disabled'\}/);
// Dragging left still stops at 520. Dragging right no longer stops at 240 — it
// keeps going to the window edge, and everything under 240 counts as collapsed,
// so the pane blanks instead of clipping its rows.
assert.equal(panelResize.clampPanelWidth(640, 980), 520);
assert.equal(panelResize.clampPanelWidth(180, 980), 180);
assert.equal(panelResize.clampPanelWidth(-40, 980), 0);
assert.equal(panelResize.isPanelCollapsed(240), false);
assert.equal(panelResize.isPanelCollapsed(120), true);
assert.equal(panelResize.isPanelCollapsed(121), false);
assert.equal(panelResize.isPanelCollapsed(0), true);
assert.equal(panelResize.widthFromDrag(308, 700, 500, 980), 508);
assert.equal(panelResize.widthFromDrag(308, 700, 760, 980), 248);
// past the old floor, all the way to nothing
assert.equal(panelResize.widthFromDrag(308, 700, 900, 980), 0);
assert.equal(panelResize.widthFromDrag(308, 700, 1100, 980), 0);
// The midpoint chooses the closest stable state: at or below 120px it closes;
// above 120px it returns to the usable 240px minimum.
assert.equal(panelResize.snapPanelWidth(120), 0);
assert.equal(panelResize.snapPanelWidth(121), 240);
assert.equal(panelResize.snapPanelWidth(239), 240);
assert.equal(panelResize.snapPanelWidth(240), 240);
assert.equal(panelResize.snapPanelWidth(308), 308);
assert.equal(panelResize.widthFromDrag(0, 700, 699, 980), 0);
assert.equal(panelResize.widthFromDrag(0, 700, 579, 980), 240);
assert.match(indexHtml, /class="[^"]*panel-resize/);
assert.match(indexHtml, /data-panel-resize/);
assert.match(indexHtml, /<div class="work-resize panel-resize" data-panel-resize/);
assert.equal(shortcutLabels.label('palette', true), '⌘K');
assert.equal(shortcutLabels.label('palette', false), 'Ctrl K');
assert.equal(shortcutLabels.label('open', false), 'Ctrl O');
assert.match(indexHtml, /data-shortcut="palette"/);

// ---- Alt+I toggles the sidebar without losing the selection-driven default ----
assert.match(indexHtml, /let inspectorOpen = null;/);
assert.match(indexHtml, /const inspectorVisible = \(\) => inspectorOpen \?\? inspectorHasContext\(\);/);
assert.doesNotMatch(indexHtml, /id="inspToggle"/);
assert.match(indexHtml, /event\.altKey && key === 'i'/);
assert.match(indexHtml, /inspectorOpen = !inspectorVisible\(\);/);
assert.match(indexHtml, /if \(inspectorOpen && panelWidth === 0\) setPanelWidth\(OneToolPanelResize\.MIN_WIDTH\);/);
// Theme has one home now — the Theme row in Settings.
assert.doesNotMatch(indexHtml, /id="themeToggle"/);
assert.doesNotMatch(indexHtml, /function toggleTheme/);
// Editor and Creator are a window field with cards in it, not a white page.
assert.match(indexHtml, /#pageEditor,#pageCreator\{[^}]*background:var\(--bg\)\}/);
assert.match(indexHtml, /\.wincontrols button\{[^}]*-webkit-app-region:no-drag/);
assert.match(indexHtml, /data-act="toggle-folder-menu"/);
assert.match(indexHtml, /data-act="select-folder"/);
assert.match(indexHtml, /data-act="forget-folder"/);
assert.match(indexHtml, /class="context-menu t-dropdown/);
assert.match(indexHtml, /data-context="queue-file"/);
assert.match(indexHtml, /data-context="history-file"/);
assert.match(indexHtml, /data-context="helper"/);
assert.match(indexHtml, /contextmenu/);
assert.match(indexHtml, /Show input in Explorer/);
assert.match(indexHtml, /Show output in Explorer/);
assert.match(indexHtml, /reveal-queue-output/);
assert.match(indexHtml, /reveal-history-input/);
assert.match(indexHtml, /function revealTargetForRow/);
// Double-click opens the output file on any row that has written one, and falls
// back to renaming when there is nothing to open yet.
assert.match(indexHtml, /event\.detail === 2 && \(act === 'select-row' \|\| act === 'select-history'\)/);
assert.match(indexHtml, /const target = revealTargetForRow\(el\);\s+if \(target\.path\) return revealFile\(target\.path, target\.history\)/);
assert.match(indexHtml, /if \(file\?\.status === 'done' && file\.out\) return \{path: file\.out, history: true\};/);
assert.match(indexHtml, /return startRename\(file\.id\)/);
assert.match(indexHtml, /contextItem\('Rename output…', 'rename-queue'/);
assert.match(indexHtml, /id="renameField"/);
// The one list has no per-row folder button; revealing is a context-menu action
// and a double-click, and each still opens the file that actually exists — the
// source for queued work, the output for something already written.
assert.match(indexHtml, /\$\{folderIcon\(r\.outputPath, 'history'\)\}/);
assert.match(indexHtml, /contextItem\('Show input in Explorer', 'reveal-history-input'/);
assert.match(indexHtml, /history \? '\/api\/history\/reveal' : '\/api\/reveal'/);
assert.match(indexHtml, /data-multi-selected/);
assert.match(indexHtml, /selectedQueueIds/);
assert.match(indexHtml, /shiftKey/);
assert.match(indexHtml, /ctrlKey \|\| event\.metaKey/);
assert.match(indexHtml, /pointerdown/);
assert.match(indexHtml, /remove-many/);
assert.match(indexHtml, /data-act="requeue-one"[^>]*>Queue again</);
assert.doesNotMatch(indexHtml, /data-act="requeue-one"[^>]*>Convert \$\{esc\(r\.sourceName/);
assert.match(indexHtml, /history-inspector/);
assert.match(indexHtml, /Output details/);
assert.match(indexHtml, /Source file/);
assert.match(indexHtml, /Password-protected archive/);
assert.match(indexHtml, /data-act="unlock-archive"/);
assert.match(indexHtml, /<section class="canvas-inspector inspector"/);
assert.match(indexHtml, /<header class="section"><b>Editing \$\{index\} of \$\{files\.length\} files<\/b>/);
assert.match(indexHtml, /<div class="file">/);
assert.match(indexHtml, /<div class="body">/);
assert.match(indexHtml, /<footer class="foot">/);
assert.match(indexHtml, /\.canvas-inspector\.inspector\{width:100%;min-height:0;flex:1;display:flex;flex-direction:column;background:var\(--panel\);border:0[^}]*\}/);
assert.doesNotMatch(indexHtml, /View contents/);
const panelFileSource = indexHtml.slice(indexHtml.indexOf('function panelFile()'), indexHtml.indexOf('function outputName('));
assert.match(panelFileSource, /\$\{folderIcon\(f\.sourcePath\)\}/);
assert.doesNotMatch(panelFileSource, /\$\{folderIcon\(f\.out, 'output'\)\}/);
assert.ok(panelFileSource.indexOf('<div class="status">') < panelFileSource.indexOf('<footer class="foot">'));
assert.match(indexHtml, /\.canvas-inspector \.actions \.action\{flex:1\}/);
assert.match(indexHtml, /\.canvas-inspector\{--panel:var\(--surface\);--line:var\(--sep\);color:var\(--t1\)\}/);
assert.match(indexHtml, /\.canvas-inspector \.section,.canvas-inspector \.file,.canvas-inspector>\.body,.canvas-inspector \.foot\{background:var\(--surface\)\}/);
assert.match(indexHtml, /\.canvas-inspector \.field input,.canvas-inspector \.option-select select\{background:var\(--surface\);color:var\(--t1\);box-shadow:inset 0 0 0 1px var\(--sep2\)\}/);
assert.match(indexHtml, /\.canvas-inspector\.inspector\{color:var\(--t1\)\}/);
assert.match(indexHtml, /\.canvas-inspector \.actions\{display:flex;width:100%;gap:8px\}/);
assert.match(indexHtml, /\.canvas-inspector \.actions \.action\{flex:1 1 0;min-width:0\}/);
assert.match(indexHtml, /\.canvas-inspector>\.body\{[^}]*display:flex;flex-direction:column[^}]*\}/);
assert.match(indexHtml, /\.canvas-inspector \.scope\{display:block;min-height:0;padding:0\}/);
assert.match(indexHtml, /\.canvas-inspector \.status\{margin-top:auto[^}]*\}/);
assert.match(indexHtml, /\.canvas-inspector \.scope\{flex:none;flex-shrink:0\}/);
assert.match(indexHtml, /\.canvas-inspector \.status\{flex:none;flex-shrink:0\}/);
assert.match(indexHtml, /\.canvas-inspector\.inspector\{background:var\(--bg\)!important;border:0!important;box-shadow:none!important;border-radius:0!important\}/);
assert.match(indexHtml, /#app \.panel\{background:var\(--bg\)\}/);
assert.match(indexHtml, /<section class="canvas-inspector inspector batch-inspector">/);

assert.deepEqual(selectionState.updateSelection({
  ids: ['a', 'b', 'c'], selected: [], anchorId: null, targetId: 'a',
}), {selected: ['a'], anchorId: 'a'});
assert.deepEqual(selectionState.updateSelection({
  ids: ['a', 'b', 'c'], selected: ['a'], anchorId: 'a', targetId: 'c', toggle: true,
}), {selected: ['a', 'c'], anchorId: 'c'});
assert.deepEqual(selectionState.updateSelection({
  ids: ['a', 'b', 'c', 'd'], selected: ['a'], anchorId: 'a', targetId: 'c', shift: true,
}), {selected: ['a', 'b', 'c'], anchorId: 'a'});
assert.match(indexHtml, /data-shortcut="open"/);
assert.match(indexHtml, /\.navbtn\.active\{[^}]*background:var\(--accent\)[^}]*color:var\(--text-inverse\)/);
// The theme still persists and still drives the dark palette; only its control moved.
assert.match(indexHtml, /one-tool\.theme/);
assert.match(indexHtml, /\[data-theme="dark"\]/);
assert.match(indexHtml, /--bg:#000000;--surface:#000000;--raised:#000000;/);
assert.match(indexHtml, /--surface-inverse:#1f2024/);
assert.match(indexHtml, /\[data-theme="dark"\] \.tip\{background:#1f2024;color:#ededed\}/);
assert.match(mainJs, /window:set-theme/);
assert.match(mainJs, /ipcMain\.handle\('theme:get'/);
assert.match(mainJs, /app\.getPath\('userData'\)/);
assert.match(preloadJs, /setTheme/);
assert.match(preloadJs, /getTheme/);
assert.match(fidelioB, /<path d="M963\.41/);
assert.match(fidelioW, /fill:rgb\(234,234,234\)/);
assert.doesNotMatch(indexHtml, /<span class="kbd">⌘K<\/span>/);
assert.doesNotMatch(indexHtml, /<span class="kbd">⌥I<\/span>/);
assert.match(mainJs, /backgroundColor:\s*'#f2f2f4'/);
assert.match(indexHtml, /\.topbar\{[^}]*position:relative;z-index:12/);
assert.match(indexHtml, /<div class="body">\s*<div class="left">\s*<header class="topbar">/s);
assert.strictEqual((indexHtml.match(/<header class="topbar">/g) || []).length, 1);
const activeTopbar = indexHtml.match(/<header class="topbar">([\s\S]*?)<\/header>/)?.[1] || '';
assert.doesNotMatch(activeTopbar, /Ă|âŚ/);
assert.match(indexHtml, /\.nav\{display:flex;[^}]*flex:none/);
assert.match(indexHtml, /\.searchwrap\{flex:1;min-width:0;display:flex/);
assert.match(indexHtml, /\.search\{display:flex;[^}]*width:330px;max-width:100%;min-width:0/);
assert.match(indexHtml, /\.topbar>\.tiphost\{flex:none\}/);
assert.match(indexHtml, /\.panel-top\{flex:none;height:44px;position:relative;-webkit-app-region:no-drag\}/);
assert.match(indexHtml, /\.panel-top::before\{content:"";position:absolute;inset:0 104px 0 0;-webkit-app-region:drag\}/);
assert.match(indexHtml, /\.wincontrols\{[^}]*position:fixed[^}]*z-index:2147483647[^}]*pointer-events:auto!important[^}]*-webkit-app-region:no-drag!important/);
assert.match(indexHtml, /\.work-resize\{right:-9px;top:0;height:100%\}/);
assert.match(indexHtml, /\.work-resize::after\{display:none\}/);
assert.match(indexHtml, /\.panel-resize:hover::after\{background:transparent\}/);
assert.doesNotMatch(indexHtml, /\.work\[data-resizing="true"\] \.panel-resize::after/);
assert.match(indexHtml, /document\.querySelectorAll\('\[data-panel-resize\]'\)/);
// Creator and Editor now use the shared app sidebar, so one stable delegated
// resize handle serves Convert, Creator, and Editor.
assert.equal((indexHtml.match(/data-panel-resize role=/g) || []).length, 1);
assert.match(indexHtml, /\.wk-side\{width:var\(--panel-width,308px\)/);
assert.match(indexHtml, /\.wk-side\[data-collapsed="true"\]\{opacity:0;pointer-events:none\}/);
assert.match(indexHtml, /\.panel\[data-collapsed="true"\] \.panel-in\{opacity:0;pointer-events:none\}/);
assert.match(indexHtml, /#app\[data-panel="closed"\] \.work\{margin-right:8px;border-right:1px solid var\(--sep\);border-radius:0 14px 14px 0\}/);
assert.match(indexHtml, /\.work\{margin:0;border:1px solid var\(--sep\);border-left:0;border-bottom:0;border-radius:0 14px 0 0/);
assert.match(indexHtml, /class="folder" width="48" height="48" viewBox="0 0 48 48"/);
assert.match(indexHtml, /\.folder:hover \.fdr-front\{transform:scaleY\(\.72\) rotate\(4deg\)\}/);
assert.match(indexHtml, /\.folder:hover \.fdr-sheet\{transform:translateY\(-11px\)\}/);

assert.doesNotMatch(indexHtml, /class="thumb" aria-hidden="true"><span>\$\{esc\(thumbLabel\(f\)\)/);
assert.match(indexHtml, /html,body,\*\{-webkit-user-select:none;user-select:none\}/);
assert.match(indexHtml, /input,textarea,\[contenteditable="true"\]\{-webkit-user-select:text;user-select:text\}/);

// ---- Convert view: two top-level views, one list ----
// Convert is the only nav item; Settings is the cog, and History is not a page.
const navPages = [...indexHtml.matchAll(/data-page="([a-z]+)"/g)].map(m => m[1]);
assert.deepEqual([...new Set(navPages)].sort(), ['convert', 'creator', 'editor']);
assert.doesNotMatch(indexHtml, /data-page="queue"/);
assert.doesNotMatch(indexHtml, /data-page="history"/);
assert.doesNotMatch(indexHtml, /data-page="helpers"/);
assert.doesNotMatch(indexHtml, /<section class="page" id="pageHistory"/);
assert.match(indexHtml, /const pages = \{ convert: \$\('pageConvert'\), creator: \$\('pageCreator'\), editor: \$\('pageEditor'\) \};/);
assert.match(indexHtml, /let page='convert',/);

// ---- Settings: a sheet over the app, Helpers as a category ----
// Settings is not a page — it opens over whatever the app was showing and closes
// back onto it, so the queue behind it never resets.
assert.match(indexHtml, /<div class="scrim set-scrim" id="setScrim" data-act="close-settings"><div class="modal set-win" id="setWin" data-stop="true"><\/div><\/div>\n<\/div>/);
assert.match(indexHtml, /\.set-scrim\{position:fixed;z-index:40/);
assert.doesNotMatch(indexHtml, /id="pageSettings"/);
assert.match(indexHtml, /function openSettings\(tab\)/);
assert.match(indexHtml, /function closeSettings\(\)/);
// The cog sits at the left end of the title bar and carries the missing-helper dot.
assert.match(indexHtml, /<button class="cog-btn" id="settingsBtn" aria-label="Settings" aria-haspopup="dialog"/);
// The cog turns on hover; it never changes colour.
assert.doesNotMatch(indexHtml, /\.cog-btn:hover,\.cog-btn\.active\{color/);
assert.match(indexHtml, /<span class="navdot" id="helperDot" hidden><\/span>\s*<\/button>/);
assert.match(indexHtml, /\.cog-btn:hover svg,\.cog-btn:focus-visible svg\{transform:rotate\(45deg\)\}/);
// The outline cog, drawn not masked, grey on light and near-white on dark.
assert.match(indexHtml, /<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1\.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">/);
assert.match(indexHtml, /<circle cx="12" cy="12" r="3\.4"\/>/);
assert.doesNotMatch(indexHtml, /cog-mask/);
assert.match(indexHtml, /:root\{--cog:#6E6E74\}/);
assert.match(indexHtml, /\[data-theme="dark"\]\{--cog:#EDEDED\}/);
assert.match(indexHtml, /\.cog-btn\{[^}]*color:var\(--cog\)/);
// Helpers is a sidebar category, not a page of its own.
assert.doesNotMatch(indexHtml, /function renderHelpers\(\)/);
assert.doesNotMatch(indexHtml, /function panelHelper\(\)/);
assert.match(indexHtml, /function renderSettings\(\)/);
assert.match(indexHtml, /function settingsHelpersHtml\(\)/);
const setTabIds = [...indexHtml.matchAll(/\{id:'([a-z]+)', name:'[^']+', glyph:/g)].map(m => m[1]);
assert.deepEqual(setTabIds, ['general', 'conversions', 'editing', 'files', 'helpers', 'shortcuts', 'advanced']);
// An unset value falls back to the row's default rather than being written at boot.
assert.match(indexHtml, /if \(row\.kind === 'switch'\) return stored === undefined \? Boolean\(row\.on\) : Boolean\(stored\);/);

// Queued work and written output render as one table, status as a column.
assert.match(indexHtml, /function convertRows\(\)/);
assert.match(indexHtml, /function renderConvert\(\)/);
assert.match(indexHtml, /function unifiedRow\(row, index, lastActive\)/);
assert.doesNotMatch(indexHtml, /function renderQueue\(\)/);
assert.doesNotMatch(indexHtml, /function renderHistory\(\)/);
assert.match(indexHtml, /renderConvert\(\); renderCreator\(\); renderEditor\(\); renderSettings\(\); renderPanel\(\); renderOverlays\(\);/);
// a file that is both queued and already written appears once, from the queue
assert.match(indexHtml, /const inQueue = new Set\(files\.map\(file => `\$\{file\.sourcePath\}\|\$\{file\.to\}`\)\);/);
// the history has to be loaded at boot now that it is part of the default view
assert.match(indexHtml, /absorb\(state\); loadHistory\(\);/);

// The prototype's header: filter pills, sort, Add files.
['All', 'Active', 'Completed', 'Stopped', 'Missing', 'Comics', 'Images', 'Documents', 'Video'].forEach(name => {
  assert.match(indexHtml, new RegExp(`name:'${name}'`), `missing the ${name} filter`);
});
assert.match(indexHtml, /const SORTS = \{newest:'Newest', oldest:'Oldest', name:'Name', largest:'Largest'\};/);
assert.match(indexHtml, /class="u-add press" data-act="add">Add files/);
// its column headers, empty state and footer copy, verbatim
['File', 'Conversion', 'Status', 'Size', 'Written'].forEach(col => {
  assert.match(indexHtml, new RegExp(`>${col}<`), `missing the ${col} column header`);
});
assert.match(indexHtml, /<b>Nothing matches<\/b><span>Nothing in this view yet\.<\/span>/);
assert.match(indexHtml, /\$\{ready\} ready · \$\{blocked\} waiting on \$\{blockingHelper\(\)\} · \$\{written\} written/);
assert.match(indexHtml, /All done<\/span>/);

// The prototype's motion survives the port.
assert.match(indexHtml, /@keyframes u-cascade\{from\{opacity:0;transform:translateY\(10px\);filter:blur\(2px\)\}/);
assert.match(indexHtml, /@keyframes u-shimmer/);
assert.match(indexHtml, /\.u-fill\{[^}]*transition:width var\(--d-fast\) linear\}/);
assert.match(indexHtml, /animation-delay:\$\{Math\.min\(index, 7\) \* 50\}ms/);

// This app's own thumbnails and route picker stay in the ported row.
assert.match(indexHtml, /fileThumb\(file, 'u-tile'\)/);
assert.match(indexHtml, /\$\{routePopover\(file, open\)\}/);

// The split pane it replaces is gone.
assert.doesNotMatch(indexHtml, /convert-split/);
assert.doesNotMatch(indexHtml, /data-split-resize/);
assert.doesNotMatch(indexHtml, /one-tool\.convert-split/);

// Tick boxes span the whole list, and deleting reaches both stores.
assert.match(indexHtml, /function applyRowCheck\(event, id\)/);
assert.match(indexHtml, /const rows = visibleRows\(\);\s+const allOn = rows\.length > 0/);
assert.match(indexHtml, /if \(queued\.length\) await api\('\/api\/remove-many', \{ids: queued\}\);/);
assert.match(indexHtml, /if \(written\.length\) await historyAction\('\/api\/history\/delete'/);

// Existing queue and history actions all survive the merge.
['convert', 'add', 'history-sort', 'history-filter', 'history-requeue', 'history-delete',
 'history-deselect', 'check-history', 'check-all', 'select-history', 'select-row',
 'toggle-picker', 'requeue-one', 'reveal-history'].forEach(act => {
  assert.match(indexHtml, new RegExp(`data-act="${act}"`), `missing data-act="${act}"`);
});
assert.match(indexHtml, /if \(next === 'convert'\) loadHistory\(\);/);
// Enter still converts from the Convert view.
assert.match(indexHtml, /page === 'convert'\) \{ event\.preventDefault\(\); convert\(\); \}/);
// The inspector serves the history record when one is picked, the queue otherwise.
assert.match(indexHtml, /if \(selectedHistory\) return panelHistory\(\);/);

// A narrow window keeps the list; the inspector collapses rather than taking over.
assert.match(indexHtml, /@media \(max-width:640px\)\{\.app\{min-width:0\}\.panel\[data-open="true"\]\{width:0\}/);
assert.doesNotMatch(indexHtml, /@media \(max-width:640px\)[^}]*\.left\{display:none\}/);

// Every row can be renamed from its context menu — a queued row renames what it
// will write, a written row renames the file on disk.
assert.match(indexHtml, /contextItem\('Rename output…', 'rename-queue'/);
assert.match(indexHtml, /contextItem\('Rename file…', 'rename-history', ICON\.rename, \{disabled: target\.state === 'missing'\}\)/);
assert.match(indexHtml, /if \(action === 'rename-history'\) return startHistoryRename\(target\.id\);/);
assert.match(indexHtml, /function startHistoryRename\(id\)/);
assert.match(indexHtml, /function historyRenameFieldHtml\(r, state\)/);
assert.match(indexHtml, /data-act="rename-history-file"/);
assert.match(indexHtml, /api\('\/api\/history\/rename', \{id: record\.id, name: next\}/);
// a file that is no longer where it was saved cannot be renamed
assert.match(indexHtml, /const locked = state === 'missing';/);
// Enter commits, Escape puts the old name back, blur commits — as for the queue
assert.match(indexHtml, /if \(key === 'enter'\) \{ event\.preventDefault\(\); commitHistoryRename\(event\.target\); return; \}/);
assert.match(indexHtml, /if \(event\.target\?\.dataset\?\.act === 'rename-history-file'\) commitHistoryRename\(event\.target\);/);

// ---- Editor: one page model behind grid, reader and pair ----
const {createEditorState, makePages, OPTIMISTIC, describeOp, cropBoxToPoints, screenPointToPagePercent, TOOLS} = require('../converter/ui/workspaces/editor/editor-state.js');
assert.deepEqual(TOOLS.map(tool => [tool.id, tool.icon]), [
  ['select', 'i-select'], ['text', 'i-text'], ['redact', 'i-redact'],
  ['draw', 'i-draw'], ['stamp', 'i-stamp'], ['crop', 'i-crop'],
]);
assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'workspaces', 'editor', 'editor-view.js'), 'utf8'), /t\.glyph/);
assert.match(
  fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'workspaces', 'editor', 'editor-view.js'), 'utf8'),
  /pageImageUrl\(page, big \? previewWidth\(\) : OneToolEditorActions\.thumbWidth\(\)\)/,
);
assert.match(
  fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'workspaces', 'editor', 'editor-view.js'), 'utf8'),
  /globalThis\.devicePixelRatio/,
);

{
  const ed = createEditorState({pages: makePages(6)});
  const [a, b, c] = ed.state.pages;

  // Click selects one page; clicking the only selected page turns it off again.
  ed.select(a.id);
  assert.deepEqual(ed.selectedIds(), [a.id]);
  ed.select(a.id);
  assert.deepEqual(ed.selectedIds(), []);

  // Modifier-click adds to the selection rather than replacing it.
  ed.select(a.id);
  ed.select(b.id, {additive: true});
  assert.deepEqual(ed.selectedIds().sort((x, y) => x - y), [a.id, b.id].sort((x, y) => x - y));

  // The reader opens on the first selected page, and the grid keeps that page selected.
  ed.openReader();
  assert.equal(ed.state.mode, 'reader');
  assert.equal(ed.state.focus, a.id);
  ed.toGrid();
  assert.equal(ed.state.mode, 'grid');
  assert.deepEqual(ed.selectedIds(), [a.id]);

  // Arrow steps clamp at both ends instead of wrapping.
  ed.openReader(a.id);
  ed.step(-1);
  assert.equal(ed.state.focus, a.id);
  ed.step(1);
  assert.equal(ed.state.focus, b.id);

  // Rotation accumulates on the page it is applied to.
  ed.rotate(90);
  assert.equal(ed.state.pages.find(p => p.id === b.id).rot, 90);

  // The server owns structural changes that remove or create page ids.
  ed.rejectPending('test cleanup');
  ed.remove();
  assert.equal(ed.state.pages.some(p => p.id === b.id), true);
  assert.equal(ed.state.focus, b.id);

  // Insert waits for the engine snapshot that contains its assigned id.
  ed.toGrid();
  ed.select(a.id);
  assert.equal(ed.insert(), true);
  assert.equal(ed.state.pages.length, 6);
  assert.deepEqual(ed.selectedIds(), [a.id]);

  // The edit list is server-owned, so local prototype actions do not invent one.
  assert.equal(ed.state.edits.length, 0);

  // Marks belong to the focused page and only the redact tool can drop them.
  ed.openReader(a.id);
  ed.state.tool = 'select';
  assert.equal(ed.addMark(50, 50), null);
  ed.state.tool = 'redact';
  const mark = ed.addMark(50, 50);
  assert.equal(ed.totalMarks(), 1);
  ed.removeMark(mark.id);
  assert.equal(ed.totalMarks(), 0);

  // Zoom is clamped to the range the toolbar offers.
  ed.state.zoom = 40; ed.setZoom(-16);
  assert.equal(ed.state.zoom, 40);
  ed.state.zoom = 200; ed.setZoom(16);
  assert.equal(ed.state.zoom, 200);
}

{
  // Pair mode moves pages both ways and never leaves a page in two places.
  const ed = createEditorState({pages: makePages(4)});
  ed.openPair('extras.pdf', makePages(2, 900));
  assert.equal(ed.state.mode, 'pair');
  const first = ed.state.pages[0];
  ed.select(first.id);
  ed.moveRight();
  assert.equal(ed.state.pages.some(p => p.id === first.id), false);
  assert.equal(ed.state.bPages.length, 3);
  // Copy leaves the original where it was.
  const next = ed.state.pages[0];
  ed.select(next.id);
  ed.moveRight({copy: true});
  assert.equal(ed.state.pages.some(p => p.id === next.id), true);
  assert.equal(ed.state.bPages.length, 4);
  ed.closePair();
  assert.equal(ed.state.mode, 'grid');
  assert.equal(ed.state.bPages.length, 0);
}

// ---- Creator: format first, then contents ----
const {createCreatorState, fmtSize} = require('../converter/ui/workspaces/creator/creator-state.js');

{
  const cr = createCreatorState({name: 'Ultimates v01', dest: '~/Converted/Comics'});

  // Nothing can be created from an empty list.
  assert.equal(cr.state.stage, 'pick');
  assert.equal(cr.canCreate({}), false);
  cr.chooseFormat('CBZ');
  cr.toBuild();
  assert.equal(cr.state.stage, 'build');

  cr.addItems([
    {ext: 'PNG', name: 'b.png', kind: 'Image', pages: 1, size: 4},
    {ext: 'PNG', name: 'a.png', kind: 'Image', pages: 1, size: 8},
  ]);
  assert.equal(cr.canCreate({}), true);
  assert.equal(cr.totalUnits(), 2);

  // Sorting is a view; nudging a row puts the list back under manual control.
  cr.state.sort = 'name';
  assert.deepEqual(cr.sortedItems().map(i => i.name), ['a.png', 'b.png']);
  cr.moveItem(cr.state.items[0].id, 1);
  assert.equal(cr.state.sort, 'manual');
  assert.deepEqual(cr.state.items.map(i => i.name), ['a.png', 'b.png']);

  // Only the options the container declares are offered, and unset ones read as defaults.
  assert.deepEqual(cr.format().opts, ['compress', 'meta', 'rename']);
  assert.equal(cr.value('compress'), 'Normal');
  cr.setValue('compress', 'Max');
  assert.equal(cr.value('compress'), 'Max');

  // A container that needs a missing helper cannot be created, but stays selectable.
  cr.chooseFormat('CBR');
  assert.equal(cr.isBlocked({}), true);
  assert.equal(cr.canCreate({}), false);
  assert.equal(cr.canCreate({'7-Zip': true}), true);

  // A recipe sets the format and every option in one go. Its destination is
  // empty, which means "leave it where the app is already saving".
  const dest = cr.state.dest;
  cr.pickRecipe('bk');
  assert.equal(cr.state.fmt, '7Z');
  assert.equal(cr.state.dest, dest);
  assert.equal(cr.value('compress'), 'Max');
  assert.equal(cr.outputPath(), `${dest}/Ultimates v01.7z`);

  // A recipe that names a folder still moves the destination to it.
  cr.state.recipes = [...cr.state.recipes, {id: 'far', name: 'Elsewhere', ext: 'ZIP', dest: 'D:/out', opts: {}}];
  cr.pickRecipe('far');
  assert.equal(cr.state.dest, 'D:/out');

  // The registry replaces the declared containers, so the picker can only offer
  // what this machine can actually write.
  assert.equal(cr.setContainers([{name: 'Archives', items: [
    {id: 'ZIP', converter: 'items-zip', title: 'ZIP', desc: '', ext: '.zip', unit: 'Files', opts: ['compress']},
  ]}]), true);
  assert.deepEqual(cr.GROUPS.map(g => g.name), ['Archives']);
  assert.equal(cr.state.fmt, 'ZIP', 'a container that no longer exists is left behind');
  assert.equal(cr.format().converter, 'items-zip');
  assert.equal(cr.outputName(), 'Ultimates v01.zip', 'the extension comes from the registry');
  // An empty list is ignored rather than emptying the picker.
  assert.equal(cr.setContainers([]), false);
  assert.deepEqual(cr.GROUPS.map(g => g.name), ['Archives']);
  // A real extension is used verbatim, so tar.gz is not shortened to .tgz.
  cr.setContainers([{name: 'Archives', items: [
    {id: 'TGZ', converter: 'items-tgz', title: 'tar.gz', desc: '', ext: '.tar.gz', unit: 'Files', opts: []},
  ]}]);
  assert.equal(cr.outputName(), 'Ultimates v01.tar.gz');

  // Saving captures the current configuration under a new recipe.
  const before = cr.state.recipes.length;
  const id = cr.saveRecipe();
  assert.equal(cr.state.recipes.length, before + 1);
  assert.equal(cr.state.recipe, id);
}

assert.equal(fmtSize(0.5), '512 KB');
assert.equal(fmtSize(31.2), '31.2 MB');
assert.equal(fmtSize(2048), '2.0 GB');

// The editor only takes the keyboard when it is the visible page.
assert.match(indexHtml, /if \(page === 'editor' && !settingsOpen && !paletteOpen/);
// Neither screen ships the design-canvas runtime.
assert.doesNotMatch(indexHtml, /support\.js|<sc-for|<sc-if|data-dc-script/);

// ---- Motion: entrances play on arrival, never on every render ----
// These screens rebuild their whole pane on each state change, so an ungated
// entrance class would replay on every click and read as the view reloading.
assert.match(indexHtml, /const enterEditor = cls => editorEntering \? cls : '';/);
assert.match(indexHtml, /editorEntering = editorView !== key;/);
assert.match(indexHtml, /settingsEntering = settingsView !== key;/);
// The tool is part of the editor's view key; stepping pages is not.
assert.match(indexHtml, /const key = s\.mode \+ ':' \+ \(s\.mode === 'reader' \? s\.tool : ''\);/);
assert.match(
  fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'interaction', 'keyboard.js'), 'utf8'),
  /event\.ctrlKey && \(event\.code === 'Space' \|\| key === ' ' \|\| key === 'spacebar'\)/,
);
assert.match(
  fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'interaction', 'keyboard.js'), 'utf8'),
  /type !== 'file'/,
);
// Marks, edits and the selection bar each animate once, when they first appear.
assert.match(indexHtml, /function rememberEditorMotion\(\)/);
assert.match(indexHtml, /seenMarks\.has\(m\.id\) \? "" : " m-fade"/);
assert.match(indexHtml, /seenEdits\.has\(e\.id\) \? "" : "m-up"/);
assert.match(indexHtml, /const selbarEnter = selIds\.length && !selbarShown \? ' m-fade' : '';/);
// A dropdown and a helper body fade on the render that opens them, not after.
assert.match(indexHtml, /openMenuSeen === row\.id \? '' : ' s-fade'/);
assert.match(indexHtml, /openHelperSeen === name \? '' : ' s-fade'/);
assert.doesNotMatch(indexHtml, /\.set-pane\{[^}]*animation/);
assert.doesNotMatch(indexHtml, /\.set-menu\{[^}]*animation/);
assert.doesNotMatch(indexHtml, /\.set-h-body\{[^}]*animation/);

// The prototypes' own timings, verbatim.
assert.match(indexHtml, /\.m-zoom\{animation:zoomIn 320ms var\(--ease\) backwards\}/);
assert.match(indexHtml, /\.m-grid\{animation:gridIn 320ms var\(--ease\) backwards\}/);
assert.match(indexHtml, /\.m-up\{animation:slideUp 250ms var\(--ease\) backwards\}/);
assert.match(indexHtml, /\.m-left\{animation:fromLeft 340ms var\(--ease\) backwards\}/);
assert.match(indexHtml, /\.m-right\{animation:fromRight 340ms var\(--ease\) 40ms backwards\}/);
// Settings fades at 200ms, per its own DC — not the app's 250ms.
assert.match(indexHtml, /\.s-fade\{animation:fadeIn 200ms ease backwards\}/);
// Press: 150ms for colour and shadow, 120ms for the squash.
assert.match(indexHtml, /transition:background-color 150ms ease,box-shadow 150ms ease,opacity 150ms ease,color 150ms ease,transform 120ms ease/);
// The page and its thumbnail carry the editor DC's own transitions.
assert.match(indexHtml, /\.pg\{[^}]*transition:box-shadow var\(--d-quick\) ease,transform 200ms var\(--ease\)\}/);
assert.match(indexHtml, /\.cr-prog \.fill\{[^}]*transition:width 120ms linear\}/);
assert.match(indexHtml, /\.sw\{[^}]*transition:background 160ms ease/);
assert.match(indexHtml, /\.sw i\{[^}]*transition:transform 160ms var\(--ease\)\}/);
// Every entrance collapses under reduced motion.
assert.match(indexHtml, /@media \(prefers-reduced-motion:reduce\)\{\.m-zoom,\.m-grid,\.m-fade,\.m-up,\.m-left,\.m-right,\.ed-mark\{animation-duration:1ms\}\}/);
assert.match(indexHtml, /@media \(prefers-reduced-motion:reduce\)\{\.s-fade\{animation-duration:1ms\}\}/);

// ---- Editor: a real document, absorbed from the server ----
/* These are node:test cases rather than bare assertions because they describe a
   contract with the backend and are worth naming individually. */
const {test} = require('node:test');

const snapshotWithPages = (ids, revision = 0) => ({
  session: {id: 's1'},
  revision,
  canUndo: false,
  canRedo: false,
  engineState: 'open',
  capabilities: {preview: {state: 'ready', detail: ''}},
  document: {
    pageCount: ids.length,
    title: null,
    pages: ids.map((id, i) => ({pageId: id, index: i, width: 612, height: 792, rotation: 0, sourceIndex: i})),
  },
});

test('a fresh state is an empty document, not twenty-four invented pages', () => {
  const e = createEditorState();
  assert.equal(e.state.pages.length, 0);
  assert.equal(e.state.sessionId, null);
  assert.equal(e.state.revision, -1);
});

test('placeholder pages remain available for the empty state', () => {
  assert.equal(makePages(4).length, 4);
});

test('absorbing a snapshot replaces the page model wholesale', () => {
  const e = createEditorState();
  e.absorb({session: {id: 's1'}, revision: 0, canUndo: false, canRedo: false,
            engineState: 'open',
            capabilities: {preview: {state: 'ready', detail: ''}},
            document: {pageCount: 1, title: null, pages: [
              {pageId: 'p1', index: 0, width: 612, height: 792, rotation: 0, sourceIndex: 0}]}});
  assert.equal(e.state.pages.length, 1);
  assert.equal(e.state.pages[0].id, 'p1');
  assert.equal(e.state.sessionId, 's1');
});

test('selection is filtered to surviving pages, never merged', () => {
  const e = createEditorState();
  e.absorb(snapshotWithPages(['p1', 'p2']));
  e.select('p2');
  e.absorb(snapshotWithPages(['p1']));
  assert.deepEqual(Object.keys(e.state.sel), []);
  assert.equal(e.state.focus, 'p1');
});

test('rotation is normalized to the quarter turns FreeDF accepts', () => {
  const e = createEditorState();
  assert.equal(e.normalizeRotation(-90), 270);
  assert.equal(e.normalizeRotation(360), 0);
  assert.equal(e.normalizeRotation(-180), 180);
});

// ---- Editor: capability-driven tool state ----
/* The engine reports a state and a detail per operation. The UI reads those
   directly: it never infers OCR's state from capabilities.ocr, and never
   substitutes a message of its own for the engine's detail. */
const stateWithCaps = caps => {
  const e = createEditorState();
  e.absorb({...snapshotWithPages(['p1']), capabilities: caps});
  return e;
};

test('crop follows the engine operation state', () => {
  const e = stateWithCaps({operations: [{kind: 'crop_pages', state: 'ready', detail: ''}]});
  assert.equal(e.toolState('crop').enabled, true);
});

test('an unavailable OCR offers an install, a blocked one does not', () => {
  const missing = stateWithCaps({operations: [
    {kind: 'add_text_layer', state: 'unavailable', detail: 'Tesseract executable not found'}]});
  assert.equal(missing.toolState('ocr').state, 'unavailable');
  assert.equal(missing.toolState('ocr').action, 'install');

  const blocked = stateWithCaps({operations: [
    {kind: 'add_text_layer', state: 'blocked', detail: '3 streams use filters this version cannot decode'}]});
  assert.equal(blocked.toolState('ocr').state, 'blocked');
  assert.equal(blocked.toolState('ocr').action, null);
});

test('a broken backend is distinguished from an absent one', () => {
  const e = stateWithCaps({operations: [
    {kind: 'add_text_layer', state: 'error', detail: 'tesseract exited 139'}]});
  assert.equal(e.toolState('ocr').state, 'error');
  assert.equal(e.toolState('ocr').detail, 'tesseract exited 139');
});

test('tools with no engine operation report unimplemented', () => {
  const e = stateWithCaps({operations: [{kind: 'crop_pages', state: 'ready', detail: ''}]});
  assert.equal(e.toolState('redact').state, 'unimplemented');
});

test('the engine detail is never replaced by a generic message', () => {
  const e = stateWithCaps({operations: [
    {kind: 'add_text_layer', state: 'unavailable', detail: 'Tesseract executable not found: tesseract'}]});
  assert.match(e.toolState('ocr').detail, /Tesseract executable not found/);
});

test('an error offers a recheck, not an install', () => {
  const e = stateWithCaps({operations: [
    {kind: 'crop_pages', state: 'error', detail: 'boom'}]});
  assert.equal(e.toolState('crop').action, 'recheck');
  assert.equal(e.toolState('crop').enabled, false);
});

test('select needs no engine operation and is always available', () => {
  const e = createEditorState();
  assert.equal(e.toolState('select').state, 'ready');
  assert.equal(e.toolState('select').enabled, true);
});

test('before any document is open a real tool is unknown, not unimplemented', () => {
  const e = createEditorState();
  assert.equal(e.toolState('crop').state, 'unknown');
  assert.equal(e.toolState('crop').enabled, false);
});

// ---- Editor: structural-operation consistency ----
/* These tests fail if a destructive or server-assigned operation is made
   optimistic, if a second request can race the first, or if a failed optimistic
   change leaves the page model diverged from the engine. */
const stateWithPages = ids => {
  const e = createEditorState();
  e.absorb(snapshotWithPages(ids));
  return e;
};

test('rotate applies locally before the server answers', () => {
  const e = stateWithPages(['p1']);
  e.rotate(90);
  assert.equal(e.state.pages[0].rot, 90);
  assert.equal(e.state.pending.kind, 'rotate_pages');
});

test('delete waits for the server', () => {
  const e = stateWithPages(['p1', 'p2']);
  e.select('p1');
  e.remove();
  assert.equal(e.state.pages.length, 2);
});

test('insert waits because the engine assigns the page id', () => {
  const e = stateWithPages(['p1']);
  e.insert();
  assert.equal(e.state.pages.length, 1);
});

test('only one mutation is in flight at a time', () => {
  const e = stateWithPages(['p1']);
  e.beginPending({kind: 'rotate_pages'});
  assert.equal(e.canMutate(), false);
  assert.equal(e.rotate(90), false);
});

test('a rejected optimistic rotate restores the page snapshot', () => {
  const e = stateWithPages(['p1']);
  e.rotate(90);
  e.rejectPending('operation-invalid');
  assert.equal(e.state.pages[0].rot, 0);
  assert.equal(e.state.edits.length, 0);
  assert.equal(e.state.pending, null);
});

test('the server snapshot overwrites a diverged local model', () => {
  const e = stateWithPages(['p1']);
  e.rotate(90);
  e.absorb(snapshotWithPages(['p1'], 1));
  e.absorb({ ...snapshotWithPages(['p1'], 2), document: {
    ...snapshotWithPages(['p1'], 2).document,
    pages: [{pageId: 'p1', rotation: 180, index: 0, width: 1, height: 1, sourceIndex: 0}],
  }});
  assert.equal(e.state.pages[0].rot, 180);
  assert.equal(e.state.pending, null);
});

test('only rotate and reorder are optimistic structural operations', () => {
  assert.deepEqual(OPTIMISTIC, {
    rotate: true, reorder: true, delete: false, insert: false, crop: false,
    ocr: false, undo: false, redo: false, save: false,
  });
});

// ---- Editor: server-owned undo, redo, and edit history ----
test('undo and redo controls follow the server flags', () => {
  const e = createEditorState();
  e.absorb({...snapshotWithPages(['p1']), canUndo: true, canRedo: false});
  assert.equal(e.state.canUndo, true);
  assert.equal(e.state.canRedo, false);
});

test('the edits pane describes the server operation log', () => {
  assert.equal(describeOp({kind: 'rotate_pages', pageIds: ['p1'], degrees: 90}),
    'Rotated 1 page by 90°');
  assert.equal(describeOp({kind: 'add_text_layer', pageIds: ['p1', 'p2']}),
    'Added a text layer to 2 pages');
  const e = createEditorState();
  e.absorb({...snapshotWithPages(['p1']), operations: [
    {kind: 'rotate_pages', pageIds: ['p1'], degrees: 90},
  ]});
  assert.deepEqual(e.state.edits.map(edit => edit.text), ['Rotated 1 page by 90°']);
});

test('a full-page crop rectangle maps to the full media box', () => {
  assert.deepEqual(cropBoxToPoints({x: 0, y: 0, w: 100, h: 100}, {w: 612, h: 792}),
    [0, 0, 612, 792]);
});

test('crop conversion flips DOM y-down to PDF y-up', () => {
  assert.deepEqual(cropBoxToPoints({x: 0, y: 0, w: 100, h: 25}, {w: 612, h: 792}),
    [0, 594, 612, 792]);
});

test('crop conversion clamps the display rectangle and rejects zero area', () => {
  assert.deepEqual(cropBoxToPoints({x: -10, y: 80, w: 30, h: 40}, {w: 100, h: 200}),
    [0, 0, 20, 40]);
  assert.equal(cropBoxToPoints({x: 10, y: 10, w: 0, h: 20}, {w: 612, h: 792}), null);
});

test('a 90 degree canvas drag is inverse-mapped before crop conversion', () => {
  // At +90° CSS rotation, screen (x, y) is source (y, 100 - x).
  assert.deepEqual(screenPointToPagePercent({x: 20, y: 30}, 90), {x: 30, y: 80});
});

test('OCR is never optimistic and posts engine capability defaults for all pages', async () => {
  const e = createEditorState();
  e.absorb({...snapshotWithPages(['p1', 'p2']), capabilities: {
    ocr: {languages: ['eng'], modes: ['lstm']},
    operations: [{kind: 'add_text_layer', state: 'ready', detail: ''}],
  }});
  const requests = [];
  const context = {editor: e, render() {}, showToast() {}, encodeURIComponent, JSON, Promise,
    fetch: async (_route, request) => { requests.push(JSON.parse(request.body)); return {ok: true, json: async () => snapshotWithPages(['p1', 'p2'], 1)}; }};
  context.self = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'workspaces', 'editor', 'editor-actions.js'), 'utf8'), context);
  await context.OneToolEditorActions.addOcr();
  assert.deepEqual(requests[0].operations, [{kind: 'add_text_layer', pageIds: ['p1', 'p2'], language: 'eng', mode: 'lstm', dpi: 300, minConfidence: 0}]);
  assert.equal(OPTIMISTIC.ocr, false);
});

test('an in-flight OCR request blocks further editor mutations', () => {
  const e = stateWithPages(['p1']);
  e.beginPending({kind: 'add_text_layer'});
  assert.equal(e.state.pending.kind, 'add_text_layer');
  assert.equal(e.canMutate(), false);
});

test('typed recovery errors transition the editor without losing authoritative history', () => {
  const e = stateWithPages(['p1']);
  e.state.edits = [{id: '0:rotate_pages', text: 'Rotated 1 page by 90°'}];
  e.recover({code: 'source-changed', message: 'source changed'});
  assert.equal(e.state.recovery, 'frozen');
  assert.equal(e.canMutate(), false);
  e.recover({code: 'engine-error', message: 'boom'});
  assert.equal(e.state.recovery, 'degraded');
  assert.equal(e.state.edits.length, 1);
  e.recover({code: 'session-unknown', message: 'gone'});
  assert.equal(e.state.sessionId, null);
  assert.equal(e.state.pages.length, 0);
});

test('failed preview images use the named unavailable-preview fallback', () => {
  assert.match(indexHtml, /function editorImageFailed\(image\)/);
  assert.match(indexHtml, /onerror="editorImageFailed\(this\)"/);
  assert.match(indexHtml, /Previews unavailable/);
});

test('Ctrl+Space toggles reader mode when the file picker keeps focus', () => {
  let keydown = null;
  let renders = 0;
  let prevented = false;
  const context = {
    document: {
      activeElement: {tagName: 'INPUT', type: 'file'},
      addEventListener(type, handler) { if (type === 'keydown') keydown = handler; },
    },
    page: 'editor', settingsOpen: false, paletteOpen: false,
    editor: {
      state: {mode: 'grid'},
      toggleMode() { this.state.mode = 'reader'; },
    },
    render() { renders += 1; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'interaction', 'keyboard.js'), 'utf8'), context);
  keydown({key: ' ', code: 'Space', ctrlKey: true, metaKey: false,
    preventDefault() { prevented = true; }, target: {}});
  assert.equal(context.editor.state.mode, 'reader');
  assert.equal(renders, 1);
  assert.equal(prevented, true);
});

test('undo waits for and absorbs the server snapshot', async () => {
  const e = createEditorState();
  e.absorb({...snapshotWithPages(['p1']), canUndo: true});
  const requests = [];
  const context = {
    editor: e, render() {}, showToast() {}, encodeURIComponent, JSON, Promise,
    fetch: async (route, request) => {
      requests.push({route, body: JSON.parse(request.body)});
      return {ok: true, json: async () => ({...snapshotWithPages(['p1'], 1), canUndo: false, canRedo: true})};
    },
  };
  context.self = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'workspaces', 'editor', 'editor-actions.js'), 'utf8'), context);
  await context.OneToolEditorActions.undo();
  assert.deepEqual(requests, [{route: '/api/editor/undo', body: {sessionId: 's1'}}]);
  assert.equal(e.state.canUndo, false);
  assert.equal(e.state.canRedo, true);
  assert.equal(e.state.pending, null);
});

test('a second optimistic request cannot reuse an in-flight rotate', async () => {
  const e = stateWithPages(['p1']);
  e.rotate(90);
  let requests = 0;
  const context = {
    editor: e, render() {}, showToast() {}, encodeURIComponent, JSON, Promise,
    fetch: async () => {
      requests += 1;
      return {ok: true, json: async () => snapshotWithPages(['p1'], 1)};
    },
  };
  context.self = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'workspaces', 'editor', 'editor-actions.js'), 'utf8'), context);
  await context.OneToolEditorActions.applyOperations([
    {kind: 'rotate_pages', pageIds: ['p1'], degrees: 90},
  ], {optimistic: true});
  assert.equal(requests, 0);
  assert.equal(e.state.pending.kind, 'rotate_pages');
});

test('reorder posts the locally previewed page order', async () => {
  const e = stateWithPages(['p1', 'p2']);
  const requests = [];
  const context = {
    editor: e, render() {}, showToast() {}, encodeURIComponent, JSON, Promise,
    fetch: async (_route, request) => {
      requests.push(JSON.parse(request.body));
      return {ok: true, json: async () => snapshotWithPages(['p2', 'p1'], 1)};
    },
  };
  context.self = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'workspaces', 'editor', 'editor-actions.js'), 'utf8'), context);
  await context.OneToolEditorActions.reorder(['p2', 'p1']);
  assert.deepEqual(e.state.pages.map(p => p.id), ['p2', 'p1']);
  assert.deepEqual(requests, [{sessionId: 's1', operations: [
    {kind: 'reorder_pages', pageIds: ['p2', 'p1']},
  ], dryRun: false}]);
});

// The rail carries the engine's own detail into the disabled button.
assert.match(indexHtml, /aria-disabled="\$\{/);
assert.match(indexHtml, /data-tool-state="\$\{/);
assert.match(indexHtml, /Recognizing…/);

// The grid renders the engine's own renderings, and asks the browser for them
// only when they scroll into view.
assert.match(indexHtml, /\/api\/editor\/page\.png\?session=/);
assert.match(indexHtml, /loading="lazy"/);
// Tiles are sized from the width and height the engine returned, never from the
// width that was requested: FreeDF's "width" is a bounding box.
assert.match(indexHtml, /aspect-ratio:\$\{page\.w\} \/ \$\{page\.h\}/);
assert.match(rawIndexHtml, /<script src="\/workspaces\/editor\/editor-actions\.js"><\/script>/);

console.log('UI action-state regression tests passed');
