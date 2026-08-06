/* Creator bridge — the Creator screen talking to the real backend.

   Deliberately self-contained. It replaces a few functions from index.html at
   load time and touches nothing else, so this whole feature is one <script> tag:

       remove the tag in index.html              → the mock behaviour returns
       localStorage['onetool.creator'] = 'mock'  → same, without editing a file
       localStorage['onetool.creator'] = 'live'  → back on

   What it wires:
     · the container list, its helper badges and its options come from the
       registry, so the picker can only offer what this machine can write
     · items are probed on disk, so page counts and sizes are read, not guessed
     · Create posts to /api/create and follows the real job
     · recipes are saved to the settings file the app already keeps

   Nothing imports this file. Deleting it and its tag is a complete revert. */
(function creatorBridge() {
  'use strict';

  /* Which options each container shows, and in what order, is the registry's
     answer. These are the only keys the Creator knows how to render. */
  const RENDERABLE = new Set(['compress', 'flatten', 'rename', 'meta', 'password', 'title', 'creator', 'dpi', 'quality']);

  /* A container's group comes from its category, so a new converter lands in
     the right place without this file being edited. */
  const GROUP_ORDER = ['Comics', 'Documents', 'Archives', 'Images', 'Ebooks'];

  const live = () => (window.localStorage?.getItem('onetool.creator') || 'live') !== 'mock';

  /* Electron hands over a real path; a plain browser does not. The Creator
     builds from files on disk, so an item without a path cannot be built from,
     and the bridge stands aside rather than uploading behind the user's back. */
  const pathFor = file => window.appWindow?.getPathForFile?.(file) || file.path || '';

  const original = {};

  /* index.html declares these later in the document, so the swap waits until
     the page has finished parsing rather than being overwritten by them. */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach, {once: true});
  else attach();

  function attach() {
    original.takeFiles = window.creatorTakeFiles;
    original.create = window.creatorCreate;
    original.setTools = window.setTools;
    original.absorb = window.absorb;
    if (!original.takeFiles || !original.create || !original.setTools) return;  // screen not on this build

    window.creatorTakeFiles = creatorTakeFilesWithPaths;
    window.creatorCreate = creatorCreateLive;
    window.setTools = setToolsAndContainers;
    window.absorb = absorbWithRecipes;

    if (live() && typeof creator === 'object') {
      const saveRecipe = creator.saveRecipe;
      creator.saveRecipe = () => { const id = saveRecipe(); persistRecipes(); return id; };
      // The tool list may already have arrived while the page was parsing.
      try { if (containers.length) creator.setContainers(groupsFrom(containers)); } catch { /* older build */ }
    }
  }

  /* -- the container list ------------------------------------------------- */

  function setToolsAndContainers(list) {
    original.setTools(list);
    if (!live()) return;
    try { creator.setContainers(groupsFrom(containers)); } catch { /* screen absent */ }
  }

  function groupsFrom(list) {
    const byGroup = new Map();
    (list || []).forEach(tool => {
      const item = {
        id: tool.to,
        converter: tool.id,
        title: tool.to === 'TGZ' ? 'tar.gz' : tool.to,
        desc: tool.blurb || tool.sub || '',
        ext: tool.ext,
        unit: tool.kind === 'comic' || tool.kind === 'image' ? 'Pages' : 'Files',
        opts: (tool.options || []).map(o => o.key).filter(key => RENDERABLE.has(key)),
        /* A missing helper is named, so the screen blocks with a reason the
           Settings pane can act on rather than a flat refusal. */
        needs: tool.state === 'helper' ? (tool.helper?.name || (tool.requirements || [])[0]?.name || '') : '',
        dis: tool.state === 'soon',
      };
      const group = tool.cat || 'Other';
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group).push(item);
    });
    return [...byGroup.entries()]
      .sort((a, b) => {
        const rank = name => (GROUP_ORDER.indexOf(name) + 1 || 99);
        return rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]);
      })
      .map(([name, items]) => ({name, items}));
  }

  /* -- recipes ------------------------------------------------------------- */

  function absorbWithRecipes(data) {
    original.absorb(data);
    if (!live() || !Array.isArray(data?.recipes) || typeof creator !== 'object') return;
    // The shipped examples stay; the user's own are added from disk beside them.
    const shipped = creator.state.recipes.filter(recipe => !recipe.saved);
    const saved = data.recipes.map(recipe => ({...recipe, saved: true}));
    creator.state.recipes = [...shipped, ...saved.filter(one => !shipped.some(other => other.id === one.id))];
  }

  /* Only the user's own recipes are written, so a future version can change the
     shipped examples without fighting a copy saved into someone's settings. */
  function persistRecipes() {
    fetch('/api/recipes', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({recipes: creator.state.recipes.filter(recipe => recipe.saved)}),
    }).catch(error => showToast(error.message, false));
  }

  /* -- items --------------------------------------------------------------- */

  function creatorTakeFilesWithPaths(fileList) {
    const picked = [...fileList];
    original.takeFiles(fileList);
    if (!live() || !picked.length) return;
    // The state module appends in order, so the last N items are these files.
    const items = creator.state.items;
    const added = items.slice(items.length - picked.length);
    added.forEach((item, k) => { item.path = pathFor(picked[k]); });
    probe(added.filter(item => item.path));
  }

  /* Page counts were blank because nothing had opened the files. Now something
     has: the row shows what the file says, and stays blank when it says nothing. */
  async function probe(items) {
    if (!items.length) return;
    try {
      const response = await fetch('/api/probe', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({paths: items.map(item => item.path)}),
      });
      const data = await response.json();
      (data.items || []).forEach((probed, k) => {
        const item = items[k];
        if (!item || probed.error) return;
        item.pages = probed.pages || 0;
        item.size = probed.size / (1024 * 1024);
        item.kind = probed.kind || item.kind;
        item.ext = probed.ext || item.ext;
      });
      render(true);
    } catch { /* a failed probe leaves the row exactly as it was */ }
  }

  /* -- building ------------------------------------------------------------ */

  function creatorCreateLive() {
    if (!live()) return original.create();

    const s = creator.state;
    if (!creator.canCreate(installedHelpers())) return;

    const container = creator.format().converter;
    if (!container) {
      showToast(`${creator.format().title} has no route on this machine yet`, false);
      return;
    }
    const missing = s.items.filter(item => !item.path);
    if (missing.length) {
      showToast(
        'Creator needs files on disk',
        false,
        `${missing.length} item${missing.length === 1 ? '' : 's'} came from the browser without a path. Add them in the desktop app.`,
      );
      return;
    }

    s.job = 'running';
    s.pct = 0;
    render(true);
    build(container).catch(error => {
      s.job = null;
      s.pct = 0;
      showToast(error.message, false);
      render(true);
    });
  }

  /* Only the keys this container declared, in the spelling its builder reads. */
  function backendOptions() {
    const options = {};
    creator.format().opts.forEach(key => {
      const value = creator.value(key);
      if (value === '' || value == null) return;
      options[key] = typeof value === 'boolean' ? String(value) : String(value);
    });
    return options;
  }

  async function build(container) {
    const s = creator.state;
    const body = {
      format: container,
      items: creator.sortedItems().map(item => item.path),
      name: s.name || 'Untitled',
      options: backendOptions(),
    };
    // A destination is sent only when it is a real folder the app knows about.
    // The placeholder path would be rejected, so the queue's own output folder
    // is used instead and the screen is corrected afterwards.
    if (s.dest && !s.dest.startsWith('~')) body.dest = s.dest;

    const created = await api('/api/create', body);
    await follow(String(created.id));
  }

  /* The job is a real queue job, so its progress is the queue's progress. */
  async function follow(jobId) {
    const s = creator.state;
    for (;;) {
      const data = await fetch('/api/state').then(response => response.json());
      absorb(data);
      const job = (data.files || []).find(file => String(file.id) === jobId);
      if (!job) throw new Error('the job left the queue before it finished');

      s.pct = job.units ? Math.min(99, Math.round((job.doneUnits / job.units) * 100)) : s.pct;
      if (job.status === 'error') {
        s.job = null;
        s.pct = 0;
        showToast(job.errorTitle || 'Create failed', false, job.error || '');
        render(true);
        return;
      }
      if (job.status === 'done') {
        s.pct = 100;
        s.job = 'done';
        // Say where it really went, not where the screen guessed it would.
        const folder = job.out.slice(0, Math.max(job.out.lastIndexOf('/'), job.out.lastIndexOf('\\')));
        if (folder) s.dest = folder;
        showToast(`${job.out.split(/[\\/]/).pop()} written`, true, folder);
        render(true);
        return;
      }
      render(true);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}());
