/* Creator bridge — the Creator screen talking to the real /api/create route.

   Deliberately self-contained. It replaces two functions from index.html at load
   time and touches nothing else, so this whole feature is one <script> tag:

       remove the tag in index.html          → the mock behaviour returns, exactly
       localStorage['onetool.creator'] = 'mock'  → same, without editing a file
       localStorage['onetool.creator'] = 'live'  → back on

   Nothing here is imported by anything. Deleting this file and its tag is a
   complete revert. */
(function creatorBridge() {
  'use strict';

  /* The Creator's container ids, mapped onto the converters the registry
     actually has. A container missing from this map has no route on this
     machine, and the bridge says so rather than pretending to write it. */
  const CONTAINERS = {
    CBZ: 'items-cbz',
    CB7: 'items-cb7',
    EPUB: 'items-epub',
    PDF: 'items-pdf',
    TIFF: 'items-tiff',
    ZIP: 'items-zip',
    '7Z': 'items-7z',
    TGZ: 'items-tgz',
  };

  /* Only the options the backend converters really accept. The Creator shows
     more than this; the rest are not wired yet and are left out rather than
     sent and silently ignored. */
  const TIFF_COMPRESSION = {Store: 'none', Normal: 'lzw', Max: 'zip'};

  function backendOptions(state, value, container) {
    if (container === 'items-epub') {
      return {title: state.name || 'Untitled', creator: 'Unknown'};
    }
    if (container === 'items-tiff') {
      return {compression: TIFF_COMPRESSION[value('compress')] || 'lzw'};
    }
    return {};
  }

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
    if (!original.takeFiles || !original.create) return;  // screen not on this build
    window.creatorTakeFiles = creatorTakeFilesWithPaths;
    window.creatorCreate = creatorCreateLive;
  }

  function creatorTakeFilesWithPaths(fileList) {
    const picked = [...fileList];
    original.takeFiles(fileList);
    if (!live() || !picked.length) return;
    // The state module appends in order, so the last N items are these files.
    const items = creator.state.items;
    picked.forEach((file, k) => {
      const item = items[items.length - picked.length + k];
      if (item) item.path = pathFor(file);
    });
  }

  function creatorCreateLive() {
    if (!live()) return original.create();

    const s = creator.state;
    if (!creator.canCreate(installedHelpers())) return;

    const container = CONTAINERS[s.fmt];
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

  async function build(container) {
    const s = creator.state;
    const body = {
      format: container,
      items: creator.sortedItems().map(item => item.path),
      name: s.name || 'Untitled',
      options: backendOptions(s, creator.value, container),
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
