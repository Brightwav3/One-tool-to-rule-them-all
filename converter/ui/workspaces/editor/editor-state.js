/* Editor state — the page model behind the grid, reader and pair views.
   Pure data: no DOM, no timers, so the renderer and the tests can both drive it.
   Ported from the One Tool Editor prototype's logic class. */
(function initEditorState(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OneToolEditorState = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const LINE_WIDTHS = ['100%', '96%', '92%', '88%', '84%', '74%', '66%', '58%', '48%'];
  /* A fixed pseudo-random so a document redraws the same way every render; real page
     renderings replace this the moment the backend can supply them. */
  const noise = seed => { const x = Math.sin(seed) * 10000; return x - Math.floor(x); };
  const KINDS = ['Cover', 'Scan', 'Scan', 'Scan', 'Spread', 'Blank', 'Scan', 'Scan'];

  const TOOLS = [
    {id: 'select', icon: 'i-select', label: 'Select', help: 'Click a page element to select it. Drag to move.'},
    {id: 'text', icon: 'i-text', label: 'Text', help: 'Click to place a text box. The page keeps its own fonts.'},
    {id: 'redact', icon: 'i-redact', label: 'Redact', help: 'Click the page to drop a block. Applying removes what is underneath, not just covers it.'},
    {id: 'draw', icon: 'i-draw', label: 'Draw', help: 'Freehand ink on top of the page.'},
    {id: 'stamp', icon: 'i-stamp', label: 'Stamp', help: 'Place a saved stamp or signature.'},
    {id: 'crop', icon: 'i-crop', label: 'Crop', help: 'Drag the edges. Crop can apply to this page or every page.'},
  ];

  /* Which FreeDF operation each tool needs. A tool absent from this map has no
     engine operation at all — that is what "unimplemented" means, and it is a
     property of this build, not of the document. `select` is a pointer mode: it
     asks nothing of the engine, so it is mapped to null rather than left out. */
  const TOOL_OPERATIONS = {
    select: null,
    crop: 'crop_pages',
    ocr: 'add_text_layer',
    rotate: 'rotate_pages',
    delete: 'delete_pages',
    reorder: 'reorder_pages',
    insert: 'insert_blank_page',
    import: 'import_pages',
  };

  /* A page can be shown before the server replies only when its identity and
     membership cannot change.  In particular, blank-page ids come from FreeDF,
     so inserting one locally would create a document the server can never
     reconcile. */
  const OPTIMISTIC = {
    rotate: true, reorder: true, delete: false, insert: false, crop: false,
    ocr: false, undo: false, redo: false, save: false,
  };

  /* The engine's four states imply four different offers, so none of them may
     be folded into another. `unavailable` means this installation cannot supply
     the tool — something can be installed. `blocked` means this document
     refuses it — installing nothing would help, so no install button. `error`
     means the backend is there and broken — a recheck is the move. */
  const ENGINE_STATE_ACTIONS = {
    ready: null, unavailable: 'install', blocked: null, error: 'recheck',
  };

  const UNIMPLEMENTED_DETAIL =
    'This tool has no FreeDF operation yet. It is on the roadmap, not in this build.';

  function makePages(count = 24, offset = 0) {
    return Array.from({length: count}, (_, i) => {
      const seed = i + offset + 1;
      const lineCount = 4 + Math.floor(noise(seed) * 3);
      const lines = Array.from({length: lineCount}, (_, k) => ({
        w: LINE_WIDTHS[Math.floor(noise(seed * (k + 2)) * LINE_WIDTHS.length)],
        head: k === 0 && i % 6 === 0,
      }));
      const kind = i === 0 && !offset ? 'Cover' : KINDS[i % KINDS.length];
      return {
        id: String(seed + offset * 1000), kind,
        rot: i === 6 ? -90 : 0,
        text: i < 2 ? 'Selectable' : 'Image only',
        size: `${(2 + noise(seed + 2) * 7).toFixed(1)} MB`,
        lines: kind === 'Blank' ? [] : lines,
        marks: [],
      };
    });
  }

  /* FreeDF accepts 90, 180 and 270 only (RotatePages.__post_init__). The
     prototype produced -90 and, via (rot + deg) % 360, other negatives; every
     one of those is rejected upstream. */
  function normalizeRotation(deg) {
    return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  }

  function describeOp(op = {}) {
    const count = Array.isArray(op.pageIds) ? op.pageIds.length : 0;
    const pages = `${count} page${count === 1 ? '' : 's'}`;
    switch (op.kind) {
      case 'rotate_pages': return `Rotated ${pages} by ${op.degrees}°`;
      case 'delete_pages': return `Deleted ${pages}`;
      case 'reorder_pages': return `Reordered ${pages}`;
      case 'insert_blank_page': return 'Inserted a blank page';
      case 'crop_pages': return `Cropped ${pages}`;
      case 'add_text_layer': return `Added a text layer to ${pages}`;
      default: return 'Applied an edit';
    }
  }

  /* DOM rectangles use a top-left origin; PDF user space uses bottom-left. */
  function cropBoxToPoints(rect, page) {
    if (!rect || !page || !Number.isFinite(page.w) || !Number.isFinite(page.h)) return null;
    const left = Math.max(0, Math.min(100, rect.x));
    const top = Math.max(0, Math.min(100, rect.y));
    const right = Math.max(0, Math.min(100, rect.x + rect.w));
    const bottom = Math.max(0, Math.min(100, rect.y + rect.h));
    const x0 = (Math.min(left, right) / 100) * page.w;
    const x1 = (Math.max(left, right) / 100) * page.w;
    const y1 = page.h - (Math.min(top, bottom) / 100) * page.h;
    const y0 = page.h - (Math.max(top, bottom) / 100) * page.h;
    if (x1 <= x0 || y1 <= y0) return null;
    return [x0, y0, x1, y1].map(value => Math.round(value * 100) / 100);
  }

  function screenPointToPagePercent(point, rotation) {
    const x = Math.max(0, Math.min(100, point.x));
    const y = Math.max(0, Math.min(100, point.y));
    switch (normalizeRotation(rotation)) {
      case 90: return {x: y, y: 100 - x};
      case 180: return {x: 100 - x, y: 100 - y};
      case 270: return {x: 100 - y, y: x};
      default: return {x, y};
    }
  }

  function createEditorState(options = {}) {
    const state = {
      mode: 'grid',
      name: options.name || 'Untitled.pdf',
      /* No document is open until one is opened. The generated pages above are
         the empty state's furniture, not a stand-in for a real file. */
      pages: options.pages || [],
      sessionId: null, revision: -1, capabilities: {}, engineState: null,
      canUndo: false, canRedo: false,
      sel: {}, focus: null,
      tool: 'select', zoom: 96, scope: 'This page',
      edits: [], nextId: 1000, pending: null, cropRect: null, recovery: null, recoveryDetail: '',
      bName: null, bPages: [], bSel: {}, dragging: false,
    };

    /* Page ids are the engine's own strings, so nothing is coerced to a number
       on the way through the selection. */
    const selectedIds = () => Object.keys(state.sel).filter(k => state.sel[k])
      .filter(id => state.pages.some(p => p.id === id));
    const bSelectedIds = () => Object.keys(state.bSel).filter(k => state.bSel[k]);

    /* The server's manifest wins wholesale: pages are replaced, never merged,
       because a merge would keep a page the engine has deleted. Selection is
       filtered to what survived. */
    function absorb(snapshot) {
      /* The server is authoritative even when a local optimistic view differs. */
      state.pending = null;
      state.recovery = null; state.recoveryDetail = '';
      state.sessionId = snapshot.session ? snapshot.session.id : null;
      state.revision = snapshot.revision;
      state.capabilities = snapshot.capabilities || {};
      state.engineState = snapshot.engineState || null;
      state.canUndo = !!snapshot.canUndo;
      state.canRedo = !!snapshot.canRedo;
      const operations = Array.isArray(snapshot.operations) ? snapshot.operations : [];
      state.edits = operations.map((op, index) => ({
        id: `${index}:${op.kind || 'edit'}`, text: describeOp(op),
      })).reverse();
      const doc = snapshot.document || {};
      if (doc.title) state.name = doc.title;
      state.pages = (doc.pages || []).map(p => ({
        id: p.pageId, index: p.index, w: p.width, h: p.height,
        rot: p.rotation, sourceIndex: p.sourceIndex, marks: [], lines: [],
        kind: 'Page', text: 'Unknown', size: '',
      }));
      const live = new Set(state.pages.map(p => p.id));
      state.sel = Object.fromEntries(Object.entries(state.sel).filter(([id]) => live.has(id)));
      if (!live.has(state.focus)) state.focus = state.pages.length ? state.pages[0].id : null;
    }
    /* The engine's per-operation report, read straight through. Nothing here
       consults capabilities.ocr: v0.2 already states add_text_layer's own state
       and detail, and the summary block can disagree with it. The detail string
       is the engine's, always — a generic message would throw away the only
       part of this that tells the user what to do. */
    function toolState(toolId) {
      if (!(toolId in TOOL_OPERATIONS)) {
        return {enabled: false, state: 'unimplemented', detail: UNIMPLEMENTED_DETAIL, action: null};
      }
      const kind = TOOL_OPERATIONS[toolId];
      if (!kind) return {enabled: true, state: 'ready', detail: '', action: null};
      const operations = (state.capabilities || {}).operations;
      if (!Array.isArray(operations)) {
        return {enabled: false, state: 'unknown', detail: 'No document is open.', action: null};
      }
      const op = operations.find(o => o && o.kind === kind);
      if (!op) {
        return {enabled: false, state: 'unavailable',
                detail: `This engine build does not provide ${kind}.`, action: 'install'};
      }
      const engineState = op.state in ENGINE_STATE_ACTIONS ? op.state : 'error';
      return {
        enabled: engineState === 'ready',
        state: engineState,
        detail: op.detail || '',
        action: ENGINE_STATE_ACTIONS[engineState],
      };
    }

    /* In the reader the page you are looking at is the target; in the grid it is
       whatever is selected. One rule, so every action reads the same way. */
    const targets = () => state.mode === 'reader' ? (state.focus ? [state.focus] : []) : selectedIds();
    const current = () => state.pages.find(p => p.id === state.focus) || state.pages[0] || null;
    const currentIndex = () => state.pages.findIndex(p => p.id === (current() || {}).id);
    const totalMarks = () => state.pages.reduce((n, p) => n + p.marks.length, 0);

    const pageSnapshot = () => ({
      pages: state.pages.map(p => ({...p, marks: [...(p.marks || [])], lines: [...(p.lines || [])]})),
      sel: {...state.sel}, focus: state.focus, mode: state.mode, edits: [...state.edits],
    });

    /* The pure state model is also used by the design-time page fixture, which
       has pages but no session. The action layer still refuses to post without
       a session; this gate's sole responsibility is serializing mutations. */
    function canMutate() { return !state.pending && !['frozen', 'closed', 'degraded', 'blocked'].includes(state.recovery); }

    function beginPending({kind, snapshot = null} = {}) {
      if (!kind || !canMutate()) return false;
      /* The token binds the one HTTP request permitted to this local mutation.
         Matching by kind would allow a second rotate to slip through. */
      state.pending = {kind, snapshot, token: {}};
      return state.pending.token;
    }

    function rejectPending(reason) {
      const pending = state.pending;
      if (!pending) return null;
      if (pending.snapshot) {
        state.pages = pending.snapshot.pages;
        state.sel = pending.snapshot.sel;
        state.focus = pending.snapshot.focus;
        state.mode = pending.snapshot.mode;
        state.edits = pending.snapshot.edits;
      }
      state.pending = null;
      return reason || 'The operation was rejected.';
    }

    function recover(error = {}) {
      state.pending = null;
      state.recoveryDetail = error.message || error.detail || '';
      if (error.code === 'source-changed') state.recovery = 'frozen';
      else if (error.code === 'session-closed') state.recovery = 'closed';
      else if (error.code === 'engine-error') state.recovery = 'degraded';
      else if (['engine-missing', 'engine-unsupported', 'source-unreadable'].includes(error.code)) state.recovery = 'blocked';
      else if (error.code === 'session-unknown') {
        state.recovery = 'empty'; state.sessionId = null; state.pages = []; state.sel = {}; state.focus = null;
      }
      return state.recovery;
    }

    /* Newest first, capped at six — the pane shows what just happened, not a ledger. */

    function select(id, {additive = false} = {}) {
      const only = selectedIds();
      if (additive) state.sel = {...state.sel, [id]: !state.sel[id]};
      else state.sel = state.sel[id] && only.length === 1 ? {} : {[id]: true};
      state.focus = id;
    }
    function selectAll() { state.sel = state.pages.reduce((m, p) => { m[p.id] = true; return m; }, {}); }
    function deselect() { state.sel = {}; }

    function openReader(id) {
      const next = id || targets()[0] || (state.pages[0] || {}).id;
      if (next === undefined) return;
      state.mode = 'reader'; state.focus = next; state.sel = {[next]: true};
    }
    function toGrid() { state.mode = 'grid'; state.sel = state.focus ? {[state.focus]: true} : {}; }
    function toggleMode() { return state.mode === 'grid' ? openReader() : toGrid(); }

    function step(delta) {
      const i = state.pages.findIndex(p => p.id === state.focus);
      const next = Math.min(state.pages.length - 1, Math.max(0, i + delta));
      const page = state.pages[next];
      if (!page) return;
      state.focus = page.id; state.sel = {[page.id]: true};
    }

    function rotate(deg) {
      const ids = targets().length ? targets() : (current() ? [current().id] : []);
      if (!ids.length || !beginPending({kind: 'rotate_pages', snapshot: pageSnapshot()})) return false;
      state.pages = state.pages.map(p => ids.includes(p.id) ? {...p, rot: normalizeRotation(p.rot + deg)} : p);
      return true;
    }

    function reorder(pageIds) {
      const byId = new Map(state.pages.map(p => [p.id, p]));
      if (!Array.isArray(pageIds) || pageIds.length !== state.pages.length
          || pageIds.some(id => !byId.has(id))
          || !beginPending({kind: 'reorder_pages', snapshot: pageSnapshot()})) return false;
      state.pages = pageIds.map((id, index) => ({...byId.get(id), index}));
      return true;
    }

    /* Deleting lands on the next surviving page so the reader never falls off the
       end; emptying the document drops back to the grid rather than an empty reader. */
    function remove() {
      const ids = targets();
      /* The server owns deletion: it decides the surviving focus and supplies
         the only safe manifest after a structural change. */
      return Boolean(ids.length) && canMutate();
    }

    function insert() {
      /* FreeDF assigns the new page id, therefore this must wait for its snapshot. */
      return canMutate();
    }

    function addMark(xPercent, yPercent) {
      if (state.tool !== 'redact' || !state.focus) return null;
      const x = Math.max(0, Math.min(88, xPercent - 6));
      const y = Math.max(0, Math.min(94, yPercent - 1.5));
      const mark = {id: state.nextId, x, y, w: 34, h: 2.6};
      state.nextId += 1;
      state.pages = state.pages.map(p => p.id === state.focus ? {...p, marks: [...p.marks, mark]} : p);
      return mark;
    }
    function removeMark(markId) {
      state.pages = state.pages.map(p => p.id === state.focus ? {...p, marks: p.marks.filter(m => m.id !== markId)} : p);
    }
    function applyRedactions() {
      const n = totalMarks();
      if (!n) return 0;
      state.pages = state.pages.map(p => ({...p, marks: []}));
      return n;
    }

    function setZoom(delta) { state.zoom = Math.min(200, Math.max(40, state.zoom + delta)); }
    function setCropRect(rect) { state.cropRect = rect; }
    function clearCropRect() { state.cropRect = null; }

    /* Pair mode. The second document is a peer, not a destination: pages move both
       ways and either side can be saved. */
    function openPair(name, pages) {
      state.mode = 'pair'; state.bName = name;
      state.bPages = pages || makePages(4, 900);
      state.bSel = {}; state.sel = {}; state.dragging = false;
    }
    function closePair() { state.mode = 'grid'; state.bName = null; state.bPages = []; state.bSel = {}; }
    function selectB(id, {additive = false} = {}) {
      const only = bSelectedIds();
      if (additive) state.bSel = {...state.bSel, [id]: !state.bSel[id]};
      else state.bSel = state.bSel[id] && only.length === 1 ? {} : {[id]: true};
    }
    function moveRight({copy = false} = {}) {
      const ids = selectedIds();
      if (!ids.length) return false;
      const moving = state.pages.filter(p => ids.includes(p.id));
      state.bPages = [...state.bPages, ...(copy
        ? moving.map((p, k) => ({...p, id: String(state.nextId + k)}))
        : moving)];
      if (copy) state.nextId += moving.length;
      else state.pages = state.pages.filter(p => !ids.includes(p.id));
      state.sel = {};
      return true;
    }
    function moveLeft() {
      const ids = bSelectedIds();
      if (!ids.length) return false;
      const moving = state.bPages.filter(p => ids.includes(p.id)).map((p, k) => ({...p, id: String(state.nextId + k)}));
      state.nextId += moving.length;
      state.pages = [...state.pages, ...moving];
      state.bPages = state.bPages.filter(p => !ids.includes(p.id));
      state.bSel = {};
      return true;
    }
    function swapSides() {
      const {pages, bPages} = state;
      state.pages = bPages; state.bPages = pages; state.sel = {}; state.bSel = {};
    }

    function saved() {}

    return {
      state, TOOLS, absorb, normalizeRotation, toolState, canMutate, beginPending, rejectPending, recover,
      selectedIds, bSelectedIds, targets, current, currentIndex, totalMarks,
      select, selectAll, deselect, selectB,
      openReader, toGrid, toggleMode, step,
      rotate, reorder, remove, insert,
      addMark, removeMark, applyRedactions, setZoom, setCropRect, clearCropRect,
      openPair, closePair, moveRight, moveLeft, swapSides,
      saved,
    };
  }

  return {createEditorState, makePages, normalizeRotation, describeOp, cropBoxToPoints, screenPointToPagePercent, TOOLS, TOOL_OPERATIONS, OPTIMISTIC, LINE_WIDTHS, KINDS, noise};
}));
