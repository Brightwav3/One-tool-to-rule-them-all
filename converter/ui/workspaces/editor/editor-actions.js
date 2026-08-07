/* Editor actions — the Editor screen talking to the FreeDF session routes.
 *
 * A classic script, like every other file the shell loads: it defines one
 * global and reads the globals declared before it (`editor`, `render`,
 * `showToast`). Load order is the dependency graph, so this tag sits after
 * editor-state.js and before action-router.js, which calls into it.
 *
 * Every route answers with the same snapshot, and every snapshot ends in
 * `editor.absorb` then a render. There is no second path by which the page
 * model changes, which is what keeps the grid and the engine from drifting.
 */
(function initEditorActions(root) {
  'use strict';

  async function post(route, body) {
    const res = await fetch(route, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  /* The one place a snapshot enters the renderer. */
  function absorbEditor(snapshot) {
    editor.absorb(snapshot);
    render(true);
    return snapshot;
  }

  const sessionId = () => editor.state.sessionId;

  async function openDocument(paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return null;
    /* One session at a time. Closing first keeps the engine from holding a file
       the user has already moved on from. */
    if (sessionId()) await close().catch(() => {});
    const snapshot = await post('/api/editor/open', {paths: list});
    editor.state.mode = 'grid';
    return absorbEditor(snapshot);
  }

  async function close() {
    const id = sessionId();
    if (!id) return null;
    editor.state.sessionId = null;
    return post('/api/editor/close', {sessionId: id});
  }

  /* `optimistic` is the caller's promise that it has already applied the change
     locally; it only suppresses the intermediate render, never the absorb. */
  async function applyOperations(operations, {optimistic = false, dryRun = false} = {}) {
    const id = sessionId();
    if (!id) return null;
    if (!optimistic) render(true);
    const snapshot = await post('/api/editor/operation', {sessionId: id, operations, dryRun});
    return absorbEditor(snapshot);
  }

  async function inspect() {
    const id = sessionId();
    if (!id) return null;
    return absorbEditor(await post('/api/editor/inspect', {sessionId: id}));
  }

  async function undo() {
    const id = sessionId();
    if (!id) return null;
    return absorbEditor(await post('/api/editor/undo', {sessionId: id}));
  }

  async function redo() {
    const id = sessionId();
    if (!id) return null;
    return absorbEditor(await post('/api/editor/redo', {sessionId: id}));
  }

  async function save(outputPath) {
    const id = sessionId();
    if (!id) return null;
    return post('/api/editor/save', outputPath ? {sessionId: id, outputPath} : {sessionId: id});
  }

  /* FreeDF's render width is a bounding dimension, not an exact width: a
     landscape page asked for at 180 comes back 255x180. The requested width is
     therefore only a request, and tiles are sized from what came back.
     D5: one thumbnail size per pixel ratio, so a retina screen is not served a
     blurred image and a plain one is not made to decode four times the pixels. */
  const thumbWidth = () => ((root.devicePixelRatio || 1) > 1 ? 360 : 180);

  function pageImageUrl(page, width) {
    const w = width || thumbWidth();
    /* rev is required, and must be the current revision or the route answers
       409 revision-stale — which is also what makes these URLs cache-safe
       across a mutation. */
    return `/api/editor/page.png?session=${encodeURIComponent(editor.state.sessionId)}`
      + `&page=${encodeURIComponent(page.id)}&w=${w}&rev=${editor.state.revision}`;
  }

  /* Electron hands over a real path; a plain browser does not, and the engine
     opens files from disk, so a file without a path cannot be opened. */
  const pathFor = file => root.appWindow?.getPathForFile?.(file) || file.path || '';

  function pickDocument() {
    const input = document.getElementById('edFiles');
    if (!input) return;
    input.value = '';
    input.click();
  }

  function takeFiles(fileList) {
    const paths = [...(fileList || [])].map(pathFor).filter(Boolean);
    if (!paths.length) {
      showToast('The Editor opens files from disk, and this file has no path', false);
      return Promise.resolve(null);
    }
    return openDocument(paths).catch(error => { showToast(error.message, false); return null; });
  }

  root.OneToolEditorActions = {
    openDocument, close, applyOperations, inspect, undo, redo, save,
    absorbEditor, pageImageUrl, thumbWidth, pickDocument, takeFiles,
  };
}(typeof self !== 'undefined' ? self : this));
