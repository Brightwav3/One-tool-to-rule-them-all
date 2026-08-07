/* ---------- icons ----------
   Every custom glyph is built here rather than pasted into markup, so each call
   site inherits the same geometry, stroke weight and hover behaviour. Parts named
   ia-* are the moving pieces; the CSS above owns what they do. */
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICON = {
  select: `<svg class="ic" width="16" height="16" viewBox="0 0 24 24" ${STROKE}><circle class="ia-ring" cx="12" cy="12" r="8"/></svg>`,
  /* the two arrows part on hover — the gesture is "these swap", not "these spin" */
  route: `<svg class="ic" width="16" height="16" viewBox="0 0 24 24" ${STROKE}><g class="ia-swapA"><path d="M4 9h13"/><path d="M14 6l3 3-3 3"/></g><g class="ia-swapB"><path d="M20 15H7"/><path d="M10 12l-3 3 3 3"/></g></svg>`,
  /* the same folder as the 48px reveal button, at menu scale, with the same flap */
  reveal: `<svg class="ic" width="17" height="17" viewBox="0 0 24 24"><path d="M2 6.5A2.5 2.5 0 0 1 4.5 4h4a2 2 0 0 1 1.4.6L11.5 6H20a2 2 0 0 1 2 2v.5H2Z" fill="#2563EB"/><rect class="ia-sheet" x="5" y="12" width="14" height="5" rx="1" fill="#EFF6FF"/><path class="ia-flap" d="M2 9.5A2 2 0 0 1 4 7.5h16a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.5Z" fill="#3B82F6"/></svg>`,
  /* the back sheet moves, so it reads as duplicating away rather than pasting on */
  copy: `<svg class="ic" width="16" height="16" viewBox="0 0 24 24" ${STROKE}><rect x="8" y="8" width="12" height="12" rx="2"/><path class="ia-up" d="M16 5.5A1.5 1.5 0 0 0 14.5 4h-8A2.5 2.5 0 0 0 4 6.5v8A1.5 1.5 0 0 0 5.5 16"/></svg>`,
  again: `<svg class="ic" width="16" height="16" viewBox="0 0 24 24" ${STROKE}><g class="ia-spin"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/></g></svg>`,
  remove: `<svg class="ic" width="16" height="16" viewBox="0 0 24 24" ${STROKE}><path class="ia-xa" d="M6 6l12 12"/><path class="ia-xb" d="M18 6L6 18"/></svg>`,
  rename: `<svg class="ic" width="16" height="16" viewBox="0 0 24 24" ${STROKE}><g class="ia-up"><path d="M14.5 5.5l4 4"/><path d="M6 18l-2.5.5.5-2.5L15.6 4.4a1.5 1.5 0 0 1 2.1 0l1.9 1.9a1.5 1.5 0 0 1 0 2.1L6 18Z"/></g><path d="M13 20h8"/></svg>`,
  alert: `<svg class="ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 6.5v6"/><path d="M12 16.6v.2" stroke-width="3"/></svg>`,
  external: `<svg class="ic" width="16" height="16" viewBox="0 0 24 24" ${STROKE}><path d="M14 4h6v6"/><path class="ia-up" d="M20 4l-8 8"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>`,
};
/* A full turn says "reordered", a half turn says "opened" — same glyph, two jobs. */
