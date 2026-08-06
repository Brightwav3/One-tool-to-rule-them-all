(function initPanelResize(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OneToolPanelResize = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  /* MIN_WIDTH is no longer a floor — it is the point below which the panel stops
     being a panel. Dragging right past it keeps shrinking, all the way to the
     window edge, and the pane blanks rather than squeezing its content into a
     column too narrow to read. Dragging left is unchanged: MAX_WIDTH still caps it. */
  const MIN_WIDTH = 240;
  const SNAP_THRESHOLD = MIN_WIDTH / 2;
  const MAX_WIDTH = 520;
  const DEFAULT_WIDTH = 308;
  const COLLAPSED_WIDTH = 0;

  function clampPanelWidth(width, viewportWidth) {
    const viewport = Number(viewportWidth);
    const max = Number.isFinite(viewport)
      ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewport - 360))
      : MAX_WIDTH;
    const value = Number(width);
    const safe = Number.isFinite(value) ? value : DEFAULT_WIDTH;
    return Math.round(Math.min(Math.max(safe, COLLAPSED_WIDTH), max));
  }

  /* The midpoint is the decision line between the two stable sidebar states. */
  function isPanelCollapsed(width) {
    const value = Number(width);
    return Number.isFinite(value) ? value <= SNAP_THRESHOLD : false;
  }

  /* Below the midpoint the sidebar resolves closed. Above it, it resolves to
     its readable minimum. This gives both opening and closing a deliberate
     threshold rather than an immediate jump. */
  function snapPanelWidth(width) {
    const value = Number(width);
    if (isPanelCollapsed(value)) return COLLAPSED_WIDTH;
    return value < MIN_WIDTH ? MIN_WIDTH : Math.round(value);
  }

  function widthFromDrag(startWidth, startX, currentX, viewportWidth) {
    const start = Number(startWidth);
    const width = clampPanelWidth(start + Number(startX) - Number(currentX), viewportWidth);
    return snapPanelWidth(width);
  }

  /* The Convert view stacks the queue above the history and lets the border
     between them be dragged. Both panes keep a floor so neither can be pulled
     out of existence. */
  const MIN_PANE = 96;

  function clampSplitHeight(height, availableHeight) {
    const available = Number(availableHeight);
    const max = Number.isFinite(available) && available > MIN_PANE * 2
      ? available - MIN_PANE
      : MIN_PANE;
    const value = Number(height);
    const safe = Number.isFinite(value) ? value : MIN_PANE;
    return Math.round(Math.min(Math.max(safe, MIN_PANE), max));
  }

  function splitHeightFromDrag(startHeight, startY, currentY, availableHeight) {
    return clampSplitHeight(Number(startHeight) + Number(currentY) - Number(startY), availableHeight);
  }

  return {clampPanelWidth, isPanelCollapsed, snapPanelWidth, widthFromDrag, clampSplitHeight, splitHeightFromDrag,
    MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH};
}));
