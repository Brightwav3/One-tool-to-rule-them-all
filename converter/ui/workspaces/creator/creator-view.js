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

