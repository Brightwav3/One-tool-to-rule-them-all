/* ---------- settings ----------
   One window for every app-wide preference. Helpers used to be its own page; it is
   a category in here now, so the installer list and the preferences that govern it
   sit in the same place. Categories are data, and search spans all of them. */
const SET_TABS = [
  {id:'general', name:'General', glyph:'⚙'},
  {id:'conversions', name:'Conversions', glyph:'⇄'},
  {id:'editing', name:'Editing', glyph:'✎'},
  {id:'files', name:'Files and locations', glyph:'🗀'},
  {id:'helpers', name:'Helpers', glyph:'⚗'},
  {id:'shortcuts', name:'Shortcuts', glyph:'⌘'},
  {id:'advanced', name:'Advanced', glyph:'⌥'},
];
const SET_DATA = {
  general: [
    {title:'On launch', rows:[
      {id:'openWith', lab:'Open with', sub:'What One Tool shows when you start it.', kind:'select', opts:['Last document','File browser','Empty window']},
      {id:'restore', lab:'Restore open documents', sub:'Reopen everything that was open when you quit.', kind:'switch', on:true},
    ]},
    {title:'Appearance', rows:[
      {id:'theme', lab:'Theme', sub:'Follows the system unless you pick one.', kind:'select', opts:['System','Light','Dark']},
      {id:'density', lab:'Thumbnail size', sub:'Pages per row in the grid.', kind:'select', opts:['Medium','Small','Large']},
      {id:'anim', lab:'Animate view changes', sub:'Zoom between the grid and the reader.', kind:'switch', on:true},
    ]},
  ],
  conversions: [
    {title:'Queue', rows:[
      {id:'autoStart', lab:'Start converting on drop', sub:'Files begin as soon as they land in the queue.', kind:'switch', on:false},
      {id:'parallel', lab:'Files at once', sub:'Higher is faster but uses more CPU.', kind:'select', opts:['2','1','4','8']},
      {id:'onFail', lab:'When a file fails', sub:'Applies to the rest of the queue.', kind:'select', opts:['Skip and continue','Stop the queue','Retry once']},
    ]},
    {title:'Output', rows:[
      {id:'overwrite', lab:'If the output exists', sub:'Checked before anything is written.', kind:'select', opts:['Add a number','Overwrite','Skip the file']},
      {id:'notify', lab:'Notify when a batch finishes', sub:'A system notification, even when One Tool is in the background.', kind:'switch', on:true},
    ]},
  ],
  editing: [
    {title:'Pages', rows:[
      {id:'confirmDel', lab:'Confirm before deleting pages', sub:'Ask once when more than one page is selected.', kind:'switch', on:true},
      {id:'rotStep', lab:'Rotation step', sub:'Applied by R and the toolbar buttons.', kind:'select', opts:['90°','180°','15°']},
      {id:'insertAt', lab:'Insert blank pages', sub:'Where a new page lands.', kind:'select', opts:['After selection','At the end','Before selection']},
    ]},
    {title:'Redaction', rows:[
      {id:'redactWarn', lab:'Warn before applying', sub:'Applying removes the content underneath permanently.', kind:'switch', on:true},
      {id:'redactScope', lab:'Default scope', sub:'Which pages a new block covers.', kind:'select', opts:['This page','All pages']},
    ]},
  ],
  files: [
    {title:'Saving', rows:[
      {id:'saveTo', lab:'Save new files to', sub:'Used by Extract and Save as new file.', kind:'select', opts:['~/Converted','Beside the original','Ask each time']},
      {id:'keepOrig', lab:'Keep the original', sub:'Never overwrite the file you opened.', kind:'switch', on:true},
      {id:'suffix', lab:'Name new files', sub:'Appended to the original name.', kind:'select', opts:['— edited','(1)','Date stamp']},
    ]},
    {title:'Recent', rows:[
      {id:'recentN', lab:'Remember recent files', sub:'Shown in the Convert list.', kind:'select', opts:['20','50','None']},
      {id:'clearRecent', lab:'Clear recent files', sub:'Removes the list. Files are untouched.', kind:'action', value:'Clear'},
    ]},
  ],
  shortcuts: [
    {title:'Global', rows:[
      {id:'paletteKey', lab:'Command palette', sub:'Opens from anywhere in the app.', kind:'select', opts:['⌘K','⌃K','F1']},
      {id:'settingsKey', lab:'Open settings', sub:'This window.', kind:'select', opts:['⌘,','⌃,','None']},
      {id:'zoomToggle', lab:'Grid and reader', sub:'Switches between all pages and a single page.', kind:'select', opts:['⌃Space','⌘0','Tab']},
    ]},
  ],
  advanced: [
    {title:'Performance', rows:[
      {id:'cache', lab:'Page cache', sub:'More cache renders faster, uses more memory.', kind:'select', opts:['512 MB','256 MB','2 GB']},
      {id:'gpu', lab:'GPU rendering', sub:'Turn off if pages render incorrectly.', kind:'switch', on:true},
    ]},
    {title:'Diagnostics', rows:[
      {id:'logs', lab:'Verbose logging', sub:'Writes to the app log folder.', kind:'switch', on:false},
      {id:'reset', lab:'Reset all settings', sub:'Returns everything in this window to its default.', kind:'action', value:'Reset'},
    ]},
  ],
};
const SET_ROWS = Object.values(SET_DATA).flatMap(sections => sections.flatMap(s => s.rows));
const setRow = id => SET_ROWS.find(r => r.id === id);

function renderSettings() {
  const missing = missingHelpers().length;
  const q = setQuery.trim().toLowerCase();
  const showHelpers = setTab === 'helpers' && !q;
  const source = q ? Object.values(SET_DATA).flat() : (SET_DATA[setTab] || []);
  const sections = source
    .map(sec => ({title: sec.title, rows: sec.rows.filter(r => !q || `${r.lab} ${r.sub}`.toLowerCase().includes(q))}))
    .filter(sec => sec.rows.length);
  const tabName = (SET_TABS.find(t => t.id === setTab) || SET_TABS[0]).name;
  setScrim.dataset.open = String(settingsOpen);
  if (!settingsOpen) { settingsView = null; return; }
  /* Changing category, or crossing into and out of search, is an arrival. Flipping
     a switch in the category you are already looking at is not. */
  const key = `${settingsOpen}:${showHelpers ? 'helpers' : setTab}:${q ? 'q' : ''}`;
  settingsEntering = settingsView !== key;
  settingsView = key;
  setWin.innerHTML = `
    <div class="set-side">
      <div class="set-search"><div class="set-search-in">
        <span aria-hidden="true">&#8981;</span>
        <input id="setSearch" data-live="true" data-act="settings-search" value="${esc(setQuery)}" placeholder="Search settings…" aria-label="Search settings">
      </div></div>
      <div class="set-tabs">
        <span class="col">One Tool</span>
        ${SET_TABS.map(t => `<button class="set-tab press" data-act="settings-tab" data-tab="${t.id}" data-on="${t.id === setTab}">
          <span class="g" aria-hidden="true">${t.glyph}</span><span class="n">${esc(t.name)}</span>
          ${t.id === 'helpers' && missing ? `<span class="pill">${missing}</span>` : ''}
        </button>`).join('')}
      </div>
      <div class="set-ver">One Tool ${esc(APP_VERSION)}</div>
    </div>
    <div class="set-main">
      <div class="set-head"><span style="flex:1">${esc(q ? 'Search results' : tabName)}</span><button class="btn btn-sm press set-close" data-act="close-settings" aria-label="Close settings">✕</button></div>
      <div class="set-pane${settingsEntering ? ' s-fade' : ''}">
        ${showHelpers ? settingsHelpersHtml() : (sections.length ? sections.map(settingsSectionHtml).join('') : `<div class="set-empty">Nothing matches “${esc(setQuery)}”.</div>`)}
      </div>
    </div>`;
  /* Both were just painted, so the next render treats them as already there. */
  openMenuSeen = setOpenSel;
  openHelperSeen = setOpenHelper;
}
function settingsSectionHtml(sec) {
  return `<div>
    <div class="set-sec-t">${esc(sec.title)}</div>
    ${sec.rows.map(settingsRowHtml).join('')}
  </div>`;
}
function settingsRowHtml(row) {
  const value = settingValue(row);
  let control = '';
  if (row.kind === 'switch') {
    control = `<button class="sw" role="switch" aria-checked="${value}" aria-label="${esc(row.lab)}" data-act="settings-toggle" data-id="${row.id}" data-on="${value}"><i></i></button>`;
  } else if (row.kind === 'select') {
    const open = setOpenSel === row.id;
    control = `<span class="set-selwrap">
      <button class="sel press" data-act="settings-menu" data-id="${row.id}" aria-haspopup="menu" aria-expanded="${open}">${esc(value)}<span class="car" aria-hidden="true">▼</span></button>
      ${open ? `<span class="set-menu${openMenuSeen === row.id ? '' : ' s-fade'}" role="menu">${row.opts.map(o => `<button role="menuitem" data-act="settings-pick" data-id="${row.id}" data-value="${esc(o)}" data-on="${o === value}"><span class="tk" aria-hidden="true">${o === value ? '✓' : ''}</span><span class="nm">${esc(o)}</span></button>`).join('')}</span>` : ''}
    </span>`;
  } else {
    control = `<button class="btn btn-secondary btn-sm press" data-act="settings-action" data-id="${row.id}">${esc(value)}</button>`;
  }
  return `<div class="set-row">
    <div style="flex:1;min-width:0"><div class="lab">${esc(row.lab)}</div><div class="sub">${esc(row.sub)}</div></div>
    ${control}
  </div>`;
}
function settingsHelpersHtml() {
  const names = helperNames();
  if (!names.length) return `<div class="set-empty">No external helpers are registered.</div>`;
  const missing = names.filter(name => !helperFound(name)).length;
  const headline = missing ? `${names.length - missing} of ${names.length} installed · ${missing} missing` : `All ${names.length} installed`;
  return `<div class="set-hhead">
      <div class="set-hhead-row"><b>${headline}</b><button class="btn btn-secondary btn-sm press" data-act="recheck">Re-scan this machine</button></div>
      <p class="set-hblurb">Free, standard tools. Install one and every conversion that needs it turns on at once. They stay on your machine and are only launched when a conversion needs them.</p>
    </div>
    <div class="set-hlist">${names.map(settingsHelperHtml).join('')}</div>`;
}
function settingsHelperHtml(name) {
  const data = helperData(name), ready = helperFound(name);
  const busy = installingHelper === name;
  const open = setOpenHelper === name;
  const unlocks = helperTools(name).map(t => `${t.from} → ${t.to}`);
  const state = busy ? 'busy' : ready ? 'ok' : 'miss';
  const label = busy ? 'Downloading…' : ready ? 'Installed' : 'Missing';
  const canDownload = !ready && !busy && data.download && shell?.downloadDependency;
  return `<div class="set-h" data-installed="${ready}">
    <div class="set-h-top press" role="button" tabindex="0" data-act="settings-helper" data-context="helper" data-helper="${esc(name)}" aria-expanded="${open}">
      <span class="set-h-chev" aria-hidden="true">${open ? '⌄' : '›'}</span>
      <span class="set-h-dot" data-state="${state}" aria-hidden="true"></span>
      <span class="set-h-name"><b>${esc(name)}</b><span>${unlocks.length} conversion${unlocks.length === 1 ? '' : 's'}</span></span>
      <span class="set-chip" data-state="${state}">${label}</span>
      ${canDownload ? `<button class="btn btn-primary btn-sm press" data-act="download-helper" data-url="${esc(data.download)}" data-name="${esc(name)}">Download helper</button>` : ''}
    </div>
    ${open ? `<div class="set-h-body${openHelperSeen === name ? '' : ' s-fade'}">
      <div class="set-h-grp">
        <span class="col">${ready ? 'Runs with this helper' : 'Turns on when installed'}</span>
        <div class="set-h-chips">${unlocks.length ? unlocks.map(u => `<span>${esc(u)}</span>`).join('') : `<span>${esc(data.why || 'Used by registered converters')}</span>`}</div>
      </div>
      ${data.cmd ? `<div class="set-h-grp">
        <span class="col">Or install it yourself</span>
        <div class="set-cmd"><code>${esc(data.cmd)}</code><button class="btn btn-sm press set-copy" data-act="settings-copy" data-helper="${esc(name)}" data-command="${esc(data.cmd)}">${setCopied === name ? 'Copied' : 'Copy'}</button></div>
      </div>` : ''}
      ${data.url ? `<div><button class="btn btn-secondary btn-sm press" data-act="open-url" data-url="${esc(data.url)}">Official page</button></div>` : ''}
    </div>` : ''}
  </div>`;
}

