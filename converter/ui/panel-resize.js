(function initPanelResize(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OneToolPanelResize = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const MIN_WIDTH = 240;
  const MAX_WIDTH = 520;
  const DEFAULT_WIDTH = 308;

  function clampPanelWidth(width, viewportWidth) {
    const viewport = Number(viewportWidth);
    const max = Number.isFinite(viewport)
      ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewport - 360))
      : MAX_WIDTH;
    const value = Number(width);
    const safe = Number.isFinite(value) ? value : DEFAULT_WIDTH;
    return Math.round(Math.min(Math.max(safe, MIN_WIDTH), max));
  }

  function widthFromDrag(startWidth, startX, currentX, viewportWidth) {
    return clampPanelWidth(Number(startWidth) + Number(startX) - Number(currentX), viewportWidth);
  }

  return {clampPanelWidth, widthFromDrag};
}));
