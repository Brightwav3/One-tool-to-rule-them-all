# FreeDF Editor Integration — design

**Date:** 2026-08-07
**Status:** approved, not yet implemented
**Supersedes:** the Editor half of `BACKplan.md` Task 1 (the Creator half stands unchanged)

## Problem

`converter/ui/workspaces/editor/` is a prototype. `editor-state.js:23` invents 24
pages from `Math.sin` noise; every operation mutates JavaScript objects and
appends a string to a six-item log. No file is opened, rendered, or written.

`BACKplan.md` specs a backend for it built by hand on a PDF library. That library
is not installed and the backend does not exist, so the Editor is greenfield —
there is nothing to migrate.

## Decision

Build the Editor backend on **FreeDF** (`github.com/Brightwav3/custom-pdf-engine`),
an independently developed, MIT-licensed, pre-alpha Python PDF engine, treated as
a third-party dependency with no privileged access to this codebase.

FreeDF supplies, already implemented: a PDF parser, structural editing, stable
page identities across reordering, replayable immutable operations, Poppler-backed
rendering, atomic writes, and capability discovery. Those map one-to-one onto what
`BACKplan.md` asks to be hand-built.

Not implemented upstream, and therefore **out of scope**: redaction, annotations,
text extraction, OCR.

## Scope of the first pass

| Real | Prototype, and visibly marked so |
| --- | --- |
| Open a local PDF | Redact |
| Real page count, sizes, rotation, stable ids | Text |
| Poppler-rendered thumbnails and page views | Draw |
| Rotate, delete, insert, reorder | Stamp |
| Undo / redo | Crop |
| Save to a new file | OCR |

A prototype tool renders **disabled with its reason**, driven off the capability
dictionary the adapter reports — never a hardcoded list. This is the same
discipline `docs/architecture.md` states for converter readiness: the UI consumes
computed state, it does not decide it.

---

## 1. The adapter — `converter/pdf_engine.py`

### The boundary rule

**Only `converter/pdf_engine.py` may import `pdfengine`.** No FreeDF object,
exception, or type crosses out of this file. Everything leaving is
JSON-serializable `dict` / `list` / `str` / `int` / `float` / `bool` / `None`.

FreeDF is pre-alpha and its API will move. This single file is the entire
mitigation, so the rule is enforced mechanically, not by convention — see §6.

### Shape

```python
class PdfEngineAdapter(Protocol):
    def engine_info(self) -> dict: ...
    def open(self, path: str) -> dict: ...
    def inspect(self, session_id: str) -> dict: ...
    def capabilities(self, session_id: str) -> dict: ...
    def render(self, session_id: str, page_id: str, options: dict) -> dict: ...
    def apply(self, session_id: str, operations: list) -> dict: ...
    def undo(self, session_id: str) -> dict: ...
    def redo(self, session_id: str) -> dict: ...
    def save(self, session_id: str, path: str) -> dict: ...
    def artifact(self, session_id: str, artifact_id: str) -> bytes: ...
    def close(self, session_id: str) -> dict: ...
```

Two implementations:

- **`FreeDFAdapter`** — imports `pdfengine` lazily inside `__init__`, translates
  FreeDF objects to the dicts below, and maps every FreeDF exception to a typed
  `PdfEngineError(code=..., message=..., hint=...)`.
- **`UnavailablePdfAdapter`** — every method raises
  `PdfEngineError(code='engine-missing')` carrying the install hint. It must
  never import `pdfengine`, so a broken engine install cannot break the rest of
  the application.

`get_adapter()` selects one. The existing `/api/recheck` route re-runs the
selection, so the established "install it, click recheck" flow works unchanged.

### Emitted shapes

**Page**

```json
{"id": "...", "index": 0, "width": 612, "height": 792,
 "rotation": 0, "label": "1", "source": "/path/in.pdf", "artifact": null}
```

`id` is FreeDF's stable page identity. This is load-bearing: `editor-state.js`
already keys `state.sel` and `state.focus` by page id, so stable identities make
the existing selection model correct against real files with no rework.

**Capabilities**

```json
{"structural": true, "render": true,
 "redact": false, "text": false, "ocr": false}
```

Read from FreeDF's capability discovery on the open document, never hardcoded.

### Capability and version reporting

`engine_info()` is a document-independent call, available even from
`UnavailablePdfAdapter`:

```json
{"available": true,
 "name": "FreeDF",
 "version": "0.3.1",
 "apiVersion": 1,
 "supportedApiVersions": [1],
 "source": "wheel" | "sys.path" | null,
 "location": "/path/to/pdfengine",
 "renderer": {"backend": "poppler", "version": "26.02.0", "available": true},
 "capabilities": {"structural": true, "render": true,
                  "redact": false, "text": false, "ocr": false},
 "state": "ready" | "blocked" | "unsupported",
 "reason": null}
```

Rules:

- The adapter pins a **supported version range**. A version outside it resolves to
  `state: "unsupported"` with a reason naming both versions. It does not attempt
  the operations and hope.
- `state` uses the same vocabulary as the registry — `ready` / `blocked` /
  `unsupported` — so the UI's existing readiness rendering applies unchanged.
- `engine_info()` is surfaced in `GET /api/tools` alongside helper states, and
  shown in Settings. When the Editor misbehaves, the version and location that
  produced the behaviour are on screen rather than inferred.
- Document-level `capabilities(session_id)` may report *less* than
  `engine_info().capabilities` — an encrypted or malformed file can disable
  editing on that document alone. The UI reads the session's capabilities for
  tool state and the engine's for the Settings panel.

### Distribution

FreeDF becomes a **`Helper` in `converter/registry.py`**, like Poppler, extended
to a new kind: a Python package rather than a binary on `PATH`.

- Packaged build: a vendored wheel installed into the bundled runtime.
- Development: discovered on `sys.path`, with an `ONETOOL_PDFENGINE` override for
  pointing at a working checkout, matching the existing `ONETOOL_*` convention.
- Absent or unsupported: the Editor shows a blocked state with the install hint.
  It does not crash, and no other workspace is affected.

FreeDF renders through Poppler, which is already a registered Helper here. No new
binary enters the build.

---

## 2. Sessions — `converter/editor_sessions.py`

`EditorSession` holds: id, source paths, ordered page manifest, `ops[]`, `cursor`,
output path, created/touched timestamps, and a source fingerprint (§4).

- Undo and redo move `cursor`. A new `apply` after an undo truncates the redo tail.
- The manifest is **re-derived from the adapter after every change**. One Tool
  never re-implements PDF semantics locally, so the server and the engine cannot
  disagree about what the document is.
- Persisted to `editor-sessions.json` in the existing app-data directory, per
  `BACKplan.md`. Operations are persisted; rendered artifacts never are.
- **Save is submitted as a `Job` on the existing queue.** Progress, history, the
  700 ms poll, and per-job error isolation all come for free. No second progress
  mechanism is introduced.

---

## 3. HTTP

`BACKplan.md`'s routes as specced:

| Route | Purpose |
| --- | --- |
| `POST /api/editor/open` | open sources, return session + pages + capabilities |
| `POST /api/editor/operation` | apply operations, return updated session + pages |
| `POST /api/editor/save` | queue a save job |
| `POST /api/editor/close` | close, idempotent |

Added:

| Route | Purpose |
| --- | --- |
| `POST /api/editor/undo` | move cursor back, return updated manifest |
| `POST /api/editor/redo` | move cursor forward, return updated manifest |
| `GET /api/editor/artifact?session=&id=` | render bytes |

### Render and artifact indirection

`render()` returns an **artifact id**, not bytes. `GET /api/editor/artifact`
serves the PNG with `Cache-Control: immutable`, because artifact ids are derived
from page identity plus render options and so never denote different bytes.

The manifest therefore stays small JSON and the browser performs the image
fetching, caching, and cancellation itself.

### Lazy rendering

- The grid requests thumbnails **only for visible pages**, at one low DPI.
- The reader requests one larger render for the focused page.

Opening a 400-page PDF must not render 400 images nobody looks at.

Artifacts live in a per-session temporary directory, bounded by a
least-recently-used cap, and are deleted on `close` and on server shutdown. An
evicted artifact is re-rendered on demand; artifact ids stay valid across
eviction because they are content-derived.

---

## 4. Recovery semantics

Every failure below has a code, a defined server response, and a defined UI
result. Nothing is left to a generic 500.

| Code | Cause | Server | UI |
| --- | --- | --- | --- |
| `engine-missing` | no usable `pdfengine` | 503 | Editor shows blocked state with install hint; Convert and Creator unaffected |
| `engine-unsupported` | version outside the supported range | 503 | same, reason names both versions |
| `source-unreadable` | not a PDF, or unreadable | 400 on open | toast, no session created |
| `source-changed` | fingerprint no longer matches on disk | 409 on any op | session frozen read-only; user chooses reopen (discard ops) or save-as from the last good manifest |
| `session-unknown` | id not found, or expired | 409 | UI drops to the empty state and says the session ended; it does not silently reopen |
| `operation-invalid` | unknown page id or malformed op | 400 | operation rejected, UI reconciles to the server manifest |
| `operation-unsupported` | capability not present | 422 | tool disabled and the reason shown; should be unreachable, since capabilities gate the tools |
| `save-conflict` | a save already running for this session | 409 | save control disabled while a save job is active |
| `save-failed` | write failed | job error | normal queue error path and history record; the session survives, so work is not lost |
| `engine-crash` | adapter raised unexpectedly | 500 | session marked degraded; ops preserved; user offered reopen-and-replay |

Rules that hold across all of them:

- **The source file is never mutated.** Save always writes a new file, atomically.
- **A failed operation never half-applies.** `apply` either commits to the log and
  returns a new manifest, or leaves the log untouched.
- **A session outlives a renderer reload.** Sessions are persisted, so reloading
  the window reattaches by id rather than losing the work.
- **A crash in the adapter does not take down `server.py`.** Every adapter call is
  wrapped; the failure becomes a typed error on one session.
- **Sessions expire** after a bounded idle period and are pruned at startup, so
  `editor-sessions.json` cannot grow without limit.

---

## 5. UI — `converter/ui/workspaces/editor/`

`makePages()`, `noise()`, and `LINE_WIDTHS` **stay**, demoted to the empty state:
what the grid shows before a document is open. They stop being the model.

`editor-state.js` keeps its entire shape. `state.pages`, `sel`, `focus`,
`targets()`, `current()` are unchanged. `state.edits` becomes a read-only view of
the server's operation log instead of hand-written English strings.

A new `editor-actions.js` holds the backend calls, matching how `convert/` and
`creator/` are laid out. Snapshots are absorbed through `core/api-client.js` like
every other backend response.

### Conservative optimistic updates

Optimistic local application is allowed **only** for operations that cannot change
page identity, page count, or file content:

| Operation | Applied optimistically |
| --- | --- |
| selection, focus, mode, zoom | yes — never leaves the client |
| rotate | yes |
| reorder | yes |
| delete | **no** — wait for the server manifest |
| insert | **no** — the new page's id is the engine's to assign |
| undo / redo | **no** |
| save | **no** |

Rules:

- **The server manifest always wins.** On any response, the client reconciles to
  it wholesale rather than merging. A divergence is a bug to surface, not to patch
  over.
- **One in-flight mutation per session.** Further mutating actions are disabled
  until it resolves, so operation order is unambiguous and the op log is a true
  record of what happened.
- **A rejected optimistic op reverts visibly**, with the reason in a toast. It does
  not silently disappear.

Tools with no backing capability render disabled with the reason attached, read
from the session's capability dictionary.

---

## 6. Enforcement and tests

| File | Covers |
| --- | --- |
| `tests/test_pdf_engine.py` | adapter contract against both implementations; `engine_info` shape; version-range gating; `UnavailablePdfAdapter` must not import `pdfengine` |
| `tests/test_pdf_engine_boundary.py` | **the import rule, enforced**: scan the tree and fail if any file other than `converter/pdf_engine.py` references `pdfengine` |
| `tests/test_editor_sessions.py` | open, apply, undo, redo, save; ids stable across reorder; every recovery code in §4 |
| `tests/test_editor_api.py` | route contract, status codes, artifact caching headers |

The engine-backed tests skip cleanly when FreeDF is absent, so the suite still
passes on a machine without it — the same property the helper-dependent
conversion tests already have.

`docs/architecture.md` gains the boundary rule, so it is documented as well as
tested.

### The golden trace

`tests/ui/trace.js` has never exercised the Editor. Editor steps must be **added
and re-baselined deliberately**, as a separate reviewed commit. The baseline is
not to be regenerated silently as a side effect of this work.

---

## Risks

- **FreeDF is pre-alpha.** Its API will change. Mitigated by the adapter boundary,
  the enforced import rule, and version-range gating that fails loudly rather than
  behaving oddly.
- **The Editor will visibly do less than its toolbar suggests** until redaction,
  text, and OCR land upstream. Mitigated by capability-driven disabling, which
  states the reason rather than hiding the tool.
- **A new dependency kind** — a Python package as a `Helper`. Contained to
  `registry.py`, and reuses the readiness vocabulary already in place.
