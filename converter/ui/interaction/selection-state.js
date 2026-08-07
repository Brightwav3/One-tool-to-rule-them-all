(function initSelectionState(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OneToolSelectionState = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  function updateSelection({ids = [], selected = [], anchorId = null, targetId, shift = false, toggle = false}) {
    const order = ids.map(String);
    const target = String(targetId);
    if (!order.includes(target)) return {selected: [...selected], anchorId};
    if (shift && anchorId !== null && order.includes(String(anchorId))) {
      const anchorIndex = order.indexOf(String(anchorId));
      const targetIndex = order.indexOf(target);
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      return {selected: order.slice(start, end + 1), anchorId};
    }
    const next = new Set(selected.map(String));
    if (toggle) {
      if (next.has(target)) next.delete(target); else next.add(target);
      return {selected: [...next], anchorId: target};
    }
    return {selected: [target], anchorId: target};
  }
  return {updateSelection};
}));
