/* ---------- one list ----------
   Queued work and written output share a single table; the state a row is in is
   a column, not a separate view. Rows from the queue keep their live progress
   and route picker; rows from the history keep their presence check. A written
   file that is still in the queue is shown once, from the queue. */
const U_FILTERS = [
  {id:'all', name:'All'}, {id:'active', name:'Active'}, {id:'completed', name:'Completed'},
  {id:'stopped', name:'Stopped'}, {id:'missing', name:'Missing'}, {id:'comics', name:'Comics'},
  {id:'images', name:'Images'}, {id:'documents', name:'Documents'}, {id:'video', name:'Video'},
];
const SORTS = {newest:'Newest', oldest:'Oldest', name:'Name', largest:'Largest'};
const HIST_STATE = {
  completed:{label:'On disk', cls:'ok'}, active:{label:'Converting', cls:'run'},
  uncompleted:{label:'Stopped', cls:'warn'}, missing:{label:'Missing', cls:'grey'},
};
const histCategory = r => String(toolMap[r.conv]?.cat || 'documents').toLowerCase();
const histState = r => r.presence === 'missing' ? 'missing' : (r.state || 'completed');
/* Live states come first, in the order work moves through them; the chosen sort
   decides everything after that. */
const U_RANK = ['running', 'queued', 'blocked', 'idle', 'error', 'stopped'];
const U_ACTIVE = ['running', 'queued', 'blocked', 'idle', 'stopped'];
const uRank = row => (U_RANK.indexOf(row.state) + 1) || 99;


const U_STATE = {
  idle:    () => ({label:'ready', tone:''}),
  queued:  () => ({label:'waiting', tone:'quiet', bar:true}),
  running: row => ({label: statusText(row.file), tone:'run', bar:true, shimmer: indeterminate(row.file)}),
  done:    () => ({label:'on disk', tone:'ok'}),
  stopped: () => ({label:'stopped', tone:'warn', bar:true}),
  missing: () => ({label:'missing', tone:'quiet'}),
  blocked: row => ({label: statusText(row.file), tone:'warn'}),
  error:   row => ({label: row.file ? statusText(row.file) : 'stopped', tone:'bad'}),
};
const blockingHelper = () => {
  const stuck = files.find(isBlocked);
  return stuck ? ((stuck.errorTitle || '').replace(/ isn.t installed.*/i, '').trim() || 'a helper') : 'a helper';
};

function renderConvert() {
  const rows = visibleRows(), all = convertRows();
  const ready = files.filter(f => f.status === 'idle' && !isBlocked(f)).length;
  const blocked = files.filter(isBlocked).length;
  const busy = files.filter(f => f.status === 'queued' || f.status === 'running').length;
  const done = files.filter(f => f.status === 'done').length;
  const written = all.filter(row => row.state === 'done').length;
  const shown = rows.filter(row => checked.has(row.id));
  const allOn = rows.length > 0 && shown.length === rows.length;
  const someOn = shown.length > 0 && !allOn;
  const summary = busy
    ? `Converting ${done} of ${done + busy} · ${blocked} waiting on ${blockingHelper()}`
    : `${ready} ready · ${blocked} waiting on ${blockingHelper()} · ${written} written`;
  const goLabel = ready > 1 ? `Convert ${ready}` : 'Convert';
  /* the last live row carries the rule that divides work from written output */
  const lastActive = rows.reduce((last, row, i) => U_ACTIVE.includes(row.state) ? i : last, -1);

  pages.convert.innerHTML = `
    <div class="u-wrap">
      <div class="u-head">
        <div class="u-controls">
          ${destinationHtml()}
          <button class="u-sort press" data-act="history-sort">${esc(SORTS[histSort])}<span class="chev" aria-hidden="true">${chevron(12, 'ia-spin')}</span></button>
          <button class="u-add press" data-act="add">Add files<span class="k" data-shortcut="open">${shortcutLabel('open')}</span></button>
        </div>
        <div class="u-chips">
          ${U_FILTERS.map(f => `<button class="u-chip press" data-act="history-filter" data-filter="${f.id}" data-on="${histFilter === f.id}">${f.name}<span class="n">${all.filter(row => uMatches(row, f.id)).length}</span></button>`).join('')}
        </div>
      </div>
      <div class="u-list" id="dropZone">
        <div class="u-headrow">
          <button class="check press ${allOn ? 'on' : ''}" data-act="check-all" aria-label="Select all" role="checkbox" aria-checked="${allOn}">${allOn ? tickIcon(10) : someOn ? '<span style="font-size:9px">–</span>' : ''}</button>
          <span class="u-h-tile"></span>
          <span style="flex:1;min-width:0">File</span>
          <span class="u-h-conv">Conversion</span><span class="u-h-status">Status</span>
          <span class="u-h-size">Size</span><span class="u-h-when">Written</span>
        </div>
        <div class="u-scroll">
          ${pendingAdd ? skeletonHtml() : ''}
          ${rows.map((row, i) => unifiedRow(row, i, lastActive)).join('')}
          ${!rows.length && !pendingAdd ? '<div class="u-empty"><b>Nothing matches</b><span>Nothing in this view yet.</span></div>' : ''}
        </div>
      </div>
      <div class="u-foot">
        <span class="summary">${esc(summary)}</span>
        ${checked.size ? `<button class="btn btn-ghost btn-sm press" data-act="history-deselect">Deselect</button>
          <button class="btn btn-secondary btn-sm press" data-act="history-requeue">Requeue ${checked.size}</button>
          <button class="btn btn-danger btn-sm press" data-act="history-delete">Delete ${checked.size}</button>` : ''}
        <button class="${OneToolActionState.actionButtonClass(actionStatus)}" data-act="convert" ${ready && !busy && actionStatus === 'idle' ? '' : 'disabled'}>
          <span data-on="${actionStatus === 'idle' && !busy}">${esc(goLabel)}<span class="kbd" style="background:rgba(255,255,255,.16);color:rgba(255,255,255,.72)">⏎</span></span>
          <span data-on="${Boolean(actionStatus === 'pending' || busy)}"><span class="spin"></span>Converting…</span>
          <span data-on="${actionStatus === 'success'}">${tickIcon(13, 'draw')}All done</span>
        </button>
      </div>
    </div>`;
  wireDrop($('dropZone'));
}

function unifiedRow(row, index, lastActive) {
  const meta = (U_STATE[row.state] || U_STATE.idle)(row);
  const file = row.file, open = Boolean(file && file.id === pickerFor);
  const on = checked.has(row.id);
  const selected = row.kind === 'queue'
    ? (selectedQueueIds.has(row.id) || row.id === selectedId)
    : row.id === selectedHistory;
  const dim = row.kind === 'queue' && selectedQueueIds.size > 0 && !selectedQueueIds.has(row.id) && !open;
  const isNew = freshRows.has(row.id);
  const delay = isNew ? ` style="animation-delay:${Math.min(index, 7) * 50}ms"` : '';
  const bar = meta.bar
    ? `<span class="u-track"><span class="u-fill" data-tone="${row.state === 'stopped' ? 'warn' : 'run'}" style="width:${file ? pct(file) : 0}%"></span></span>`
    : '';
  const tick = freshDone.has(row.id) ? `<span class="u-done">${tickIcon(8, 'draw')}</span>` : '';
  const thumb = file
    ? fileThumb(file, 'u-tile')
    : fileThumb({sourceExt: `.${String(row.to || '').toLowerCase()}`, kind: 'doc'}, 'u-tile');
  const route = file
    ? `<button class="u-pill press" data-act="toggle-picker" data-id="${esc(file.id)}" data-open="${open}" data-blocked="${row.state === 'blocked'}" aria-expanded="${open}">${esc(row.from)} → ${esc(row.to || 'Choose')}<span class="chev" aria-hidden="true">${open ? '▴' : '▾'}</span></button>${routePopover(file, open)}`
    : `<span class="u-pill">${esc(row.from || '')} → ${esc(row.to || '')}</span>`;
  /* Queued work and written output answer to different handlers and different
     context menus, so each row declares which it is. */
  const hooks = row.kind === 'queue'
    ? 'data-act="select-row" data-context="queue-file"'
    : 'data-act="select-history" data-context="history-file"';
  return `<div class="u-row row ${isNew ? 'is-new' : ''}" ${hooks} data-id="${esc(row.id)}" data-multi-selected="${on}"
    data-selected="${selected}" data-live="${row.state === 'running'}" data-dim="${dim}" data-open="${open}"
    data-missing="${row.state === 'missing'}" data-rule="${index === lastActive + 1 && lastActive >= 0}" role="button" tabindex="0"${delay}>
    <button class="check press ${on ? 'on' : ''}" data-act="check-history" data-id="${esc(row.id)}" role="checkbox" aria-checked="${on}">${on ? tickIcon(10) : ''}</button>
    ${thumb}
    <span class="u-name" title="${esc(row.name)}">${esc(row.name)}</span>
    <span class="u-conv">${route}</span>
    <span class="u-status">${bar}${tick}<span class="u-state ${meta.shimmer ? 'shimmer' : ''}" data-tone="${meta.tone}">${esc(meta.label)}</span></span>
    <span class="u-size">${esc(row.size || '—')}</span>
    <span class="u-when">${esc(row.when || '')}</span>
  </div>`;
}

