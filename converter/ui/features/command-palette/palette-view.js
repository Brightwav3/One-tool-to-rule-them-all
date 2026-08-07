function paletteItems() {
  const q = query.trim().toLowerCase();
  const conversions = tools.filter(t => !q || `${t.label} ${t.blurb || ''} ${t.from} ${t.to}`.toLowerCase().includes(q)).slice(0, 12);
  const actions = [
    {id:'add', label:'Add files', detail:'Open the file picker'},
    {id:'helpers', label:'Open Helpers', detail:'Settings, helper installers'},
    {id:'settings', label:'Open Settings', detail:'App-wide preferences'},
    {id:'history', label:'Show converted files', detail:'Jump to the history below the queue'},
  ].filter(a => !q || `${a.label} ${a.detail}`.toLowerCase().includes(q));
  return {conversions, actions};
}
function paletteHtml() {
  const {conversions, actions} = paletteItems();
  let index = 0; const rows = [];
  if (conversions.length) {
    rows.push('<span class="pal-group">Conversions</span>');
    conversions.forEach(t => { rows.push(`<button class="pal-item press ${index === commandIndex ? 'active' : ''}" data-act="palette-conversion" data-id="${esc(t.id)}">
      <span class="g"><span>${esc(t.to)}</span></span><span class="l">${esc(t.label)}</span><span class="s ${routeStateClass(t)}">${routeStateLabel(t)}</span></button>`); index++; });
  }
  if (actions.length) {
    rows.push('<span class="pal-group">Actions</span>');
    actions.forEach(a => { rows.push(`<button class="pal-item press ${index === commandIndex ? 'active' : ''}" data-act="palette-action" data-action="${esc(a.id)}">
      <span class="g"><span>→</span></span><span class="l">${esc(a.label)}</span><span class="s">${esc(a.detail)}</span></button>`); index++; });
  }
  return `<div class="pal-head"><span aria-hidden="true" style="color:var(--text-tertiary)">⌕</span>
      <input id="palInput" data-live="true" placeholder="Search conversions, files, helpers" value="${esc(query)}"><span class="kbd">esc</span></div>
    <div class="pal-body">${rows.join('') || '<div class="pal-empty">No matching commands.</div>'}</div>`;
}

