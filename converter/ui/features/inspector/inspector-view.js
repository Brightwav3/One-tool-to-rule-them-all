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

