/* Diffs two golden traces and exits non-zero on any behavioural difference.
 *
 *   node tests/ui/trace-diff.cjs baseline.json head.json
 *
 * Reports the first differing step rather than a wall of JSON, because the
 * first divergence is the one that caused the rest.
 */
const fs = require('node:fs');

function load(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`cannot read ${p}: ${e.message}`); process.exit(2); }
}

const [, , aPath, bPath] = process.argv;
if (!aPath || !bPath) {
  console.error('usage: node tests/ui/trace-diff.cjs <baseline.json> <head.json>');
  process.exit(2);
}
const A = load(aPath), B = load(bPath);
const problems = [];

/* Errors first: a trace that threw is not comparable, it is just broken. */
if (B.errors.length) problems.push(`head raised ${B.errors.length} error(s): ${B.errors.join(' ; ')}`);
if (A.errors.length) problems.push(`baseline raised ${A.errors.length} error(s): ${A.errors.join(' ; ')}`);

if (A.steps.length !== B.steps.length) {
  problems.push(`step count ${A.steps.length} vs ${B.steps.length}`);
} else {
  for (let i = 0; i < A.steps.length; i++) {
    const a = A.steps[i], b = B.steps[i];
    const where = `step ${i + 1} (${a.step})`;
    if (a.step !== b.step) { problems.push(`${where}: script diverged, head ran ${b.step}`); break; }
    if (JSON.stringify(a.requests) !== JSON.stringify(b.requests)) {
      problems.push(`${where}: requests\n    baseline ${JSON.stringify(a.requests)}\n    head     ${JSON.stringify(b.requests)}`);
    }
    if (JSON.stringify(a.toasts) !== JSON.stringify(b.toasts)) {
      problems.push(`${where}: toasts\n    baseline ${JSON.stringify(a.toasts)}\n    head     ${JSON.stringify(b.toasts)}`);
    }
    if (a.renders !== b.renders) problems.push(`${where}: render passes ${a.renders} vs ${b.renders}`);
    if (a.page !== b.page) problems.push(`${where}: page ${a.page} vs ${b.page}`);
    if (problems.length > 6) { problems.push('... stopping, the first divergence explains the rest'); break; }
  }
}

for (const k of ['elements', 'structure', 'computed']) {
  if (A.final[k] !== B.final[k]) problems.push(`final ${k}: ${A.final[k]} vs ${B.final[k]}`);
}

const pad = (label, a, b) => `  ${label.padEnd(10)} ${String(a).padStart(6)}   ${String(b).padStart(6)}   ${a === b ? 'same' : 'DIFF'}`;
console.log('                baseline     head');
for (const k of ['requests', 'toasts', 'renders', 'errors']) console.log(pad(k, A.totals[k], B.totals[k]));
for (const k of ['elements', 'structure', 'computed']) console.log(pad(k, A.final[k], B.final[k]));

if (problems.length) {
  console.log('\nDIFFERENCES');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('\nIDENTICAL: same requests, same toasts, same render passes, same final page.');
