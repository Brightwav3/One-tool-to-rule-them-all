/* Items come from real files, so the list shows real names and real sizes. Page
   counts are not known until something opens the file, and are left blank rather
   than guessed. */
function creatorAddItems() {
  const input = $('crFiles');
  input.value = '';
  input.click();
}
function creatorTakeFiles(fileList) {
  const picked = [...fileList];
  if (!picked.length) return;
  creator.addItems(picked.map(file => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return {
      ext: (ext || 'file').toUpperCase().slice(0, 4),
      name: file.name,
      kind: CREATOR_KINDS[ext] || 'File',
      pages: 0,
      size: file.size / (1024 * 1024),
    };
  }));
  render(true);
}
/* The backend has no route that builds one file out of many yet, so Create runs the
   real progress treatment and then says plainly that nothing was written. */
let creatorTimer = null;
function creatorCreate() {
  const s = creator.state;
  if (!creator.canCreate(installedHelpers())) return;
  s.job = 'running'; s.pct = 0; render(true);
  clearInterval(creatorTimer);
  creatorTimer = setInterval(() => {
    s.pct += 5;
    if (s.pct >= 100) {
      clearInterval(creatorTimer); creatorTimer = null;
      s.pct = 100; s.job = 'done';
      showToast(`${creator.outputName()} is not written yet — Creator has no backend route`, false);
    }
    render(true);
  }, 100);
}
