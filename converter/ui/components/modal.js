/* ---------- overlays ---------- */
function renderOverlays() {
  const archiveOpen = Boolean(archivePromptId);
  $('archiveScrim').dataset.open = String(archiveOpen);
  if (archiveOpen) {
    const file = files.find(f => f.id === archivePromptId);
    $('archiveName').textContent = file?.name || 'protected archive';
    $('archiveError').textContent = archivePromptError;
    $('archiveError').hidden = !archivePromptError;
  }
  const sheetOpen = Boolean(sheetFor);
  $('sheetScrim').dataset.open = String(sheetOpen);
  if (sheetOpen) $('sheetBox').innerHTML = sheetHtml();
  $('palScrim').dataset.open = String(paletteOpen);
  if (paletteOpen) {
    const focused = document.activeElement?.id === 'palInput';
    const caret = focused ? document.activeElement.selectionStart : null;
    $('palBox').innerHTML = paletteHtml();
    const input = $('palInput');
    if (input) { input.focus(); if (caret !== null) input.setSelectionRange(caret, caret); }
  }
}
function sheetFile() { return files.find(f => f.id === sheetFor) || null; }
function sheetHtml() {
  const f = sheetFile(); if (!f) return '';
  const cats = [...new Set(tools.map(t => t.cat).filter(Boolean))];
  const active = sheetCat && cats.includes(sheetCat) ? sheetCat : (cats[0] || null);
  const seen = new Set(); const dests = [];
  tools.forEach(t => {
    if (seen.has(t.to)) return; seen.add(t.to);
    const applicable = tools.filter(i => i.to === t.to && i.from === f.from).sort((a,b) => (RANK[a.state]??3)-(RANK[b.state]??3))[0];
    dests.push({tool: applicable || t, applicable: Boolean(applicable)});
  });
  const q = sheetQuery.trim().toLowerCase();
  const shown = dests.filter(d => (!active || d.tool.cat === active) && (!q || d.tool.to.toLowerCase().includes(q)));
  const catCount = c => dests.filter(d => d.tool.cat === c).length;
  return `
    <div class="sheet-head">
      ${fileThumb(f)}
      <div style="flex:1;min-width:0"><div class="t">${esc(f.name)}</div><div class="m">${esc(metaLine(f))} · ${esc(f.from)} source</div></div>
      ${folderIcon(f.sourcePath)}
      <button class="btn btn-ghost btn-sm press" data-act="close-sheet" aria-label="Close">${ICON.remove}</button>
    </div>
    <div class="sheet-body">
      <div class="sheet-cats">${cats.map(c => `<button class="cat press ${c === active ? 'active' : ''}" data-act="sheet-category" data-category="${esc(c)}"><span style="flex:1">${esc(c)}</span><span class="n">${catCount(c)}</span></button>`).join('')}</div>
      <div class="sheet-right">
        <div class="sheet-search"><span aria-hidden="true" style="color:var(--text-tertiary)">⌕</span><input id="sheetSearch" data-live="true" placeholder="Filter destinations" value="${esc(sheetQuery)}"></div>
        <div class="sheet-routes">
          ${shown.length ? shown.map(d => {
            const t = d.tool, current = t.to === (sheetPick || f.to);
            const label = d.applicable ? routeStateLabel(t) : (t.state === 'soon' ? 'Not built yet' : `No route from ${f.from}`);
            const disabled = !d.applicable || t.state === 'soon';
            return `<button class="opt press ${current ? 'current' : ''}" data-act="sheet-pick" data-to="${esc(t.to)}" ${disabled ? 'disabled' : ''}>
              <span class="ck">${current ? tickIcon(11) : ''}</span><span class="nm">${esc(t.to)}</span><span class="st ${d.applicable ? routeStateClass(t) : ''}">${esc(label)}</span></button>`;
          }).join('') : '<div class="page-empty">No destinations match.</div>'}
        </div>
      </div>
    </div>
    <div class="sheet-foot">
      <div class="path">${esc(f.out || commonFolder())}</div>
      <span style="display:flex;align-items:center;gap:var(--space-2)"><span class="eyebrow">Scope</span>
        <button class="scope press" data-act="cycle-scope">${esc(scopeLabel(f))}<span class="chev" aria-hidden="true">${chevron()}</span></button></span>
      <button class="btn btn-primary press" data-act="apply-sheet">Use this route<span class="kbd" style="background:rgba(255,255,255,.16);color:rgba(255,255,255,.72)">⏎</span></button>
    </div>`;
}
