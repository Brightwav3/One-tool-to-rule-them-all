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

