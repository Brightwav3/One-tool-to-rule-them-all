const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mainJs = fs.readFileSync(path.join(__dirname, '..', 'app', 'main.js'), 'utf8');
const preloadJs = fs.readFileSync(path.join(__dirname, '..', 'app', 'preload.js'), 'utf8');
const actionState = require('../converter/ui/action-state.js');
const panelResize = require('../converter/ui/panel-resize.js');
const shortcutLabels = require('../converter/ui/shortcut-labels.js');
const selectionState = require('../converter/ui/selection-state.js');

const indexHtml = fs.readFileSync(
  path.join(__dirname, '..', 'converter', 'ui', 'index.html'),
  'utf8',
);
const fidelioB = fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'fidelioB.svg'), 'utf8');
const fidelioW = fs.readFileSync(path.join(__dirname, '..', 'converter', 'ui', 'fidelioW.svg'), 'utf8');
assert.match(indexHtml, /<script src="\/action-state\.js"><\/script>/);
assert.match(indexHtml, /<script src="\/panel-resize\.js"><\/script>/);
assert.match(indexHtml, /<script src="\/selection-state\.js"><\/script>/);
assert.match(indexHtml, /<script src="\/shortcut-labels\.js"><\/script>/);
assert.doesNotMatch(indexHtml, /<script src="\/ui\/action-state\.js"><\/script>/);

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
assert.equal(panelResize.clampPanelWidth(180, 980), 240);
assert.equal(panelResize.clampPanelWidth(640, 980), 520);
assert.equal(panelResize.widthFromDrag(308, 700, 760, 980), 248);
assert.equal(panelResize.widthFromDrag(308, 700, 500, 980), 508);
assert.match(indexHtml, /class="[^"]*panel-resize/);
assert.match(indexHtml, /data-panel-resize/);
assert.match(indexHtml, /<div class="work-resize panel-resize" data-panel-resize/);
assert.equal(shortcutLabels.label('palette', true), '⌘K');
assert.equal(shortcutLabels.label('palette', false), 'Ctrl K');
assert.equal(shortcutLabels.label('inspector', true), '⌥I');
assert.equal(shortcutLabels.label('inspector', false), 'Alt I');
assert.equal(shortcutLabels.label('open', false), 'Ctrl O');
assert.match(indexHtml, /data-shortcut="palette"/);
assert.match(indexHtml, /data-shortcut="inspector"/);
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
// A queued file is not on disk yet, so double-click renames it; a history record
// is a real file, so double-click still reveals it.
assert.match(indexHtml, /event\.detail === 2 && act === 'select-row'/);
assert.match(indexHtml, /event\.detail === 2 && act === 'select-history'/);
assert.match(indexHtml, /return startRename\(file\.id\)/);
assert.match(indexHtml, /contextItem\('Rename output…', 'rename-queue'/);
assert.match(indexHtml, /id="renameField"/);
assert.match(indexHtml, /data-act="reveal-file"/);
assert.match(indexHtml, /data-reveal-kind/);
// the queue's folder button opens the file you dropped, which exists, rather
// than the output, which does not exist until the conversion has run
assert.match(indexHtml, /\$\{folderIcon\(f\.sourcePath, 'queue'\)\}/);
assert.match(indexHtml, /\$\{folderIcon\(r\.outputPath, 'history'\)\}/);
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
assert.match(indexHtml, /@media \(max-width:640px\)\{\.app\{min-width:0\}\.left\{display:none\}\.panel\[data-open="true"\]\{width:100%!important\}\}/);

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
assert.match(indexHtml, /themeToggle/);
assert.match(indexHtml, /fidelioB\.svg/);
assert.match(indexHtml, /fidelioW\.svg/);
assert.match(indexHtml, /\.theme-logo/);
assert.match(indexHtml, /Change theme/);
assert.match(indexHtml, /one-tool\.theme/);
assert.match(indexHtml, /theme-spin/);
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
assert.match(indexHtml, /<div class="empty-glyph">\s*<svg[^>]*viewBox="0 0 48 48"[^>]*aria-label="Drop files here"/s);
assert.match(indexHtml, /<g class="ia-drop"><path d="M24 10v18"\/><path d="M17 21l7 7 7-7"\/><\/g>\s*<path class="ia-tray" d="M12 32v4a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2v-4"\/>/);
assert.doesNotMatch(indexHtml, /\.empty-glyph\{[^}]*background:/);
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
assert.match(indexHtml, /document\.querySelector\('\[data-panel-resize\]'\)/);
assert.match(indexHtml, /\.work\{margin:0;border:1px solid var\(--sep\);border-left:0;border-bottom:0;border-radius:0 14px 0 0/);
assert.match(indexHtml, /class="folder" width="48" height="48" viewBox="0 0 48 48"/);
assert.match(indexHtml, /\.folder:hover \.fdr-front\{transform:scaleY\(\.72\) rotate\(4deg\)\}/);
assert.match(indexHtml, /\.folder:hover \.fdr-sheet\{transform:translateY\(-11px\)\}/);
assert.doesNotMatch(indexHtml, /data-act="reveal-file"[^>]* disabled/);
assert.doesNotMatch(indexHtml, /class="thumb" aria-hidden="true"><span>\$\{esc\(thumbLabel\(f\)\)/);
assert.match(indexHtml, /html,body,\*\{-webkit-user-select:none;user-select:none\}/);
assert.match(indexHtml, /input,textarea,\[contenteditable="true"\]\{-webkit-user-select:text;user-select:text\}/);

// ---- Convert view: two top-level views, history lives under the queue ----
// Only Convert and Helpers are navigable; History is no longer a page of its own.
const navPages = [...indexHtml.matchAll(/data-page="([a-z]+)"/g)].map(m => m[1]);
assert.deepEqual([...new Set(navPages)].sort(), ['convert', 'helpers']);
assert.doesNotMatch(indexHtml, /data-page="queue"/);
assert.doesNotMatch(indexHtml, /data-page="history"/);
assert.doesNotMatch(indexHtml, /<section class="page" id="pageHistory"/);
assert.match(indexHtml, /const pages = \{ convert: \$\('pageConvert'\), helpers: \$\('pageHelpers'\) \};/);
assert.match(indexHtml, /let page='convert',/);

// The queue block and the history block are stacked inside the one Convert page,
// history second, so the converted-file list sits under the queue/empty-state box.
const convertPage = indexHtml.match(
  /<section class="page" id="pageConvert"[\s\S]*?<\/section>/,
)[0];
assert.match(convertPage, /id="convertSplit"/);
assert.ok(
  convertPage.indexOf('id="pageQueue"') < convertPage.indexOf('id="pageHistory"'),
  'history must render below the queue',
);
assert.match(indexHtml, /\.convert-queue\{[^}]*overflow:auto/);
assert.match(indexHtml, /\.convert-history\{[^}]*overflow:auto/);

// The border between the queue and the history is the drag handle that splits
// the height between them.
assert.match(convertPage, /data-split-resize/);
assert.ok(
  convertPage.indexOf('data-split-resize') > convertPage.indexOf('id="pageQueue"')
    && convertPage.indexOf('data-split-resize') < convertPage.indexOf('id="pageHistory"'),
  'the split handle must sit on the border between the two panes',
);
assert.match(indexHtml, /\.convert-split-handle\{[^}]*cursor:ns-resize/);
assert.match(indexHtml, /one-tool\.convert-split/);
assert.match(indexHtml, /splitResizeHandle\?\.addEventListener\('pointerdown', startSplitResize\)/);

// The history section no longer carries the old page heading and blurb.
assert.doesNotMatch(indexHtml, /<h1>History<\/h1>/);
assert.doesNotMatch(indexHtml, /Every file this tool has written/);

// Split sizing keeps both panes alive.
assert.equal(panelResize.clampSplitHeight(10, 800), 96);
assert.equal(panelResize.clampSplitHeight(5000, 800), 704);
assert.equal(panelResize.clampSplitHeight(300, 800), 300);
assert.equal(panelResize.splitHeightFromDrag(300, 100, 160, 800), 360);
assert.equal(panelResize.splitHeightFromDrag(300, 100, 40, 800), 240);
assert.equal(panelResize.splitHeightFromDrag(120, 100, 20, 800), 96);
assert.match(indexHtml, /queueSlot\.innerHTML/);
assert.match(indexHtml, /historySlot\.innerHTML/);

// The queue's empty state and the history list both still render on Convert.
assert.match(indexHtml, /class="empty-inner empty-drop" id="dropZone"/);
// the empty-queue box grows and shrinks with the queue pane
assert.match(indexHtml, /\.convert-split \.empty\{flex:1 1 auto;min-height:0;overflow:hidden;padding:clamp\(/);
// the box scales as one against the pane height: nothing is hidden at any size
assert.match(indexHtml, /\.convert-queue:has\(\.empty\)\{container:convertqueue \/ size\}/);
['\.empty \.empty-glyph', '\.empty h1', '\.empty p', '\.empty \.actions'].forEach(sel => {
  assert.match(indexHtml, new RegExp(`\.convert-split ${sel}[^\n]*cqh`), `${sel} must scale with the pane`);
});
assert.doesNotMatch(indexHtml, /@container convertqueue[^@]*display:none/);
assert.doesNotMatch(indexHtml, /min-height:min-content/);
assert.match(indexHtml, /\.convert-split \.empty \.empty-inner\{align-self:stretch/);
assert.match(indexHtml, /Nothing has been converted yet\./);

// Existing queue and history actions survive the merge.
['convert', 'clear', 'add', 'history-sort', 'history-filter', 'history-requeue',
 'history-delete', 'history-deselect', 'check-history', 'check-all',
 'select-history', 'select-row', 'requeue-one', 'reveal-history'].forEach(act => {
  assert.match(indexHtml, new RegExp(`data-act="${act}"`), `missing data-act="${act}"`);
});
assert.match(indexHtml, /if \(next === 'convert'\) loadHistory\(\);/);
// Enter still converts from the Convert view.
assert.match(indexHtml, /page === 'convert'\) \{ event\.preventDefault\(\); convert\(\); \}/);
// The inspector serves the history record when one is picked, the queue otherwise.
assert.match(indexHtml, /if \(selectedHistory\) return panelHistory\(\);/);

console.log('UI action-state regression tests passed');
