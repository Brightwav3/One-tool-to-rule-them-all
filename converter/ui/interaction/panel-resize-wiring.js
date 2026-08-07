
function readPanelWidth() {
  try {
    const stored = localStorage.getItem(PANEL_WIDTH_STORAGE);
    return OneToolPanelResize.clampPanelWidth(stored === null ? 308 : stored, window.innerWidth);
  } catch { return OneToolPanelResize.clampPanelWidth(308, window.innerWidth); }
}
/* One width for every inspector in the app — the Convert panel and the panes
   Creator and Editor carry — so dragging one does not leave the others disagreeing
   about how wide an inspector is. */
function setPanelWidth(next, persist=true) {
  panelWidth = OneToolPanelResize.clampPanelWidth(next, window.innerWidth);
  const collapsed = OneToolPanelResize.isPanelCollapsed(panelWidth);
  document.documentElement.style.setProperty('--panel-width', `${panelWidth}px`);
  panel.dataset.collapsed = String(collapsed);
  /* A closed panel has to stay findable: the app marks the state so the handle
     can move fully inside the window and show its edge. */
  document.getElementById('app').dataset.panel = panelWidth === 0 ? 'closed' : 'open';
  document.querySelectorAll('.wk-side').forEach(side => { side.dataset.collapsed = String(collapsed); });
  document.querySelectorAll('[data-panel-resize]').forEach(handle => {
    handle.setAttribute('aria-valuenow', String(panelWidth));
  });
  if (persist) {
    try { localStorage.setItem(PANEL_WIDTH_STORAGE, String(panelWidth)); } catch { /* storage may be unavailable */ }
  }
}
function startPanelResize(event) {
  if (event.button !== undefined && event.button !== 0) return;
  const handle = event.target.closest?.('[data-panel-resize]');
  if (!handle) return;
  event.preventDefault();
  panelResizeSession = {startX: event.clientX, startWidth: panelWidth};
  work.dataset.resizing = 'true';
  document.body.classList.add('is-resizing-panel');
  handle.setPointerCapture?.(event.pointerId);
}
function movePanelResize(event) {
  if (!panelResizeSession) return;
  setPanelWidth(OneToolPanelResize.widthFromDrag(
    panelResizeSession.startWidth,
    panelResizeSession.startX,
    event.clientX,
    window.innerWidth,
  ), false);
}
/* Dragged past the point where the pane blanks, it closes on release rather than
   leaving an unreadable strip of panel behind. Dragging the handle back out
   brings it straight back. */
function settlePanelWidth() {
  setPanelWidth(OneToolPanelResize.snapPanelWidth(panelWidth));
}
function finishPanelResize() {
  if (!panelResizeSession) return;
  panelResizeSession = null;
  work.dataset.resizing = 'false';
  document.body.classList.remove('is-resizing-panel');
  settlePanelWidth();
}

setPanelWidth(readPanelWidth(), false);
/* Creator and Editor rebuild their pane on every render, so their handle is a new
   element each time. Listening on the document keeps one wiring for all of them. */
document.addEventListener('pointerdown', startPanelResize);
document.addEventListener('keydown', event => {
  const handle = event.target.closest?.('[data-panel-resize]');
  if (!handle) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const step = event.key === 'ArrowRight' ? 16 : -16;
  // Opening a closed panel from the keyboard goes straight to the width where
  // it is readable, rather than stepping through widths that re-close it.
  setPanelWidth(panelWidth === 0 && step > 0 ? OneToolPanelResize.MIN_WIDTH : panelWidth + step);
  settlePanelWidth();
});
document.addEventListener('pointermove', movePanelResize);
document.addEventListener('pointerup', finishPanelResize);
document.addEventListener('pointercancel', finishPanelResize);
window.addEventListener('resize', () => setPanelWidth(panelWidth, false));

