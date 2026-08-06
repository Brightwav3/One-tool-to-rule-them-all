(function initPanelResize(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OneToolPanelResize = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  /* MIN_WIDTH is no longer a floor — it is the point below which the panel stops
     being a panel. Dragging right past it keeps shrinking, all the way to the
     window edge, and the pane blanks rather than squeezing its content into a
     column too narrow to read. Dragging left is unchanged: MAX_WIDTH still caps it. */
  const MIN_WIDTH = 240;
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

  /* Anything under the old minimum reads as collapsed, so the caller can blank the
     pane instead of rendering a sliver of clipped text. */
  function isPanelCollapsed(width) {
    const value = Number(width);
    return Number.isFinite(value) ? value < MIN_WIDTH : false;
  }

  function widthFromDrag(startWidth, startX, currentX, viewportWidth) {
    return clampPanelWidth(Number(startWidth) + Number(startX) - Number(currentX), viewportWidth);
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

  return {clampPanelWidth, isPanelCollapsed, widthFromDrag, clampSplitHeight, splitHeightFromDrag,
    MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH};
}));
