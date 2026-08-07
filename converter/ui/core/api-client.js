/* ---------- server ---------- */
async function api(route, body, rerender=true) {
  const res = await fetch(route, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body || {})});
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
  if (rerender) absorb(data);
  return data;
}
function absorb(data) {
  if (Array.isArray(data.files)) files = data.files;
  if (typeof data.outputFolder === 'string' && data.outputFolder) outputFolder = data.outputFolder;
  if (Array.isArray(data.outputFolders)) outputFolders = data.outputFolders;
  if (data.counts) counts = data.counts;
  if (Array.isArray(data.tools)) setTools(data.tools);
  const fileIds = new Set(files.map(file => file.id));
  selectedQueueIds = new Set([...selectedQueueIds].filter(id => fileIds.has(id)));
  if (queueAnchorId && !fileIds.has(queueAnchorId)) queueAnchorId = null;
  if (selectedId && !files.some(f => f.id === selectedId)) selectedId = files[0]?.id || null;
  if (!selectedId && files.length) selectedId = files[0].id;
  noteTransitions();
  const passwordFile = files.find(f => f.status === 'error' && /password|encrypted|data error/i.test(`${f.errorTitle || ''} ${f.error || ''}`) && !archivePromptSeen.has(f.id));
  if (passwordFile) { archivePromptSeen.add(passwordFile.id); archivePromptId = passwordFile.id; archivePromptError = ''; }
  render();
}
function noteTransitions() {
  files.forEach((f, index) => {
    const before = prevStatus.get(f.id);
    // rows arriving — stagger the first six only
    if (!seenIds.has(f.id)) { seenIds.add(f.id); if (bootstrapped && index < 6) freshRows.add(f.id); }
    if (before !== undefined && before !== f.status) {
      if (f.status === 'done') { freshDone.add(f.id); }
      if (f.status === 'error' && !isBlocked(f)) { freshError.add(f.id); haptic([12, 40, 12]); }
    }
    prevStatus.set(f.id, f.status);
  });
  [...prevStatus.keys()].forEach(id => { if (!files.some(f => f.id === id)) { prevStatus.delete(id); seenIds.delete(id); } });

  if (prevCount !== null && prevCount !== files.length) countFresh = true;
  prevCount = files.length;

  const dot = counts.helper > 0;
  if (dot && !prevHelperDot) dotFresh = true;
  prevHelperDot = dot;

  if (pendingAdd && files.length) pendingAdd = false;

  // batch finished — every file settled, at least one written
  const settled = files.length && files.every(f => f.status === 'done' || f.status === 'error');
  const anyDone = files.some(f => f.status === 'done');
  const nextActionStatus = OneToolActionState.nextActionStatus(actionStatus, files);
  if (nextActionStatus !== actionStatus) {
    actionStatus = nextActionStatus;
  }
  if (settled && anyDone && !batchAnnounced) { batchAnnounced = true; haptic(18); showToast('Batch finished', true, commonFolder()); loadHistory(); }
  if (!settled) batchAnnounced = false;

  bootstrapped = true;
}
let batchAnnounced = false;
/* Haptics are used for exactly two events: a finished batch and an unreadable file. */
function haptic(pattern) { try { navigator.vibrate?.(pattern); } catch { /* unsupported */ } }
/* Containers build one file out of many and accept no dropped file, so they are
   kept out of the Convert view's routes entirely and handed to the Creator. */
let containers = [];
function setTools(list) {
  const all = list || [];
  containers = all.filter(t => t.multi);
  tools = all.filter(t => !t.multi);
  toolMap = byId(tools, 'id');
}
async function loadHistory() {
  try { const res = await fetch('/api/history'); const data = await res.json();
    historyRecords = Array.isArray(data.history) ? data.history : []; render(); }
  catch (error) { showToast(error.message, false); }
}

