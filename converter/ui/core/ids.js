/* Ids for records the client invents and the server never sees.
 *
 * The original expression was `state.edits.length + Date.now()`, which is two
 * unrelated ideas added together: a clock that can repeat inside one
 * millisecond, and a length that shrinks when the list is capped. It happened
 * not to collide, but nothing made that true.
 *
 * A counter is unique by construction. The prefix keeps ids from different
 * lists distinguishable when they end up in the same Set, which is what the
 * editor does with `seenEdits`.
 *
 * Not for the editor's or creator's `state.nextId`. Those number pages, marks
 * and queue items, are reset when their state is rebuilt, and are compared
 * against ids that arrive with real data — a different problem, left alone.
 *
 * Attached to globalThis rather than to `root` because its callers reach it as
 * a bare global, and they do so from Node in the test suite as well as from the
 * browser. Also exported, so the module can be required directly.
 */
(function initIds(root, factory) {
  const api = factory();
  globalThis.nextLocalId = api.nextLocalId;
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OneToolIds = api;
}(typeof self !== 'undefined' ? self : this, () => {
  let seq = 0;
  function nextLocalId(prefix = 'id') {
    seq += 1;
    return prefix + '-' + seq;
  }
  return {nextLocalId};
}));
