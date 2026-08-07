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
  const real = hasRendering(page);
  /* A real page keeps its own proportions inside the cell; the placeholder page
     fills the cell, because it has none of its own. */
  const box = real
    ? `height:${rotated ? '72%' : '100%'};width:auto;max-width:${rotated ? '138%' : '100%'};aspect-ratio:${page.w} / ${page.h}`
    : `width:${rotated ? '138%' : '100%'};height:${rotated ? '72%' : '100%'}`;
  return `<button class="pthumb press" data-act="${act}" data-id="${page.id}" data-on="${on}" data-dim="${dim}">
    <span class="pthumb-box"><span class="pg${real ? ' pg-real' : ''}" style="${box};transform:rotate(${page.rot}deg)">
      ${pageBodyHtml(page, false)}
    </span></span>
    <span class="tcap">${esc(pageCaption(page, index))}</span>
  </button>`;
}
/* A real page is the engine's own rendering; the ruled placeholder is what the
   empty state shows. `loading="lazy"` is the whole of the grid's laziness: the
   browser fetches a thumbnail when it scrolls into view and not before.
   The aspect ratio comes from the width and height the engine reported, never
   from the width that was requested — FreeDF's render width is a bounding box,
   so a landscape page asked for at 180 comes back 255 wide and 180 tall. */
const hasRendering = page => Boolean(editor.state.sessionId && page.w && page.h);
function pageBodyHtml(page, big) {
  if (hasRendering(page)) {
    return `<img class="pg-img" src="${esc(OneToolEditorActions.pageImageUrl(page))}" loading="lazy" decoding="async"
      alt="" width="${page.w}" height="${page.h}"
      style="width:100%;height:100%;aspect-ratio:${page.w} / ${page.h};display:block;object-fit:contain">`;
  }
  return (page.lines || []).map(l => `<span class="ln" style="${lineStyle(l, big)}"></span>`).join('');
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
  /* Before a document is opened the grid shows what it is for: ruled ghosts of
     pages, and the one button that matters. */
  if (!s.sessionId) return editorEmptyHtml();
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
/* The ghosts are the placeholder page model, drawn once and never selectable:
   nothing here is a page, so nothing here can be acted on. */
const EMPTY_GHOSTS = OneToolEditorState.makePages(8);
function editorEmptyHtml() {
  return `
    <div class="ed-head">
      <div style="flex:1;min-width:0"><h1 class="wk-h1">No document open</h1></div>
      <button class="pbtn pri press" data-act="ed-open-doc">Open a PDF</button>
    </div>
    <div class="${enterEditor("m-grid")}" style="flex:1;min-height:0;overflow:auto;padding:16px 18px">
      <div class="ed-grid" aria-hidden="true" style="opacity:.35;pointer-events:none">
        ${EMPTY_GHOSTS.map((p, i) => thumbHtml(p, i, false, false, 'ed-noop')).join('')}
      </div>
    </div>
    <div class="ed-foot">
      <span style="flex:1;font-size:12.5px;color:var(--t2)">Open a PDF to edit its pages</span>
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
      <button class="pg ${hasRendering(page) ? 'pg-real ' : ''}ed-canvas ${enterEditor("m-zoom")}" data-act="ed-canvas" data-redact="${s.tool === 'redact'}" style="width:${Math.round(392 * s.zoom / 96)}px;${hasRendering(page) ? `aspect-ratio:${page.w} / ${page.h};` : ''}transform:rotate(${page.rot}deg)">
        ${pageBodyHtml(page, true)}
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

