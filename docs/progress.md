# Progress

Where the UI decomposition stands, and what a reviewer needs to know before
merging it back into the main repo.

## The short version

`converter/ui/index.html` was 3544 lines: markup, 1145 lines of CSS and a
2300-line inline `<script>` in one file. It is now 122 lines of markup that
links 11 stylesheets and loads 38 scripts. 23 commits, 77 files.

**No line of application code was rewritten to get there.** Every extraction was
a verbatim move, and every extraction commit proved it by reassembling the
source file from its pieces and diffing byte for byte against the previous
commit.

## Why a pure move was possible

Classic `<script src>` tags, concatenated in order, are equivalent to one
script: same global lexical environment, same top-level execution order. So any
contiguous range can leave the file losslessly, as long as the tags reproduce
the original order — ranges from the head load *before* the remaining monolith,
ranges from the tail load *after* it. The same equivalence holds for `<link>`
stylesheets, which is why the CSS split could not change the cascade.

That is the whole trick, and it is also the constraint:

- **No `type="module"`.** Modules would isolate every file and break every
  cross-file reference. That switch is one flag-day at the very end, not done.
- **Link order follows position in the original file, not the tree diagram.**
  `motion.css` is linked third because it sat at line 128.
- The one failure mode a relocation can introduce is a temporal dead zone, which
  throws loudly at load rather than misbehaving quietly.

## Layout

```
converter/ui/
  index.html         shell only
  styles/            11 files, split from app.css at its own section comments
  app/               bootstrap, app-context, app-state, render
  core/              api-client, actions, capabilities, formatters, ids
  workspaces/        convert/, creator/, editor/  (state, view, actions)
  features/          settings, inspector, command-palette, notifications
  components/        icon, modal, dropdown, file-row, empty-state, context-menu
  interaction/       action-router, keyboard, drag-drop, selection-state,
                     panel-resize, shortcut-labels, action-state
```

`legacy/monolith.js` — the shrinking holding pen — reached zero and is deleted.
Nothing references it.

## How it is verified

Three oracles, in the order they were needed.

**Byte identity** (phase A). Reassemble, diff, refuse the commit if it differs.
Free, total, and now spent: controllers and typed errors change bytes by
definition.

**The golden trace** (phase B, `tests/ui/trace.js`). Behavioural identity
replaces byte identity. A fixed 21-step script runs against the baseline build
and the working tree, and both traces are diffed:

| Recorded | Catches |
|---|---|
| every request, ordered, with body | a stray call, a lost call, a reordered pair |
| every toast, with ok/error | a swallowed error, a duplicated message |
| render passes per step | the classic event-bus bug, firing twice |
| current page per step | navigation that silently stopped working |
| final structure hash | markup that changed shape |
| final computed-style hash | 35 resolved CSS properties on every element |

```bash
node tests/ui/trace-diff.cjs tests/ui/traces/baseline.json tests/ui/traces/head.json
```

Current value, identical on both builds: 2 requests, 0 toasts, 43 render passes,
0 errors, 586 elements, structure `8ad83bcf23f40000`, computed
`1177f46f815b1100`.

The rig itself was tested — three faults injected into a copy of the baseline
(a duplicated render pass, a stray `POST /api/convert`, a changed computed
hash). It caught all three and exited 1.

**The differential smoke sweep** (`tests/ui/smoke.js`). Clicks every `data-act`
on every page against both builds and diffs the reports, so a failure only
counts if it appears on the refactored side alone. Structural fingerprints came
out identical on all three pages.

## What the oracles deliberately do not cover

Worth stating, because an identical trace is easy to over-read.

- **The trace only proves the code its script touches.** `log()` in the editor
  is not on that path, so the `ids.js` change was checked directly in the
  running app instead.
- The 700 ms `/api/state` poll is recorded as a flag, never as an ordered
  request — how often it has fired depends on machine speed, not behaviour.
- Destructive actions are skipped: converting, creating, installing, removing,
  resetting. They spend real time and touch real files.
- A plain browser has no `window.appWindow`, so file pickers, reveal-in-folder
  and the window controls cannot be exercised by any of this. Those need the
  Electron window.
- One viewport, so `@media` branches and font-load failures are unseen.
- **The 17 baseline screenshots in `docs/baseline/` have never been compared
  against.** This is the one check automation cannot make, and it is still open.

Two servers must be at equal state before any comparison, or the DOM differs for
reasons unrelated to the refactor:

```bash
curl -X POST http://127.0.0.1:8898/api/clear && curl -X POST http://127.0.0.1:8899/api/clear
```

## Phase B, started

| | |
|---|---|
| `core/ids.js` | done — one caller, replaced `state.edits.length + Date.now()` |
| `core/errors.js` | next |
| controllers | after that, extract-and-delegate, one action per commit |
| `core/events.js` | last, and argued against |

The rule for every one of them: **a commit ends with the app working.** If it
cannot end green, it is too big and gets split.

`core/errors.js` is the interesting one. `app-state.js` currently decides
control flow by regex-matching English prose:

```js
const isBlocked = f => f?.status === 'error' &&
  /isn.t installed|needs|helper/i.test(f.errorTitle || f.error || '');
```

The plan is backend-first and additive: `server.py` emits a `code` field
alongside the existing message; the UI reads `code` and keeps the regex as a
fallback; the fallback logs when it fires; the regex is deleted only once it has
stopped firing. No flag-day, and no window where a message reworded upstream
silently changes what the UI does.

## Still open

1. The visual pass against `docs/baseline/`.
2. `components/button.js` — 101 call sites collapse to roughly six variants.
3. Splitting the 97-branch action router.
4. Applying `styles/tokens.css` rather than merely having extracted it.
5. The eventual `type="module"` flag-day.

## Merging

This work lives in a sandbox clone with its own remote, disconnected from the
main repo, and none of it has been merged. Review the diff before taking it:

```bash
git remote add sandbox "C:/Users/Sajmon/pdf-tool-refactor"
```
```bash
git fetch sandbox refactor/ui-decomposition
```
```bash
git diff HEAD..sandbox/refactor/ui-decomposition --stat
```

`ui-monolith-baseline` tags the pre-refactor commit, so the whole thing can be
compared against — or reverted to — in one step.
