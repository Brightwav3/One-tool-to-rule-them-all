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
assert.match(indexHtml, /data-multi-selected/);
assert.match(indexHtml, /selectedQueueIds/);
assert.match(indexHtml, /shiftKey/);
assert.match(indexHtml, /ctrlKey \|\| event\.metaKey/);
assert.match(indexHtml, /pointerdown/);
assert.match(indexHtml, /remove-many/);
assert.match(indexHtml, /data-act="requeue-one"[^>]*>Queue again</);
assert.doesNotMatch(indexHtml, /data-act="requeue-one"[^>]*>Convert \$\{esc\(r\.sourceName/);

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
assert.match(indexHtml, /<path d="M24 10v18"\/>\s*<path d="M17 21l7 7 7-7"\/>\s*<path d="M12 32v4a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2v-4"\/>/);
assert.doesNotMatch(indexHtml, /\.empty-glyph\{[^}]*background:/);
assert.match(mainJs, /backgroundColor:\s*'#f2f2f4'/);
assert.match(indexHtml, /\.body\{[^}]*padding-top:44px/);
assert.match(indexHtml, /\.topbar\{[^}]*position:absolute;top:0;left:0;right:0/);
assert.match(indexHtml, /\.work\{margin:0;border:0;border-radius:0 14px 0 0/);

console.log('UI action-state regression tests passed');
