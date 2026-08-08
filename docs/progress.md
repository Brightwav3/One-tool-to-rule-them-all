# Progress

Where the FreeDF Editor integration stands, and what the next session needs to
pick it up.

For the earlier UI decomposition write-up, see
[`progress-ui-decomposition.md`](progress-ui-decomposition.md).

## The short version

The Editor was a prototype: `editor-state.js` invented 24 pages from `Math.sin`
noise and every operation mutated a JavaScript object. It now opens real PDFs,
shows real Poppler-rendered pages, and writes real files, on a backend built on
**FreeDF** — an independently developed, MIT-licensed PDF engine treated here as
a third-party dependency.

**19 of 19 planned tasks are implemented and verified.** Tasks 1–19 are complete.
Task 17's focused UI suite is green: **33 tests, 0 failures** (plus the renderer
source checks). The Python suite remains
environment-sensitive on this desktop: its Poppler resolver currently picks a
broken `.cmd` shim; with that shim removed from `PATH`, the 14 affected render
and page-image tests pass.

## Where to pick up

The plan is [`plans/2026-08-07-freedf-editor-integration.md`](plans/2026-08-07-freedf-editor-integration.md).
It is written for an implementer with no context: exact files, exact code, exact
tests, in numbered steps.

Tasks 1–12 are committed; Tasks 13–19 are implemented and verified in the
working tree. Task 18 was captured in a live Electron run against
`tests/fixtures/inherited-pages.pdf`; no baseline numbers were guessed.
The post-integration Editor icon pass is also complete: the supplied sprite is
served as `converter/ui/icons.svg` and drives the six tool buttons plus both
rotate controls.

Reader previews now request a bounded, zoom-aware high-resolution Poppler render
(1000–3000 px); the grid continues to use the smaller 180/360 px thumbnail
renders. Ctrl+Space now remains active after opening a file: the hidden file
picker input no longer blocks Editor keyboard shortcuts, and the reader's
device-pixel-ratio lookup is safe in the browser runtime.

| Task | State |
| --- | --- |
| 1 Vendor FreeDF, discover it, report it | done |
| 2 Adapter: open, inspect, capabilities, close | done |
| 3 Adapter: render | done |
| 4 Adapter: apply, undo, redo | done |
| 5 Adapter: save | done |
| 6 `EditorSession` and its store | done |
| 7 HTTP: open, inspect, close | done |
| 8 HTTP: operation, undo, redo | done |
| 9 HTTP: page image route | done |
| 10 HTTP: save through the queue | done |
| **13 UI: structural ops + optimistic policy** | **done** |
| **14 UI: undo and redo** | **done** |
| **15 UI: crop** | **done** |
| **16 UI: OCR text layer** | **done** |
| **17 Recovery behaviour end to end** | **done** |
| **18 Extend the golden trace and re-baseline** | **done** — live Electron trace: 9 requests, 0 toasts, 57 renders, 0 errors; 523 elements, structure `238ec99f5a4b2a00`, computed `199440d0cc893000` |
| **19 Two-tier testing and documentation** | **done** |

Tasks 11 and 12 are done and are listed in the plan between 10 and 13.

The design document behind the plan is
[`specs/2026-08-07-freedf-editor-integration-design.md`](specs/2026-08-07-freedf-editor-integration-design.md).
Read the plan's **"Stale assumptions"** table before the spec — the spec was
written against FreeDF v0.1 and the plan corrects it in nine places.

## What exists now

```
converter/
  pdf_engine.py          the ONLY file that may import pdfengine
  editor_sessions.py     EditorSession, EditorSessionStore, revisions, replay
  vendor/pdfengine/      unpacked FreeDF 0.2.0, shipped as-is
  vendor/README.md       provenance: repo, branch, commit, rebuild commands
  server.py              /api/editor/* routes, save as a queue Job
  registry.py            FreeDF as a Helper, capability states collapsed here
  ui/workspaces/editor/
    editor-state.js      real page model; the generators now draw the empty state
    editor-actions.js    backend calls
    editor-view.js       real tiles, capability-driven tool state
```

### The API

| Route | |
| --- | --- |
| `POST /api/editor/open` | `{paths}` → snapshot |
| `POST /api/editor/inspect` | `{sessionId}` → snapshot |
| `POST /api/editor/close` | `{sessionId}` → `{closed:true}`, idempotent |
| `POST /api/editor/operation` | `{sessionId, operations, dryRun?}` → snapshot |
| `POST /api/editor/undo` / `redo` | `{sessionId}` → snapshot |
| `POST /api/editor/save` | `{sessionId, outputPath?}` → `{jobId, outputPath}` |
| `GET /api/editor/page.png` | `?session=&page=&w=&rev=` → `image/png` |

A snapshot is `{session, document, capabilities, canUndo, canRedo, revision,
engineState, status}`.

### Proven end to end

Against a real two-page PDF, through the running HTTP server:

```
engine: freedf 0.2.0 api v1 ready source vendored
opened: 2 pages, rev 0, engineState open
after rotate: rev 1, canUndo True
page.png: 200 image/png 677 bytes; Cache-Control: …immutable
stale rev -> 409 revision-stale
SAVED: True 896 bytes
SOURCE UNTOUCHED: True
```

## The constraints that hold this together

- **Only `converter/pdf_engine.py` may import `pdfengine`.** Enforced by
  `tests/test_pdf_engine_boundary.py`, which parses imports with `ast` rather
  than scanning for the word — so a string that merely names the package is not
  a violation, and a real import added anywhere else is. The checker is itself
  tested against six positives and three negatives.
- **No FreeDF type crosses that boundary.** Everything out is plain JSON types
  or `bytes`, asserted by `test_no_freedf_type_escapes`.
- **The source PDF is never mutated.** `allow_replace_source` is never set.
- **Save runs on the existing conversion queue**, so progress, history and
  per-job error isolation are the ones already built. No second mechanism.
- **The distribution is `freedf`; the import package is `pdfengine`.** That
  split is deliberate upstream. Do not "fix" it.
- Compatibility gates on **both** `API_VERSION` (`"v1"`) and a minimum engine
  version (0.2.0). The first catches a contract break, the second catches a
  build that speaks `v1` but predates the features this depends on.
- Engine precedence: `ONETOOL_PDFENGINE` → vendored → installed.
  `engine_info().location` always reports which one loaded.

## What the implementation found that the plan did not predict

Four of these changed the design. They are worth reading before touching the
remaining tasks.

**Page ids are stable within a session, not across opens.**
`pdfengine/document/pages.py:203` mints `page_{uuid4().hex}` per page per open.
Verified:

```
open1: page_22c1e0be…   open2: page_b20f2bfb…   IDENTICAL ACROSS OPENS: False
                                                 STABLE ACROSS REORDER:  True
```

Stability across reorder is what the UI's selection model needs, so keying
`state.sel` by id is correct. But replaying a persisted operation log after a
backend restart dies with `unknown page ID`. `EditorSession` therefore also
persists `basePageIds` in source-index order and translates old→new on
`reattach`. The plan's own restart test cannot catch this, because
`get_adapter()` is process-cached and the "revived" store meets the same live
engine — it was verified separately against a genuinely fresh one.

**FreeDF's render `width` is a bounding dimension, not an exact width.** A
landscape page requested at 180 comes back 255×180. Tiles must size from the
returned `width`/`height`. Task 13 onward inherits this.

**`rev` must be rebuilt into every image URL after every mutation**, or
`page.png` correctly returns 409 `revision-stale`. `revision` is monotonic — it
increments on undo and redo too, because a repeated value would serve a stale
image.

**A dry-run delete on a one-page document is refused by the engine**, so the
plan's `test_dry_run_does_not_commit` passed for the wrong reason. It now uses
the two-page fixture. `tests/fixtures/inherited-pages.pdf` is the only
multi-page fixture that opens; `xref-stream.pdf` is deliberately unsupported.

**Smaller corrections:** the history record's field is `outputPath`, not
`output`. `.gitattributes` marks `*.pdf binary`, without which Git would
CRLF-corrupt the fixtures on a fresh clone. `engine.save()` already refuses to
overwrite the source and already checks `source_changed()`, so the adapter
defers to it rather than adding its own guard.

## Two tests were repaired, not written

`test_root_serves_the_electron_renderer` and
`test_inspector_renders_format_aware_facts_and_controls` had been failing since
the UI decomposition. Neither feature had regressed: both read `index.html` and
asserted on strings the decomposition had moved to `styles/shell.css` and
`features/inspector/`. They had quietly become assertions about file layout.
They now assert the behaviour where it lives — fetching `shell.css` over HTTP,
and searching the whole renderer — so moving a file again will not fail them,
while deleting the feature still will.

## Still open

1. **The visual pass against `docs/baseline/`** — still never done, inherited
   from the decomposition work.
2. **Release tier status:** implemented and verified; clean-PATH release run
   passes 185 tests with two intentional skips.
3. **Decisions D4 and D5** are answered inside Tasks 12 and 9. D1, D2 and D3
   were approved before implementation and are recorded in the plan.

## Engine provenance

FreeDF lives at `github.com/Brightwav3/custom-pdf-engine`, branch
`feat/v0.2-integration`, commit `2a48e49` — pushed, so the vendored tree is not
the only copy. `converter/vendor/README.md` records how to rebuild and refresh
it. The engine is pre-alpha; the adapter boundary is the entire mitigation, which
is why the import rule is enforced by a test rather than by convention.
