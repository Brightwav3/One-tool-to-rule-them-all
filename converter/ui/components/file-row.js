/* ---------- queue ---------- */
function chevron(size = 12, part = '') {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" ${STROKE}><path class="${part}" d="M4 6.5L8 10.5 12 6.5"/></svg>`;
}
/* The path is centred on the viewBox rather than drawn by eye: its bounding box
   runs 5–19 across and 7.15–16.85 down, so both midpoints land on 12 and the
   mark sits square inside the checkbox at every size. */
function tickIcon(size = 12, cls = '') {
  return `<svg class="ic ic-tick ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.05 L9.8 16.85 L19 7.15"/></svg>`;
}
/* Format is carried by a filled pill inside the page rather than by mono text
   scaled below the type ramp, and each family keeps its own token colour. */
function thumbKind(f) {
  if (f?.kind === 'image') return {label: 'IMG', tint: 'var(--success)', pages: false, photo: true};
  if (f?.kind === 'comic') return {label: 'CBZ', tint: 'var(--warning)', pages: true, photo: false};
  return {label: String(f?.from || 'FILE').toUpperCase().slice(0, 4), tint: 'var(--accent)', pages: (f?.units || 0) > 1, photo: false};
}
function fileThumb(f, cls = 'thumb') {
  const k = thumbKind(f);
  const back = k.pages ? `<rect class="ia-page2" x="5" y="5" width="34" height="48" rx="3" style="fill:var(--surface-sunken);stroke:var(--border-subtle)" stroke-width="1.2"/>` : '';
  const body = k.photo
    ? `<circle cx="13" cy="14" r="3.5" style="fill:var(--border-default)"/><path class="ia-drop" d="M4 30l8-9 7 8 5-4 11 10v10H4V30Z" style="fill:var(--border-default)" opacity=".55"/>`
    : `<path d="M8 12h20M8 18h20M8 24h13" style="stroke:var(--border-default)" stroke-width="1.4" stroke-linecap="round"/>`;
  const corner = k.pages || k.photo ? '' : `<path class="ia-corner" d="M27 1h1l7 7v1h-6a2 2 0 0 1-2-2V1Z" style="fill:var(--surface-sunken);stroke:var(--border-default)" stroke-width="1.2"/>`;
  return `<span class="${cls}" aria-hidden="true"><svg viewBox="0 0 44 56" role="img" aria-label="${esc(k.label)} file">
    ${back}
    <rect x="1" y="1" width="34" height="48" rx="3" style="fill:var(--surface-card);stroke:var(--border-default)" stroke-width="1.2"/>
    ${body}
    ${corner}
    <rect x="6" y="33" width="24" height="12" rx="2.5" style="fill:${k.tint}"/>
    <text x="18" y="42" text-anchor="middle" font-size="8" font-family="var(--font-mono)" style="fill:var(--text-inverse)">${esc(k.label)}</text>
  </svg></span>`;
}
function folderIcon(path, revealKind='queue') {
  const isOutput = revealKind === 'output' || revealKind === 'history';
  const label = isOutput ? 'Open output location' : 'Open source location';
  return `<button class="file-folder press" data-act="reveal-file" data-path="${esc(path || '')}" data-reveal-kind="${revealKind}" aria-label="${label}">
    <svg class="folder" width="48" height="48" viewBox="0 0 48 48" role="img" aria-label="Folder">
      <path d="M4 13a4 4 0 0 1 4-4h9.2a4 4 0 0 1 2.8 1.2L23 13h17a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V13Z" fill="#2563EB"/>
      <rect class="fdr-sheet" x="8" y="25" width="32" height="9" rx="1.5" fill="#EFF6FF"/>
      <path class="fdr-front" d="M4 17a4 4 0 0 1 4-4h32a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V17Z" fill="#3B82F6"/>
    </svg>
  </button>`;
}
function metaLine(f) {
  const bits = [];
  if (f.units > 1) bits.push(`${f.units} pages`);
  else if (f.kind === 'image') bits.push('image');
  const size = fmtSize(f.sourceSize || 0);
  if (size) bits.push(size);
  return bits.join(' · ');
}
function statusText(f) {
  if (isBlocked(f)) { const helper = (f.errorTitle || '').replace(/ isn't installed.*/i, '').trim(); return helper ? `needs ${helper}` : 'needs a helper'; }
  if (f.status === 'error') return f.errorTitle || 'could not convert';
  if (f.status === 'done') return `done · ${fmtSize(f.size)}`;
  if (f.status === 'running') return f.units ? `page ${Math.max(1, f.doneUnits || 1)} of ${f.units}` : 'working…';
  if (f.status === 'queued') return 'waiting';
  return 'ready';
}
function statusClass(f) { if (isBlocked(f)) return 'blocked'; if (f.status === 'error') return 'failed'; if (f.status === 'done') return 'done'; return ''; }
function pct(f) { if (f.status === 'done') return 100; if (!f.units) return 0; return Math.max(0, Math.min(100, Math.round((f.doneUnits || 0) / f.units * 100))); }

/* Shimmer marks work whose progress genuinely cannot be counted. Anywhere a real page
   count exists, the determinate bar carries the information instead. */
const indeterminate = f => f.status === 'running' && !f.units;
