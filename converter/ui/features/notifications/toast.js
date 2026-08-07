/* ---------- feedback ---------- */
function showToast(title, ok=true, sub='') {
  clearTimeout(toastTimer);
  $('toastTitle').textContent = title;
  $('toastSub').textContent = sub;
  $('toastMark').innerHTML = ok ? tickIcon(12, 'draw') : ICON.alert;
  $('toastMark').classList.toggle('bad', !ok);
  $('toast').dataset.open = 'true';
  toastTimer = setTimeout(() => { $('toast').dataset.open = 'false'; }, 4200);
}
function setActionStatus(next) {
  actionStatus = next; render(true);
  if (next !== 'pending') setTimeout(() => { actionStatus = 'idle'; render(true); }, 1400);
}

