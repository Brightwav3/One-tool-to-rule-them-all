function convertRows() {
  /* A file that has just been written is still in the queue and already in the
     history; it is shown once, from the queue, borrowing the record's timestamp
     so the Written column is filled the moment the row turns green. */
  const writtenAt = new Map(historyRecords.map(record => [`${record.sourcePath}|${record.to}`, record.finishedAt]));
  const queued = files.map(file => ({
    kind: 'queue', id: file.id, file, name: file.name, from: file.from, to: file.to,
    state: isBlocked(file) ? 'blocked' : file.status,
    cat: String(toolMap[file.conv]?.cat || 'documents').toLowerCase(),
    size: file.status === 'done' ? fmtSize(file.size) : '',
    when: file.status === 'done' ? fmtWhen(writtenAt.get(`${file.sourcePath}|${file.to}`)) : '',
  }));
  const inQueue = new Set(files.map(file => `${file.sourcePath}|${file.to}`));
  const written = historyRecords
    .filter(record => !record.deleted && !inQueue.has(`${record.sourcePath}|${record.to}`))
    .map(record => {
      const state = histState(record);
      return {
        kind: 'history', id: record.id, record, name: record.name, from: record.from, to: record.to,
        state: state === 'completed' ? 'done' : state === 'uncompleted' ? 'stopped' : state === 'active' ? 'running' : 'missing',
        cat: histCategory(record), size: fmtSize(record.size), when: fmtWhen(record.finishedAt),
      };
    });
  return [...queued, ...written];
}
function uMatches(row, id) {
  if (id === 'all') return true;
  if (id === 'active') return U_ACTIVE.includes(row.state);
  if (id === 'completed') return row.state === 'done';
  if (id === 'stopped') return row.state === 'stopped' || row.state === 'error';
  if (id === 'missing') return row.state === 'missing';
  return row.cat === id;
}
function visibleRows() {
  const all = convertRows();
  const order = all.map(row => row.id);
  return all.filter(row => uMatches(row, histFilter)).sort((a, b) => {
    const rank = uRank(a) - uRank(b);
    if (rank !== 0) return rank;
    if (histSort === 'name') return String(a.name).localeCompare(String(b.name));
    if (histSort === 'largest') return Number(b.record?.size || b.file?.size || 0) - Number(a.record?.size || a.file?.size || 0);
    if (histSort === 'oldest') return order.indexOf(b.id) - order.indexOf(a.id);
    return order.indexOf(a.id) - order.indexOf(b.id);
  });
}
/* The selection helpers and the inspector still speak in history records. */
function visibleHistory() { return visibleRows().filter(row => row.kind === 'history').map(row => row.record); }
