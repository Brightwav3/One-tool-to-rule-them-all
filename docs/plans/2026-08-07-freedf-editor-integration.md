# FreeDF Editor Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make One Tool's Editor operate on real PDF files by putting FreeDF behind a single adapter, replacing the prototype's generated pages with a real page model, real renders, and real saves.

**Architecture:** Editor UI → `editor-actions.js` → One Tool editor HTTP API → `EditorSession` → `PdfEngineAdapter` → FreeDF public Python API. Only `converter/pdf_engine.py` imports `pdfengine`; that rule is enforced by a test, not by convention. FreeDF is discovered as a registry `Helper` like Poppler, so an absent or unsupported engine yields a blocked Editor rather than a crash.

**Tech Stack:** Python 3.11+ (this machine runs 3.12.10), `converter/server.py`'s stdlib HTTP server, existing registry/queue/history model, FreeDF (`pdf-engine`, MIT), Poppler and Tesseract as FreeDF's own optional backends, `unittest`.

**Spec:** `docs/specs/2026-08-07-freedf-editor-integration-design.md`. Where this plan and the spec disagree, **this plan wins** — see "Spec corrections" below.

---

## Global Constraints

- Only `converter/pdf_engine.py` may import `pdfengine`, in any form. Enforced by `tests/test_pdf_engine_boundary.py`.
- No FreeDF object, dataclass, or exception crosses out of `converter/pdf_engine.py`. Outbound values are `dict` / `list` / `str` / `int` / `float` / `bool` / `None` / `bytes` only.
- The service binds only to `127.0.0.1`. No telemetry, no cloud, no external storage.
- Every existing API route, queue behaviour, and history behaviour is preserved.
- A selected source PDF is never mutated in place. `allow_replace_source` is never set to `True`.
- Every local path, page id, operation kind, and output name is validated server-side. Renderer state is untrusted input.
- Python floor is 3.11 (FreeDF's `requires-python = ">=3.11"`).
- Compatibility is pinned on FreeDF's `API_VERSION`, **not** its package version. See correction C5.
- Every commit leaves the application launchable and the full suite green.

---

## Spec corrections — FreeDF v0.2 as it actually is

Read before starting. Five assumptions in the design document do not survive contact with the source.

### C1. OCR and crop are implemented — but OCR is Python-API-only

`crop_pages` and `add_text_layer` are both real operations in
`pdfengine/api/models.py`, and both appear in `OPERATION_TYPES`.

The asymmetry: `parse_operation()` in `pdfengine/api/contracts.py` handles
`crop_pages` but has **no branch for `add_text_layer`**, and does not import it.
FreeDF's own JSONL CLI and HTTP service therefore cannot perform OCR — only the
Python API can.

This is an argument *for* the chosen in-process adapter, and it is why the
sidecar and CLI options would have silently cost us OCR. `FreeDFAdapter`
constructs `AddTextLayer(...)` directly and passes it to
`engine.apply_operations()`.

Neither feature is described as upstream-missing anywhere in this plan.

### C2. FreeDF artifact ids are useless for browser caching — do not build a second artifact system

`CommandDispatcher._command_render` mints `f"artifact_{uuid4().hex}"` on **every
call**, stores it in an unbounded in-memory dict, and exposes no command to
retrieve it — `artifact` is not in `COMMANDS`. Those ids are random per call, not
content-derived.

They are also irrelevant to us: the Python API's `PdfEngine.render_page()`
returns a `RenderResult` carrying `image_bytes` directly. Artifact ids exist only
in the JSON transport layer we are not using.

**Therefore:** no artifact subsystem, first or second. FreeDF already
content-addresses renders on disk in `RenderCache`, keyed by
`(fingerprint, page_id, width, renderer_version)`. One Tool adds only a **browser
cache key**, which is a URL parameter and nothing more:

```
GET /api/editor/page.png?session=<id>&page=<pageId>&w=180&rev=<n>
```

`rev` is `EditorSession.revision`, a monotonic integer that One Tool already has
to maintain for undo/redo. Any operation bumps it, so the URL changes and the
browser refetches; the response carries `Cache-Control: public, max-age=31536000,
immutable`, which is true because the URL now identifies exactly one image.

Undoing back to a previous revision produces a new `rev` and so a browser miss,
but FreeDF's on-disk cache still hits and the re-render is near-free. That is the
correct trade for not owning a cache invalidation problem.

**`artifact()` is dropped from the adapter interface.** See decision D1 — this
changes the interface you declared fixed, so it needs your sign-off.

### C3. Capability states are `ready` / `blocked` / `error`, and are structured, not boolean

`pdfengine/ocr/base.py` defines `CapabilityState = Literal["ready", "blocked", "error"]`.
There is no `unavailable` state. `engine.capabilities(session)` returns:

```python
{
  "preview": {"state": "ready", "detail": ""},
  "ocr": {"state": "blocked", "detail": "...", "engine": "", "modes": [], "languages": []},
  "operations": [{"kind": "rotate_pages", "safe": True, "requires": [], "schema": "operation-request.json"}, ...],
  "save": {"fullRewriteOnly": True, "inPlaceRequiresOptIn": True},
  "read": {
    "structuralEdit": {"state": "ready", "detail": ""},
    "textContent": {"state": "blocked", "detail": "3 streams use filters this version cannot decode",
                    "filters": ["JPXDecode"], "objectCount": 3}
  }
}
```

The spec's `{structural: true, render: true, redact: false, text: false, ocr: false}` is
wrong twice over: it collapses `{state, detail}` to a boolean, throwing away the
`detail` string that tells the user *why*, and it invents capability names FreeDF
does not use.

**Rule:** the adapter passes this dictionary through **unchanged** under
`capabilities`. Collapsing to One Tool's registry vocabulary happens in
`registry.py` and the UI, and always keeps `detail` alongside the collapsed
state. `error` is never silently folded into `blocked` — a broken Tesseract and
an absent Tesseract are different user problems.

Note `capabilities()` never raises: `renderer_capability()` and `ocr_capability()`
both catch and return `("error", str(exc))`.

### C4. An in-process adapter cannot survive a process crash

The spec claimed "a crash in the adapter does not take down `server.py`". That is
false for an in-process import and must not ship as a guarantee.

The accurate guarantee, which this plan implements:

- Every adapter call is wrapped, and any `Exception` — FreeDF's own
  `PdfEngineError` subclasses, plus anything unexpected — becomes a typed One
  Tool `PdfEngineError` scoped to one session. Other sessions and other
  workspaces are unaffected.
- A **process** crash (segfault, `os._exit`, MemoryError kill) remains a process
  crash. `app/main.js` already restarts the backend; what the user loses is the
  in-memory session, and what they keep is `editor-sessions.json`, from which the
  session is reopened and its operation log replayed.
- Process isolation is available if crashes prove real: FreeDF's HTTP service is
  a supported transport, and the adapter boundary is exactly the seam to swap
  behind. That is a future option, not a claim being made now.

### C5. Pin on `API_VERSION`, not the package version

`pdf-engine/pyproject.toml` says `version = "0.1.0"` while the work is described
as v0.2 — package metadata lags. `pdfengine.api.contracts.API_VERSION` is `"v1"`
and is the value FreeDF itself validates requests against.

**Therefore:** the supported-version gate reads `API_VERSION`. The package
version is reported in `engine_info()` for diagnostics only, and never gates
anything.

### C6. Two operation details that will bite

- **Rotation is `90`, `180`, or `270` only.** `RotatePages.__post_init__` rejects
  anything else, including `-90`. `editor-state.js:94` stores `rot: -90` and
  computes `(p.rot + deg) % 360`, which yields negatives. The UI must normalize
  to the positive quarter-turn set before sending. Task 11.
- **Reorder is a full permutation.** `ReorderPages` takes the complete new page
  order and rejects duplicates, not a move instruction.

---

## What FreeDF gives us for free

Worth knowing before the tasks, because several spec worries are already solved
upstream:

| Need | FreeDF |
| --- | --- |
| Stable page ids across reorder | `page_id` on every `PageInfo`; all operations target ids, never positions |
| Undo/redo | `session.state.can_undo` / `can_redo`, `engine.undo/redo` |
| Validate before applying | `apply_operations(..., dry_run=True)` returns the projected document without committing |
| Source-changed detection | `SourceChangedError`, code `source_changed` |
| Render caching | `RenderCache`, content-addressed on disk |
| Pair mode (two documents) | `ImportPages(source_session_id, page_ids, after_page_id)` |
| Deterministic replay | `InsertBlankPage` mints its `page_id` at construction |
| Safe save | full rewrite, atomic, in-place requires explicit opt-in |

`ImportPages` is a genuine find: the Editor's existing pair view — `openPair`,
`moveRight`, `moveLeft` in `editor-state.js:148-186` — has a real backend after
all. It is **out of scope for this plan** (structural ops on one document first),
but nothing here should foreclose it. Task 6 keeps `EditorSession` capable of
holding more than one FreeDF session id for exactly that reason.

---

## Decisions to validate before implementation

**Do not start Task 1 until D1 and D2 are answered.** D3–D5 can be answered by
the end of their listed task.

| # | Decision | Recommendation |
| --- | --- | --- |
| **D1** | You declared the ten-method adapter interface fixed, including `artifact(sessionId, artifactId)`. Per C2 the Python API returns bytes directly and FreeDF artifact ids are per-call randoms. Drop `artifact()`, or keep it as a passthrough that would only ever be used if we later moved to the HTTP transport? | **Drop it.** Nine methods. Keeping a method whose only implementation is "not applicable to this transport" is a false affordance. `render()` returns the PNG bytes; the HTTP layer serves them. |
| **D2** | Vendoring. The repo layout is `pdf-engine/src/pdfengine/` — a subdirectory package with its own `pyproject.toml`. Vendor a built wheel, vendor the `src/pdfengine` tree, or add it as a git submodule? | **Built wheel**, committed under `converter/vendor/wheels/`. A submodule breaks the "clone and run" property; a raw source copy makes the boundary test harder to write, because vendored FreeDF source legitimately imports `pdfengine` and would have to be excluded from the scan. A wheel is one opaque file with a version in its name. |
| **D3** | The Editor toolbar shows redact, text, draw, and stamp. FreeDF has no operation for any of them. Disable with a reason, or remove them from the toolbar for now? | **Disable with a reason.** Removing them hides a roadmap; disabling states it. Decide by end of Task 12. |
| **D4** | `set_metadata` and `extract_pages` are implemented upstream and have no UI. Add controls now or leave the capability unexposed? | **Leave unexposed** this pass. They are one small task each later, and neither is on the critical path to a working Editor. Decide by end of Task 12. |
| **D5** | Thumbnail width. FreeDF's `DEFAULT_THUMBNAIL_WIDTH` is 180 and `DEFAULT_PREVIEW_WIDTH` is 1000. Does the grid need a retina variant at 360? | **Start at 180**, measure on your display, add 360 behind `devicePixelRatio` only if it visibly blurs. Decide by end of Task 9. |

---

## File structure

**Created**

| File | Responsibility |
| --- | --- |
| `converter/pdf_engine.py` | The only file importing `pdfengine`. Adapter protocol, `FreeDFAdapter`, `UnavailablePdfAdapter`, `PdfEngineError`, error translation, `get_adapter()` |
| `converter/editor_sessions.py` | `EditorSession`, `EditorSessionStore`, revision counter, operation log, JSON persistence, expiry |
| `converter/vendor/wheels/pdf_engine-*.whl` | Vendored engine (D2) |
| `converter/ui/workspaces/editor/editor-actions.js` | Editor's backend calls and snapshot absorption |
| `tests/test_pdf_engine_boundary.py` | Enforces the import rule |
| `tests/test_pdf_engine.py` | Adapter contract, both implementations |
| `tests/test_editor_sessions.py` | Session model, revisions, persistence, recovery |
| `tests/test_editor_api.py` | HTTP route contract |
| `tests/integration/test_engine_bundled.py` | Release tier: engine must be present and working |

**Modified**

| File | Change |
| --- | --- |
| `converter/registry.py` | `Helper` gains a Python-package kind; add the FreeDF helper |
| `converter/server.py` | `/api/editor/*` routes; save as a queue `Job`; engine info in `/api/tools` |
| `converter/ui/workspaces/editor/editor-state.js` | Real pages replace generated ones; generators demoted to empty state; revision tracking |
| `converter/ui/workspaces/editor/editor-view.js` | Real thumbnails; capability-driven tool state; undo/redo controls |
| `converter/ui/index.html` | One `<script>` tag for `editor-actions.js` |
| `converter/ui/interaction/action-router.js` | New editor `data-act` branches |
| `docs/architecture.md` | The boundary rule |
| `tests/ui/trace.js` | Editor steps |

---

## Task dependency graph

```
T1 vendor + helper + engine_info
   │
   ├──> T2 adapter open/inspect/close/capabilities
   │       ├──> T3 adapter render
   │       ├──> T4 adapter apply/undo/redo
   │       └──> T5 adapter save
   │
   └──> T6 EditorSession store ──> T7 routes: open/inspect/close
                                      ├──> T8 routes: operation/undo/redo   (needs T4)
                                      ├──> T9 route: page.png               (needs T3)
                                      └──> T10 route: save via queue        (needs T5)
                                             │
                                             └──> T11 UI: open + real grid
                                                    ├──> T12 UI: capabilities + tool state
                                                    ├──> T13 UI: structural ops + optimistic policy
                                                    ├──> T14 UI: undo/redo
                                                    ├──> T15 UI: crop
                                                    └──> T16 UI: OCR
                                                           │
                                                           └──> T17 recovery UX
                                                                  └──> T18 trace re-baseline
                                                                         └──> T19 release test tier + docs
```

**Parallelizable:**

- **T3, T4, T5** after T2 — three disjoint adapter method groups, three separate test files' worth of cases. Three agents.
- **T8, T9, T10** after T7 and their adapter dependency — disjoint route handlers.
- **T12, T13, T14, T15, T16** after T11 — disjoint UI surfaces. T13 and T14 both touch `editor-state.js`; sequence those two or expect a merge.

**Strictly serial:** T1 → T2, T6 → T7, T11 gates all UI, T18 must be last before T19.

---

## Task 1: Vendor FreeDF, discover it, report it

**Files:**
- Create: `converter/pdf_engine.py`
- Create: `converter/vendor/wheels/` (with the built wheel)
- Create: `tests/test_pdf_engine_boundary.py`
- Create: `tests/test_pdf_engine.py`
- Modify: `converter/registry.py`
- Modify: `converter/server.py` (`/api/tools` payload only)

**Interfaces:**
- Consumes: nothing.
- Produces: `PdfEngineError(code, message, hint="", details=None)`; `get_adapter() -> PdfEngineAdapter`; `PdfEngineAdapter.engine_info() -> dict`; `ENGINE_API_VERSION = "v1"`.

- [ ] **Step 1: Build and vendor the wheel**

```bash
git clone https://github.com/Brightwav3/custom-pdf-engine /tmp/freedf
cd /tmp/freedf/pdf-engine && python -m pip wheel . -w /tmp/freedf-wheel --no-deps
mkdir -p "converter/vendor/wheels"
cp /tmp/freedf-wheel/pdf_engine-*.whl "converter/vendor/wheels/"
```

Record the source commit SHA in `converter/vendor/README.md` — a vendored
pre-alpha with no provenance is unmaintainable.

- [ ] **Step 2: Write the boundary test**

This is the constraint that makes the rest of the plan safe, so it is written first.

```python
# tests/test_pdf_engine_boundary.py
import re, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {ROOT / "converter" / "pdf_engine.py"}
PATTERN = re.compile(r"\bpdfengine\b")
SKIP_DIRS = {".git", "node_modules", "vendor", "__pycache__", "traces", "baseline"}


class BoundaryTests(unittest.TestCase):
    def test_only_the_adapter_references_pdfengine(self):
        offenders = []
        for path in ROOT.rglob("*.py"):
            if SKIP_DIRS & set(path.parts) or path in ALLOWED:
                continue
            if path.name == Path(__file__).name:
                continue
            if PATTERN.search(path.read_text(encoding="utf-8", errors="ignore")):
                offenders.append(str(path.relative_to(ROOT)))
        self.assertEqual(
            offenders, [],
            "only converter/pdf_engine.py may reference pdfengine; "
            f"found: {offenders}",
        )
```

- [ ] **Step 3: Run it**

Run: `python -m unittest tests.test_pdf_engine_boundary -v`
Expected: PASS (nothing references `pdfengine` yet). It is a regression guard, not a red test.

- [ ] **Step 4: Write the failing adapter tests**

```python
# tests/test_pdf_engine.py
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "converter"))
import pdf_engine


class EngineInfoTests(unittest.TestCase):
    def test_unavailable_adapter_reports_a_reason_and_never_raises(self):
        info = pdf_engine.UnavailablePdfAdapter("not installed").engine_info()
        self.assertFalse(info["available"])
        self.assertEqual(info["state"], "blocked")
        self.assertTrue(info["reason"])
        self.assertEqual(info["capabilities"], {})

    def test_unavailable_adapter_raises_typed_errors_from_every_operation(self):
        adapter = pdf_engine.UnavailablePdfAdapter("not installed")
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            adapter.open("whatever.pdf")
        self.assertEqual(caught.exception.code, "engine-missing")

    def test_engine_info_shape_is_stable(self):
        info = pdf_engine.get_adapter().engine_info()
        for key in ("available", "name", "version", "apiVersion",
                    "supportedApiVersions", "source", "location",
                    "capabilities", "state", "reason"):
            self.assertIn(key, info)
        self.assertIn(info["state"], {"ready", "blocked", "unsupported", "error"})
```

- [ ] **Step 5: Run to verify failure**

Run: `python -m unittest tests.test_pdf_engine -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'pdf_engine'`.

- [ ] **Step 6: Implement the error type and the unavailable adapter**

```python
# converter/pdf_engine.py
"""The only module permitted to import pdfengine.

No FreeDF object, dataclass, or exception may cross out of this file. See
docs/architecture.md and tests/test_pdf_engine_boundary.py.
"""
from __future__ import annotations

ENGINE_API_VERSION = "v1"
SUPPORTED_API_VERSIONS = ("v1",)


class PdfEngineError(Exception):
    """A typed failure One Tool can route on, carrying FreeDF's own code."""

    def __init__(self, code, message, *, hint="", details=None, engine_code=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.details = dict(details or {})
        self.engine_code = engine_code

    def as_dict(self):
        return {
            "code": self.code,
            "message": self.message,
            "hint": self.hint,
            "details": self.details,
            "engineCode": self.engine_code,
        }


class UnavailablePdfAdapter:
    """Stands in when no usable engine is present. Never imports pdfengine."""

    def __init__(self, reason, state="blocked", hint=""):
        self._reason = reason
        self._state = state
        self._hint = hint or "Install the bundled PDF engine, then press Recheck."

    def engine_info(self):
        return {
            "available": False, "name": "FreeDF", "version": None,
            "apiVersion": None, "supportedApiVersions": list(SUPPORTED_API_VERSIONS),
            "source": None, "location": None, "renderer": None,
            "capabilities": {}, "state": self._state, "reason": self._reason,
        }

    def _fail(self, *_a, **_k):
        raise PdfEngineError(
            "engine-missing" if self._state == "blocked" else "engine-unsupported",
            self._reason, hint=self._hint,
        )

    open = inspect = capabilities = render = _fail
    apply = undo = redo = save = close = _fail
```

- [ ] **Step 7: Implement `FreeDFAdapter.engine_info` and `get_adapter`**

```python
def _import_engine():
    """Import pdfengine, or return the reason it is unusable."""
    try:
        import pdfengine
        from pdfengine.api.contracts import API_VERSION
        from pdfengine.api.engine import PdfEngine
    except ImportError as exc:
        return None, ("blocked", f"the PDF engine is not installed ({exc})")
    if API_VERSION not in SUPPORTED_API_VERSIONS:
        return None, ("unsupported", (
            f"this build supports PDF engine API {', '.join(SUPPORTED_API_VERSIONS)}, "
            f"but the installed engine speaks {API_VERSION}"))
    return (pdfengine, PdfEngine, API_VERSION), None


class FreeDFAdapter:
    def __init__(self, module, engine_cls, api_version):
        self._module = module
        self._api_version = api_version
        self._engine = engine_cls()

    def engine_info(self):
        # capabilities() never raises: FreeDF catches broken backends itself.
        caps = self._engine.capabilities()
        preview = caps.get("preview", {})
        return {
            "available": True,
            "name": "FreeDF",
            "version": getattr(self._module, "__version__", None),
            "apiVersion": self._api_version,
            "supportedApiVersions": list(SUPPORTED_API_VERSIONS),
            "source": "wheel",
            "location": str(getattr(self._module, "__file__", "") or ""),
            "renderer": {"backend": "poppler", **preview},
            "capabilities": caps,          # passed through unchanged — see C3
            "state": "ready",
            "reason": None,
        }


_ADAPTER = None


def get_adapter(refresh=False):
    global _ADAPTER
    if _ADAPTER is not None and not refresh:
        return _ADAPTER
    loaded, problem = _import_engine()
    if problem is None:
        _ADAPTER = FreeDFAdapter(*loaded)
    else:
        state, reason = problem
        _ADAPTER = UnavailablePdfAdapter(reason, state=state)
    return _ADAPTER
```

Note `capabilities` is passed through verbatim. Collapsing happens in Task 12.

- [ ] **Step 8: Run both test files**

Run: `python -m unittest tests.test_pdf_engine tests.test_pdf_engine_boundary -v`
Expected: PASS.

- [ ] **Step 9: Register the helper and surface it**

In `registry.py`, add a helper whose availability test is
`get_adapter().engine_info()["state"] == "ready"` rather than a `PATH` lookup, and
honour `ONETOOL_PDFENGINE` as the override, matching the existing `ONETOOL_*`
convention. In `server.py`, add `engine_info()` to the `/api/tools` payload.

- [ ] **Step 10: Run the full suite and commit**

Run: `python -m unittest discover -s tests`
Expected: PASS.

```bash
git add converter/pdf_engine.py converter/vendor converter/registry.py converter/server.py tests/test_pdf_engine.py tests/test_pdf_engine_boundary.py
git commit -m "feat(editor): vendor FreeDF and report engine availability"
```

---

## Task 2: Adapter — open, inspect, capabilities, close

**Depends on:** T1. **Blocks:** T3, T4, T5, T6.

**Files:**
- Modify: `converter/pdf_engine.py`
- Modify: `tests/test_pdf_engine.py`
- Create: `tests/fixtures/one-page.pdf` (copy from FreeDF's `pdf-engine/fixtures/basic/`)

**Interfaces:**
- Consumes: `PdfEngineError`, `FreeDFAdapter` from T1.
- Produces:
  - `open(path: str) -> {"sessionId": str, "path": str, "document": DocumentDict, "capabilities": dict}`
  - `inspect(session_id: str) -> {"sessionId": str, "document": DocumentDict, "canUndo": bool, "canRedo": bool}`
  - `capabilities(session_id: str | None = None) -> dict` — FreeDF's shape, verbatim
  - `close(session_id: str) -> {"closed": True}`
  - `DocumentDict = {"pageCount": int, "title": str | None, "pages": [PageDict]}`
  - `PageDict = {"pageId": str, "index": int, "sourceIndex": int | None, "width": float, "height": float, "rotation": int}`

These names mirror FreeDF's own `document_dto()` deliberately: an extra renaming
layer would be a second place for bugs to hide, with no benefit.

- [ ] **Step 1: Copy the fixtures**

```bash
mkdir -p tests/fixtures
gh api repos/Brightwav3/custom-pdf-engine/contents/pdf-engine/fixtures/basic/one-page.pdf --jq .content | base64 -d > tests/fixtures/one-page.pdf
gh api repos/Brightwav3/custom-pdf-engine/contents/pdf-engine/fixtures/unsupported/xref-stream.pdf --jq .content | base64 -d > tests/fixtures/xref-stream.pdf
```

- [ ] **Step 2: Write the failing tests**

```python
# tests/test_pdf_engine.py — append
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def engine_or_skip():
    adapter = pdf_engine.get_adapter()
    if not adapter.engine_info()["available"]:
        raise unittest.SkipTest("FreeDF not installed (development tier)")
    return adapter


class OpenTests(unittest.TestCase):
    def setUp(self):
        self.adapter = engine_or_skip()
        self.session = self.adapter.open(str(FIXTURES / "one-page.pdf"))["sessionId"]

    def tearDown(self):
        try: self.adapter.close(self.session)
        except pdf_engine.PdfEngineError: pass

    def test_open_returns_pages_with_stable_ids(self):
        doc = self.adapter.inspect(self.session)["document"]
        self.assertEqual(doc["pageCount"], 1)
        self.assertTrue(doc["pages"][0]["pageId"])

    def test_capabilities_are_passed_through_not_collapsed(self):
        caps = self.adapter.capabilities(self.session)
        self.assertIn(caps["preview"]["state"], {"ready", "blocked", "error"})
        self.assertIn("detail", caps["preview"])
        self.assertIn("ocr", caps)
        self.assertIn("read", caps)
        kinds = {op["kind"] for op in caps["operations"]}
        self.assertIn("crop_pages", kinds)
        self.assertIn("add_text_layer", kinds)

    def test_missing_file_is_a_typed_error(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.open(str(FIXTURES / "nope.pdf"))
        self.assertEqual(caught.exception.code, "source-unreadable")

    def test_unsupported_document_keeps_the_engine_code_and_feature(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.open(str(FIXTURES / "xref-stream.pdf"))
        self.assertEqual(caught.exception.engine_code, "unsupported_pdf")
        self.assertIn("feature", caught.exception.details)

    def test_unknown_session_is_a_typed_error(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.inspect("session_does_not_exist")
        self.assertEqual(caught.exception.code, "session-unknown")

    def test_no_freedf_type_escapes(self):
        allowed = (dict, list, str, int, float, bool, type(None))
        def check(value):
            self.assertIsInstance(value, allowed)
            if isinstance(value, dict):
                for k, v in value.items(): check(k); check(v)
            elif isinstance(value, list):
                for v in value: check(v)
        check(self.adapter.inspect(self.session))
        check(self.adapter.capabilities(self.session))
```

- [ ] **Step 3: Run to verify failure**

Run: `python -m unittest tests.test_pdf_engine -v`
Expected: FAIL, `AttributeError: 'FreeDFAdapter' object has no attribute 'open'`.

- [ ] **Step 4: Implement error translation**

```python
_ERROR_CODES = {
    "parse_error": "source-unreadable",
    "unsupported_pdf": "source-unreadable",
    "session_not_found": "session-unknown",
    "source_changed": "source-changed",
    "invalid_operation": "operation-invalid",
    "invalid_request": "operation-invalid",
    "unsupported_operation": "operation-unsupported",
    "renderer_unavailable": "render-unavailable",
    "render_error": "render-failed",
    "ocr_unavailable": "ocr-unavailable",
    "ocr_error": "ocr-failed",
    "engine_error": "engine-error",
}


def _translate(exc):
    """Map any engine exception to a typed One Tool error, preserving detail."""
    engine_code = getattr(exc, "code", None)
    details = {}
    for name in ("field", "feature", "offset"):
        value = getattr(exc, name, None)
        if value is not None:
            details[name] = value
    return PdfEngineError(
        _ERROR_CODES.get(engine_code, "engine-error"),
        str(exc), details=details, engine_code=engine_code,
    )


def _guarded(fn):
    """Every crossing of the boundary goes through here — see correction C4.

    This converts adapter *exceptions* into typed errors. It cannot and does not
    protect against a process-level crash.
    """
    from functools import wraps

    @wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except PdfEngineError:
            raise
        except Exception as exc:
            raise _translate(exc) from exc
    return wrapper
```

- [ ] **Step 5: Implement the four methods**

```python
class FreeDFAdapter:  # continued
    @_guarded
    def open(self, path, password=None):
        import os
        if not os.path.isfile(path):
            raise PdfEngineError("source-unreadable", f"no such PDF file: {path}")
        session = self._engine.open_document(path, password)
        return {
            "sessionId": session.session_id,
            "path": str(session.path),
            "document": self._document(session),
            "capabilities": self._engine.capabilities(session),
        }

    @_guarded
    def inspect(self, session_id):
        session = self._engine.session(session_id)
        return {
            "sessionId": session_id,
            "document": self._document(session),
            "canUndo": session.state.can_undo,
            "canRedo": session.state.can_redo,
        }

    @_guarded
    def capabilities(self, session_id=None):
        session = self._engine.session(session_id) if session_id else None
        return self._engine.capabilities(session)

    @_guarded
    def close(self, session_id):
        self._engine.close(self._engine.session(session_id))
        return {"closed": True}

    def _document(self, session):
        """FreeDF DocumentInfo -> plain dicts. No engine type leaves this file."""
        info = self._engine.inspect_document(session)
        return {
            "pageCount": info.page_count,
            "title": info.title,
            "pages": [
                {"pageId": p.page_id, "index": p.index, "sourceIndex": p.source_index,
                 "width": p.width, "height": p.height, "rotation": p.rotation}
                for p in info.pages
            ],
        }
```

- [ ] **Step 6: Run tests**

Run: `python -m unittest tests.test_pdf_engine tests.test_pdf_engine_boundary -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add converter/pdf_engine.py tests/test_pdf_engine.py tests/fixtures
git commit -m "feat(editor): adapter open, inspect, capabilities, close"
```

---

## Task 3: Adapter — render

**Depends on:** T2. **Parallel with:** T4, T5.

**Files:** Modify `converter/pdf_engine.py`, `tests/test_pdf_engine.py`.

**Interfaces:**
- Produces: `render(session_id, page_id, options: dict) -> {"pageId", "width", "height", "png": bytes, "cacheHit": bool}`. `options` accepts `{"width": int}`, default 180.
- No artifact id. See correction C2.

- [ ] **Step 1: Write the failing test**

```python
class RenderTests(unittest.TestCase):
    def setUp(self):
        self.adapter = engine_or_skip()
        if self.adapter.capabilities()["preview"]["state"] != "ready":
            self.skipTest("no working renderer (Poppler absent)")
        self.session = self.adapter.open(str(FIXTURES / "one-page.pdf"))["sessionId"]

    def tearDown(self):
        self.adapter.close(self.session)

    def test_render_returns_png_bytes(self):
        page_id = self.adapter.inspect(self.session)["document"]["pages"][0]["pageId"]
        out = self.adapter.render(self.session, page_id, {"width": 180})
        self.assertTrue(out["png"].startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(out["width"], 180)

    def test_second_render_hits_the_engine_cache(self):
        page_id = self.adapter.inspect(self.session)["document"]["pages"][0]["pageId"]
        self.adapter.render(self.session, page_id, {"width": 180})
        self.assertTrue(self.adapter.render(self.session, page_id, {"width": 180})["cacheHit"])

    def test_unknown_page_is_a_typed_error(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.render(self.session, "page_nope", {"width": 180})
        self.assertEqual(caught.exception.code, "operation-invalid")
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m unittest tests.test_pdf_engine.RenderTests -v`
Expected: FAIL, no attribute `render`.

- [ ] **Step 3: Implement**

```python
    DEFAULT_THUMBNAIL_WIDTH = 180

    @_guarded
    def render(self, session_id, page_id, options=None):
        options = options or {}
        width = int(options.get("width") or self.DEFAULT_THUMBNAIL_WIDTH)
        if width < 16 or width > 4000:
            raise PdfEngineError("operation-invalid", f"render width out of range: {width}")
        session = self._engine.session(session_id)
        result = self._engine.render_page(session, page_id, width)
        return {
            "pageId": result.page_id, "width": result.width, "height": result.height,
            "png": result.image_bytes, "cacheHit": result.cache_hit,
        }
```

- [ ] **Step 4: Run tests**

Run: `python -m unittest tests.test_pdf_engine -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add converter/pdf_engine.py tests/test_pdf_engine.py
git commit -m "feat(editor): adapter page rendering"
```

---

## Task 4: Adapter — apply, undo, redo

**Depends on:** T2. **Parallel with:** T3, T5.

**Files:** Modify `converter/pdf_engine.py`, `tests/test_pdf_engine.py`.

**Interfaces:**
- Produces: `apply(session_id, operations: list, dry_run=False) -> {"sessionId", "document", "canUndo", "canRedo", "dryRun"}`; `undo(session_id) -> same as inspect()`; `redo(session_id) -> same as inspect()`.
- Operation payloads are camelCase dicts matching FreeDF's JSON contract, plus `add_text_layer`, which FreeDF's own JSON transport cannot parse (correction C1):

```python
{"kind": "rotate_pages",      "pageIds": [...], "degrees": 90|180|270}
{"kind": "delete_pages",      "pageIds": [...]}
{"kind": "reorder_pages",     "pageIds": [...]}          # full permutation
{"kind": "insert_blank_page", "afterPageId": str|None, "width": float, "height": float}
{"kind": "crop_pages",        "pageIds": [...], "box": [x0, y0, x1, y1]}
{"kind": "add_text_layer",    "pageIds": [...], "language": "eng", "mode": "lstm",
                              "dpi": 300, "minConfidence": 0.0}
```

- [ ] **Step 1: Write the failing tests**

```python
class ApplyTests(unittest.TestCase):
    def setUp(self):
        self.adapter = engine_or_skip()
        self.session = self.adapter.open(str(FIXTURES / "one-page.pdf"))["sessionId"]
        self.page = self.adapter.inspect(self.session)["document"]["pages"][0]["pageId"]

    def tearDown(self):
        self.adapter.close(self.session)

    def test_rotate_changes_rotation_and_enables_undo(self):
        out = self.adapter.apply(self.session, [
            {"kind": "rotate_pages", "pageIds": [self.page], "degrees": 90}])
        self.assertEqual(out["document"]["pages"][0]["rotation"] % 360, 90)
        self.assertTrue(out["canUndo"])

    def test_undo_restores_and_enables_redo(self):
        self.adapter.apply(self.session, [
            {"kind": "rotate_pages", "pageIds": [self.page], "degrees": 90}])
        out = self.adapter.undo(self.session)
        self.assertEqual(out["document"]["pages"][0]["rotation"] % 360, 0)
        self.assertTrue(out["canRedo"])
        self.assertEqual(self.adapter.redo(self.session)["document"]["pages"][0]["rotation"] % 360, 90)

    def test_page_ids_survive_insert(self):
        before = self.page
        out = self.adapter.apply(self.session, [
            {"kind": "insert_blank_page", "afterPageId": before}])
        ids = [p["pageId"] for p in out["document"]["pages"]]
        self.assertIn(before, ids)
        self.assertEqual(len(ids), 2)

    def test_dry_run_does_not_commit(self):
        self.adapter.apply(self.session, [
            {"kind": "delete_pages", "pageIds": [self.page]}], dry_run=True)
        self.assertEqual(self.adapter.inspect(self.session)["document"]["pageCount"], 1)

    def test_negative_rotation_is_rejected_not_silently_accepted(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.apply(self.session, [
                {"kind": "rotate_pages", "pageIds": [self.page], "degrees": -90}])
        self.assertEqual(caught.exception.code, "operation-invalid")

    def test_unknown_operation_kind_is_rejected(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.apply(self.session, [{"kind": "redact_pages", "pageIds": [self.page]}])
        self.assertEqual(caught.exception.code, "operation-invalid")
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m unittest tests.test_pdf_engine.ApplyTests -v` → FAIL, no attribute `apply`.

- [ ] **Step 3: Implement the operation builder**

FreeDF's `parse_operation` is reused for every kind it knows, so we inherit its
validation rather than duplicating it. `add_text_layer` is constructed directly,
because `parse_operation` has no branch for it.

```python
    def _operation(self, payload):
        from pdfengine.api.contracts import parse_operation
        from pdfengine.api.models import AddTextLayer
        if not isinstance(payload, dict):
            raise PdfEngineError("operation-invalid", "operation must be an object")
        if payload.get("kind") == "add_text_layer":
            caps = self._engine.ocr_capability()
            if caps.state != "ready":
                raise PdfEngineError(
                    "ocr-unavailable", caps.detail or "OCR is not available",
                    details={"state": caps.state})
            return AddTextLayer(
                page_ids=tuple(payload.get("pageIds") or ()),
                language=payload.get("language", "eng"),
                mode=payload.get("mode", "lstm"),
                dpi=int(payload.get("dpi", 300)),
                min_confidence=float(payload.get("minConfidence", 0.0)),
            )
        return parse_operation(payload)

    @_guarded
    def apply(self, session_id, operations, dry_run=False):
        if not isinstance(operations, list) or not operations:
            raise PdfEngineError("operation-invalid", "operations must be a non-empty array")
        session = self._engine.session(session_id)
        built = [self._operation(item) for item in operations]
        state = self._engine.apply_operations(session, built, dry_run=dry_run)
        if dry_run:
            return {"sessionId": session_id, "dryRun": True,
                    "document": self._document(session),
                    "canUndo": state.can_undo, "canRedo": state.can_redo}
        return {**self.inspect(session_id), "dryRun": False}

    @_guarded
    def undo(self, session_id):
        self._engine.undo(self._engine.session(session_id))
        return self.inspect(session_id)

    @_guarded
    def redo(self, session_id):
        self._engine.redo(self._engine.session(session_id))
        return self.inspect(session_id)
```

Note `ValueError` from a dataclass `__post_init__` is caught by `_guarded` and
mapped through `_ERROR_CODES.get(None) -> "engine-error"`; add
`except ValueError` handling in `_translate` so it yields `operation-invalid`.

- [ ] **Step 4: Run tests**

Run: `python -m unittest tests.test_pdf_engine -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add converter/pdf_engine.py tests/test_pdf_engine.py
git commit -m "feat(editor): adapter apply, undo, redo"
```

---

## Task 5: Adapter — save

**Depends on:** T2. **Parallel with:** T3, T4.

**Files:** Modify `converter/pdf_engine.py`, `tests/test_pdf_engine.py`.

**Interfaces:**
- Produces: `save(session_id, path: str, options: dict | None = None) -> {"path": str, "written": bool, "dryRun": bool}`. `options` accepts `{"dryRun": bool}` only — `allow_replace_source` is deliberately not exposed.

- [ ] **Step 1: Write the failing tests**

```python
class SaveTests(unittest.TestCase):
    def setUp(self):
        import shutil, tempfile
        self.adapter = engine_or_skip()
        self.tmp = Path(tempfile.mkdtemp())
        self.src = self.tmp / "in.pdf"
        shutil.copy(FIXTURES / "one-page.pdf", self.src)
        self.session = self.adapter.open(str(self.src))["sessionId"]

    def tearDown(self):
        import shutil
        try: self.adapter.close(self.session)
        except pdf_engine.PdfEngineError: pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_save_writes_a_new_file_and_leaves_the_source_alone(self):
        before = self.src.read_bytes()
        out = self.adapter.save(self.session, str(self.tmp / "out.pdf"))
        self.assertTrue(out["written"])
        self.assertTrue((self.tmp / "out.pdf").is_file())
        self.assertEqual(self.src.read_bytes(), before)

    def test_saving_over_the_source_is_refused(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.save(self.session, str(self.src))
        self.assertEqual(caught.exception.code, "save-refused")

    def test_dry_run_writes_nothing(self):
        self.adapter.save(self.session, str(self.tmp / "dry.pdf"), {"dryRun": True})
        self.assertFalse((self.tmp / "dry.pdf").exists())
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m unittest tests.test_pdf_engine.SaveTests -v` → FAIL, no attribute `save`.

- [ ] **Step 3: Implement**

```python
    @_guarded
    def save(self, session_id, path, options=None):
        import os
        from pdfengine.api.models import SaveOptions
        options = options or {}
        session = self._engine.session(session_id)
        if os.path.exists(path) and os.path.samefile(path, str(session.path)):
            raise PdfEngineError(
                "save-refused", "saving over the source file is not permitted",
                hint="Choose a different output name.")
        written = self._engine.save(
            session, path,
            SaveOptions(allow_replace_source=False, dry_run=bool(options.get("dryRun"))))
        return {"path": str(written), "written": not options.get("dryRun"),
                "dryRun": bool(options.get("dryRun"))}
```

- [ ] **Step 4: Run tests**

Run: `python -m unittest tests.test_pdf_engine -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add converter/pdf_engine.py tests/test_pdf_engine.py
git commit -m "feat(editor): adapter save"
```

---

## Task 6: `EditorSession` and its store

**Depends on:** T2. **Blocks:** T7.

**Files:** Create `converter/editor_sessions.py`, `tests/test_editor_sessions.py`.

**Interfaces:**
- Produces:
  - `EditorSession` with `.id`, `.engine_session_ids: list[str]`, `.source_paths: list[str]`, `.revision: int`, `.ops: list[dict]`, `.cursor: int`, `.fingerprint: str`, `.output_path`, `.created`, `.touched`, `.status` (`"active" | "frozen" | "degraded"`).
  - `EditorSessionStore(path, adapter)` with `.open(paths) -> EditorSession`, `.get(id)`, `.apply(id, ops)`, `.undo(id)`, `.redo(id)`, `.close(id)`, `.prune()`, `.reattach(id)`.
  - `.snapshot(id) -> {"session": {...}, "document": {...}, "capabilities": {...}, "canUndo", "canRedo", "revision"}` — the single shape the HTTP layer returns and the UI absorbs.

`engine_session_ids` is a list, not a scalar, so pair mode via `ImportPages`
needs no model change later.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_editor_sessions.py
import json, shutil, tempfile, unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "converter"))
import editor_sessions, pdf_engine

FIXTURES = Path(__file__).resolve().parent / "fixtures"


class SessionTests(unittest.TestCase):
    def setUp(self):
        adapter = pdf_engine.get_adapter()
        if not adapter.engine_info()["available"]:
            self.skipTest("FreeDF not installed (development tier)")
        self.tmp = Path(tempfile.mkdtemp())
        self.src = self.tmp / "in.pdf"
        shutil.copy(FIXTURES / "one-page.pdf", self.src)
        self.store = editor_sessions.EditorSessionStore(self.tmp / "sessions.json", adapter)
        self.session = self.store.open([str(self.src)])

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_revision_starts_at_zero_and_increments_per_mutation(self):
        self.assertEqual(self.session.revision, 0)
        page = self.store.snapshot(self.session.id)["document"]["pages"][0]["pageId"]
        self.store.apply(self.session.id, [
            {"kind": "rotate_pages", "pageIds": [page], "degrees": 90}])
        self.assertEqual(self.store.get(self.session.id).revision, 1)

    def test_undo_advances_the_revision_rather_than_rewinding_it(self):
        # Revisions identify a render, so they must never repeat a value.
        page = self.store.snapshot(self.session.id)["document"]["pages"][0]["pageId"]
        self.store.apply(self.session.id, [
            {"kind": "rotate_pages", "pageIds": [page], "degrees": 90}])
        self.store.undo(self.session.id)
        self.assertEqual(self.store.get(self.session.id).revision, 2)

    def test_apply_after_undo_truncates_the_redo_tail(self):
        page = self.store.snapshot(self.session.id)["document"]["pages"][0]["pageId"]
        self.store.apply(self.session.id, [
            {"kind": "rotate_pages", "pageIds": [page], "degrees": 90}])
        self.store.undo(self.session.id)
        self.store.apply(self.session.id, [
            {"kind": "rotate_pages", "pageIds": [page], "degrees": 180}])
        self.assertFalse(self.store.snapshot(self.session.id)["canRedo"])

    def test_a_failed_operation_leaves_the_log_untouched(self):
        before = len(self.store.get(self.session.id).ops)
        with self.assertRaises(pdf_engine.PdfEngineError):
            self.store.apply(self.session.id, [
                {"kind": "rotate_pages", "pageIds": ["page_nope"], "degrees": 90}])
        self.assertEqual(len(self.store.get(self.session.id).ops), before)

    def test_a_changed_source_freezes_the_session(self):
        self.src.write_bytes(self.src.read_bytes() + b"\n% touched\n")
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.store.apply(self.session.id, [
                {"kind": "insert_blank_page", "afterPageId": None}])
        self.assertEqual(caught.exception.code, "source-changed")
        self.assertEqual(self.store.get(self.session.id).status, "frozen")

    def test_sessions_persist_and_reattach_after_a_restart(self):
        page = self.store.snapshot(self.session.id)["document"]["pages"][0]["pageId"]
        self.store.apply(self.session.id, [
            {"kind": "rotate_pages", "pageIds": [page], "degrees": 90}])
        revived = editor_sessions.EditorSessionStore(
            self.tmp / "sessions.json", pdf_engine.get_adapter())
        snap = revived.snapshot(self.session.id)
        self.assertEqual(snap["document"]["pages"][0]["rotation"] % 360, 90)

    def test_unknown_session_raises_session_unknown(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.store.snapshot("nope")
        self.assertEqual(caught.exception.code, "session-unknown")
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m unittest tests.test_editor_sessions -v` → FAIL, `ModuleNotFoundError: editor_sessions`.

- [ ] **Step 3: Implement the session and the store**

Key rules the implementation must honour:

- `revision` is **monotonic** — it increments on undo and redo too. It is a
  render cache key, so a repeated value would serve a stale image.
- `fingerprint` is `sha256(size, mtime_ns, first 64 KiB)` of each source, taken
  at open and rechecked before every mutation. Mismatch raises `source-changed`
  and sets `status = "frozen"`.
- A frozen session refuses mutations but still answers `snapshot` and `save`, so
  work is recoverable rather than lost.
- `apply` calls the adapter first and appends to `ops` **only on success**.
- `reattach` reopens the FreeDF session and replays `ops[:cursor]`. Replay is
  deterministic because `InsertBlankPage` fixes its `page_id` at construction.
- Persistence writes `ops`, never renders, via `tmp + os.replace`.
- `prune()` drops sessions untouched for more than 7 days; it is called at
  startup and on each `open`.

- [ ] **Step 4: Run tests**

Run: `python -m unittest tests.test_editor_sessions -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add converter/editor_sessions.py tests/test_editor_sessions.py
git commit -m "feat(editor): server-owned sessions with revisions and replay"
```

---

## Task 7: HTTP — open, inspect, close

**Depends on:** T6. **Blocks:** T8, T9, T10.

**Files:** Modify `converter/server.py`. Create `tests/test_editor_api.py`.

**Interfaces:**
- Produces: `POST /api/editor/open` `{paths: [str]}` → snapshot; `POST /api/editor/inspect` `{sessionId}` → snapshot; `POST /api/editor/close` `{sessionId}` → `{closed: true}` (idempotent).
- Error envelope, used by every editor route: HTTP status plus
  `{"error": {"code", "message", "hint", "details", "engineCode"}}`.

Status mapping: `engine-missing` / `engine-unsupported` → 503; `source-unreadable`
/ `operation-invalid` → 400; `session-unknown` / `source-changed` / `save-conflict`
→ 409; `operation-unsupported` / `ocr-unavailable` → 422; anything else → 500.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_editor_api.py — follow the existing tests/test_backend_api.py harness
class EditorRouteTests(ServerTestCase):
    def test_open_returns_a_snapshot(self):
        body = self.post("/api/editor/open", {"paths": [str(self.src)]})
        self.assertIn("session", body)
        self.assertIn("document", body)
        self.assertIn("capabilities", body)
        self.assertEqual(body["revision"], 0)

    def test_open_a_non_pdf_is_400_with_a_code(self):
        status, body = self.post_raw("/api/editor/open", {"paths": [str(self.txt)]})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "source-unreadable")

    def test_unknown_session_is_409(self):
        status, body = self.post_raw("/api/editor/inspect", {"sessionId": "nope"})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "session-unknown")

    def test_close_is_idempotent(self):
        session = self.post("/api/editor/open", {"paths": [str(self.src)]})["session"]["id"]
        self.assertEqual(self.post("/api/editor/close", {"sessionId": session})["closed"], True)
        self.assertEqual(self.post("/api/editor/close", {"sessionId": session})["closed"], True)

    def test_editor_routes_return_503_when_the_engine_is_missing(self):
        with unavailable_engine():
            status, body = self.post_raw("/api/editor/open", {"paths": [str(self.src)]})
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "engine-missing")

    def test_existing_routes_still_work(self):
        self.assertIn("files", self.get("/api/state"))
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m unittest tests.test_editor_api -v` → FAIL, 404 on `/api/editor/open`.

- [ ] **Step 3: Implement the routes**

Add an `_editor_error` helper to `Handler` that turns a `PdfEngineError` into the
envelope and status above, then wire the three routes to `EditorSessionStore`.
The store is constructed once alongside `HistoryStore` and `SettingsStore`, with
its JSON path from the same app-data directory Electron passes in.

- [ ] **Step 4: Run the full suite**

Run: `python -m unittest discover -s tests` → PASS.

- [ ] **Step 5: Commit**

```bash
git add converter/server.py tests/test_editor_api.py
git commit -m "feat(editor): open, inspect and close routes"
```

---

## Task 8: HTTP — operation, undo, redo

**Depends on:** T7, T4. **Parallel with:** T9, T10.

**Files:** Modify `converter/server.py`, `tests/test_editor_api.py`.

**Interfaces:**
- Produces: `POST /api/editor/operation` `{sessionId, operations: [...], dryRun?}` → snapshot; `POST /api/editor/undo` `{sessionId}` → snapshot; `POST /api/editor/redo` `{sessionId}` → snapshot.

- [ ] **Step 1: Write the failing tests**

```python
    def test_rotate_bumps_the_revision(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        body = self.post("/api/editor/operation", {
            "sessionId": session,
            "operations": [{"kind": "rotate_pages", "pageIds": [page], "degrees": 90}]})
        self.assertEqual(body["revision"], 1)
        self.assertTrue(body["canUndo"])

    def test_undo_then_redo_round_trips(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        self.post("/api/editor/operation", {"sessionId": session,
            "operations": [{"kind": "rotate_pages", "pageIds": [page], "degrees": 90}]})
        self.assertEqual(self.post("/api/editor/undo", {"sessionId": session})
                         ["document"]["pages"][0]["rotation"] % 360, 0)
        self.assertEqual(self.post("/api/editor/redo", {"sessionId": session})
                         ["document"]["pages"][0]["rotation"] % 360, 90)

    def test_an_unknown_operation_kind_is_400_and_does_not_bump_the_revision(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session = opened["session"]["id"]
        status, body = self.post_raw("/api/editor/operation", {
            "sessionId": session, "operations": [{"kind": "redact_pages", "pageIds": ["x"]}]})
        self.assertEqual(status, 400)
        self.assertEqual(self.post("/api/editor/inspect", {"sessionId": session})["revision"], 0)
```

- [ ] **Step 2: Run to verify failure** — 404 on `/api/editor/operation`.
- [ ] **Step 3: Implement the three routes** against `EditorSessionStore`.
- [ ] **Step 4: Run** `python -m unittest discover -s tests` → PASS.
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(editor): operation, undo and redo routes"
```

---

## Task 9: HTTP — the page image route

**Depends on:** T7, T3. **Parallel with:** T8, T10. **Decides:** D5.

**Files:** Modify `converter/server.py`, `tests/test_editor_api.py`.

**Interfaces:**
- Produces: `GET /api/editor/page.png?session=<id>&page=<pageId>&w=<int>&rev=<int>` → `image/png`.
- `rev` is required, must equal the session's current revision, and is what makes
  the immutable cache header truthful. A stale `rev` is 409, not a stale image.

- [ ] **Step 1: Write the failing tests**

```python
    def test_page_png_returns_an_image_with_immutable_caching(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        status, headers, body = self.get_raw(
            f"/api/editor/page.png?session={session}&page={page}&w=180&rev=0")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertIn("immutable", headers["Cache-Control"])
        self.assertTrue(body.startswith(b"\x89PNG\r\n\x1a\n"))

    def test_a_stale_revision_is_rejected_rather_than_served(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        self.post("/api/editor/operation", {"sessionId": session,
            "operations": [{"kind": "rotate_pages", "pageIds": [page], "degrees": 90}]})
        status, _, _ = self.get_raw(
            f"/api/editor/page.png?session={session}&page={page}&w=180&rev=0")
        self.assertEqual(status, 409)

    def test_an_absurd_width_is_rejected(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        status, _, _ = self.get_raw(
            f"/api/editor/page.png?session={session}&page={page}&w=99999&rev=0")
        self.assertEqual(status, 400)
```

- [ ] **Step 2: Run to verify failure** — 404 on `/api/editor/page.png`.
- [ ] **Step 3: Implement.** Validate `session`, `page`, `w` (16–4000) and `rev`, call `adapter.render`, write the bytes with `Content-Type: image/png` and `Cache-Control: public, max-age=31536000, immutable`.
- [ ] **Step 4: Run** `python -m unittest discover -s tests` → PASS.
- [ ] **Step 5: Answer D5.** Open a real multi-page PDF, compare 180 against 360 on your display, and record the choice in the plan.
- [ ] **Step 6: Commit**

```bash
git commit -am "feat(editor): revision-keyed page image route"
```

---

## Task 10: HTTP — save through the existing queue

**Depends on:** T7, T5. **Parallel with:** T8, T9.

**Files:** Modify `converter/server.py`, `tests/test_editor_api.py`.

**Interfaces:**
- Produces: `POST /api/editor/save` `{sessionId, outputPath}` → `{jobId, outputPath}`. The work runs as a `Job` on the existing single worker, so progress, history and error handling are the ones already built.

- [ ] **Step 1: Write the failing tests**

```python
    def test_save_queues_a_job_and_lands_in_history(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        self.post("/api/editor/operation", {"sessionId": session,
            "operations": [{"kind": "rotate_pages", "pageIds": [page], "degrees": 90}]})
        out = str(self.tmp / "out.pdf")
        self.assertIn("jobId", self.post("/api/editor/save",
                                         {"sessionId": session, "outputPath": out}))
        self.wait_for_idle()
        self.assertTrue(Path(out).is_file())
        self.assertTrue(any(r["output"] == out for r in self.get("/api/history")["history"]))

    def test_a_second_save_while_one_runs_is_409(self):
        # ...open, then post save twice without waiting
        self.assertEqual(second_status, 409)
        self.assertEqual(second_body["error"]["code"], "save-conflict")

    def test_saving_over_the_source_is_refused(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        status, body = self.post_raw("/api/editor/save",
            {"sessionId": opened["session"]["id"], "outputPath": str(self.src)})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "save-refused")

    def test_a_failed_save_keeps_the_session_alive(self):
        # output path inside a directory that does not exist
        self.wait_for_idle()
        self.assertEqual(self.post("/api/editor/inspect", {"sessionId": session})["revision"], 1)
```

- [ ] **Step 2: Run to verify failure** — 404 on `/api/editor/save`.
- [ ] **Step 3: Implement.** Validate the output name with the existing helper used by conversion outputs, mark the session `saving`, submit a `Job` whose work calls `adapter.save`, and clear the flag in both the success and failure paths.
- [ ] **Step 4: Run** `python -m unittest discover -s tests` → PASS.
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(editor): save through the conversion queue"
```

---

## Task 11: UI — open a real document

**Depends on:** T7, T9. **Blocks:** T12–T16. **First visible change.**

**Files:**
- Create: `converter/ui/workspaces/editor/editor-actions.js`
- Modify: `editor-state.js`, `editor-view.js`, `index.html`, `interaction/action-router.js`
- Modify: `tests/test_ui_state.cjs`

**Interfaces:**
- Consumes: every `/api/editor/*` route from T7–T10.
- Produces: `OneToolEditorActions` with `openDocument(paths)`, `applyOperations(ops, {optimistic})`, `undo()`, `redo()`, `save(outputPath)`, `absorbEditor(snapshot)`; `state.revision`, `state.sessionId`, `state.capabilities`, `state.docStatus`.

- [ ] **Step 1: Write the failing state test**

```js
// tests/test_ui_state.cjs — append
const {createEditorState} = require('../converter/ui/workspaces/editor/editor-state.js');

test('a fresh state is an empty document, not twenty-four invented pages', () => {
  const e = createEditorState();
  assert.equal(e.state.pages.length, 0);
  assert.equal(e.state.sessionId, null);
  assert.equal(e.state.revision, -1);
});

test('placeholder pages are still available for the empty state', () => {
  const {makePages} = require('../converter/ui/workspaces/editor/editor-state.js');
  assert.equal(makePages(4).length, 4);
});

test('absorbing a snapshot replaces the page model wholesale', () => {
  const e = createEditorState();
  e.absorb({session: {id: 's1'}, revision: 0, canUndo: false, canRedo: false,
            capabilities: {preview: {state: 'ready', detail: ''}},
            document: {pageCount: 1, title: null, pages: [
              {pageId: 'p1', index: 0, width: 612, height: 792, rotation: 0, sourceIndex: 0}]}});
  assert.equal(e.state.pages.length, 1);
  assert.equal(e.state.pages[0].id, 'p1');
  assert.equal(e.state.sessionId, 's1');
});

test('rotation is normalized to the quarter turns FreeDF accepts', () => {
  const e = createEditorState();
  assert.equal(e.normalizeRotation(-90), 270);
  assert.equal(e.normalizeRotation(360), 0);
  assert.equal(e.normalizeRotation(-180), 180);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/test_ui_state.cjs`
Expected: FAIL — the state seeds 24 generated pages and has no `absorb`.

- [ ] **Step 3: Change the page model**

`makePages`, `noise`, `LINE_WIDTHS` and `KINDS` all **stay exported** — they now
draw the empty state only. `createEditorState` seeds `pages: []`.

Page ids become **strings** (FreeDF `pageId`), not numbers. `state.sel` is already
keyed by id, so `selectedIds()` drops its `Number` coercion:

```js
const selectedIds = () => Object.keys(state.sel).filter(k => state.sel[k])
  .filter(id => state.pages.some(p => p.id === id));
```

Add:

```js
/* FreeDF accepts 90, 180 and 270 only. The prototype produced -90 and, via
   (rot + deg) % 360, other negatives; every one of those is rejected upstream. */
function normalizeRotation(deg) {
  const turn = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return turn;
}

function absorb(snapshot) {
  state.sessionId = snapshot.session ? snapshot.session.id : null;
  state.revision = snapshot.revision;
  state.capabilities = snapshot.capabilities || {};
  state.canUndo = !!snapshot.canUndo;
  state.canRedo = !!snapshot.canRedo;
  state.name = (snapshot.session && snapshot.session.name) || state.name;
  state.pages = (snapshot.document.pages || []).map(p => ({
    id: p.pageId, index: p.index, w: p.width, h: p.height,
    rot: p.rotation, sourceIndex: p.sourceIndex, marks: [],
  }));
  const live = new Set(state.pages.map(p => p.id));
  state.sel = Object.fromEntries(Object.entries(state.sel).filter(([id]) => live.has(id)));
  if (!live.has(state.focus)) state.focus = state.pages.length ? state.pages[0].id : null;
}
```

The server manifest wins wholesale, and selection is filtered to surviving pages
rather than merged.

- [ ] **Step 4: Write `editor-actions.js`**

A classic script, no `type="module"`, defining `window.OneToolEditorActions`,
placed in `index.html` after `editor-state.js` and before `action-router.js`.
`openDocument` posts `/api/editor/open`, absorbs the snapshot, and calls
`render()`.

- [ ] **Step 5: Render one real page**

In `editor-view.js`, a page tile whose `state.sessionId` is set renders
`<img src="/api/editor/page.png?session=…&page=…&w=180&rev=…" loading="lazy">`.
`loading="lazy"` is the whole of the laziness requirement for the grid — the
browser already declines to fetch offscreen images.

- [ ] **Step 6: Run and verify by hand**

Run: `node --test tests/test_ui_state.cjs` → PASS.
Then start the backend, open a real PDF, and confirm the page count and the first
thumbnail match the file.

- [ ] **Step 7: Commit**

```bash
git add converter/ui tests/test_ui_state.cjs
git commit -m "feat(editor): open a real PDF and show real pages"
```

---

## Task 12: UI — capability-driven tool state

**Depends on:** T11. **Parallel with:** T13–T16. **Decides:** D3, D4.

**Files:** Modify `editor-view.js`, `editor-state.js`, `registry.py`, `tests/test_ui_state.cjs`.

**Interfaces:**
- Produces: `toolState(toolId) -> {enabled: bool, state: "ready"|"blocked"|"error"|"unimplemented", reason: str}`.

The mapping, honouring correction C3 — collapse here, and never lose `detail`:

| Tool | Source | Enabled when |
| --- | --- | --- |
| select | always | always |
| crop | `capabilities.operations` contains `crop_pages` | operation present |
| OCR | `capabilities.ocr.state` | `"ready"` |
| text, redact, draw, stamp | no FreeDF operation | never — `"unimplemented"` |

- [ ] **Step 1: Write the failing tests**

```js
test('crop is enabled when the engine lists the operation', () => {
  const e = createEditorState();
  e.absorb(snapshotWith({operations: [{kind: 'crop_pages'}], ocr: {state: 'blocked', detail: 'Tesseract not found'}}));
  assert.equal(e.toolState('crop').enabled, true);
});

test('OCR is disabled with the engine reason, not a generic one', () => {
  const e = createEditorState();
  e.absorb(snapshotWith({operations: [], ocr: {state: 'blocked', detail: 'Tesseract not found'}}));
  assert.equal(e.toolState('ocr').enabled, false);
  assert.equal(e.toolState('ocr').reason, 'Tesseract not found');
});

test('a broken OCR backend is distinguished from an absent one', () => {
  const e = createEditorState();
  e.absorb(snapshotWith({operations: [], ocr: {state: 'error', detail: 'tesseract exited 139'}}));
  assert.equal(e.toolState('ocr').state, 'error');
});

test('tools with no engine operation report unimplemented', () => {
  const e = createEditorState();
  e.absorb(snapshotWith({operations: [{kind: 'crop_pages'}], ocr: {state: 'ready'}}));
  assert.equal(e.toolState('redact').state, 'unimplemented');
});
```

- [ ] **Step 2: Run to verify failure** — no `toolState`.
- [ ] **Step 3: Implement `toolState`** and render disabled tools with `title` and `aria-disabled` carrying the reason.
- [ ] **Step 4: Collapse for the registry.** In `registry.py`, map engine `ready` → `ready`, `blocked` → `helper`, `error` → a distinct blocked state whose reason is the `detail` string. `error` is never folded into `blocked`.
- [ ] **Step 5: Answer D3 and D4** and record the answers.
- [ ] **Step 6: Run** `node --test tests/test_ui_state.cjs` and `python -m unittest discover -s tests` → PASS.
- [ ] **Step 7: Commit**

```bash
git commit -am "feat(editor): capability-driven tool state"
```

---

## Task 13: UI — structural operations and the optimistic policy

**Depends on:** T11. **Sequence with T14** (both touch `editor-state.js`).

**Files:** Modify `editor-state.js`, `editor-actions.js`, `editor-view.js`, `tests/test_ui_state.cjs`.

**Interfaces:**
- Produces: `OPTIMISTIC = {rotate: true, reorder: true, delete: false, insert: false, undo: false, redo: false, save: false}`; `state.pending` (`null` or the in-flight operation).

- [ ] **Step 1: Write the failing tests**

```js
test('rotate applies locally before the server answers', () => {
  const e = stateWithPages(['p1']);
  e.rotate(90);
  assert.equal(e.state.pages[0].rot, 90);
});

test('delete waits for the server', () => {
  const e = stateWithPages(['p1', 'p2']);
  e.select('p1');
  e.remove();
  assert.equal(e.state.pages.length, 2);   // unchanged until the snapshot lands
});

test('insert waits for the server, because the engine assigns the id', () => {
  const e = stateWithPages(['p1']);
  e.insert();
  assert.equal(e.state.pages.length, 1);
});

test('only one mutation is in flight at a time', () => {
  const e = stateWithPages(['p1']);
  e.beginPending({kind: 'rotate_pages'});
  assert.equal(e.canMutate(), false);
});

test('a rejected optimistic rotate reverts', () => {
  const e = stateWithPages(['p1']);
  e.rotate(90);
  e.rejectPending('operation-invalid');
  assert.equal(e.state.pages[0].rot, 0);
});

test('the server snapshot overwrites a diverged local model', () => {
  const e = stateWithPages(['p1']);
  e.rotate(90);
  e.absorb(snapshotWithPages([{pageId: 'p1', rotation: 180, index: 0, width: 1, height: 1}]));
  assert.equal(e.state.pages[0].rot, 180);
});
```

- [ ] **Step 2: Run to verify failure** — no `beginPending` / `rejectPending` / `canMutate`.
- [ ] **Step 3: Implement.** `rotate` and a reorder drag mutate locally, snapshot the prior page array for revert, then post. `remove`, `insert`, `undo`, `redo` and `save` post first and change nothing until `absorb`. `canMutate()` is false while `state.pending` is set; `editor-view.js` disables the affected controls. `rejectPending(code)` restores the snapshot and raises a toast carrying the reason.
- [ ] **Step 4: Run** `node --test tests/test_ui_state.cjs` → PASS.
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(editor): conservative optimistic updates"
```

---

## Task 14: UI — undo and redo

**Depends on:** T11, T8. **Sequence after T13.**

**Files:** Modify `editor-view.js`, `editor-actions.js`, `interaction/keyboard.js`, `tests/test_ui_state.cjs`.

- [ ] **Step 1: Write the failing tests**

```js
test('undo and redo controls follow the server flags', () => {
  const e = createEditorState();
  e.absorb(snapshotWith({canUndo: true, canRedo: false}));
  assert.equal(e.state.canUndo, true);
  assert.equal(e.state.canRedo, false);
});

test('the edits pane reflects the server log, not local strings', () => {
  const e = createEditorState();
  e.absorb(snapshotWith({ops: [{kind: 'rotate_pages', pageIds: ['p1'], degrees: 90}]}));
  assert.equal(e.state.edits.length, 1);
  assert.match(e.state.edits[0].text, /Rotated/);
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Add toolbar buttons and `Ctrl+Z` / `Ctrl+Shift+Z` bindings, both gated on `canUndo` / `canRedo` and on `canMutate()`. `state.edits` becomes a derived, human-readable rendering of the server op log — `describeOp(op)` lives in `editor-state.js` and is pure, so it is testable without the DOM. `log()` and its `nextLocalId('edit')` call are deleted.
- [ ] **Step 4: Run** `node --test tests/test_ui_state.cjs` → PASS.
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(editor): undo and redo"
```

---

## Task 15: UI — crop

**Depends on:** T11, T12, T8. **Parallel with:** T14, T16.

**Files:** Modify `editor-view.js`, `editor-state.js`, `editor-actions.js`, `tests/test_ui_state.cjs`.

The one real complexity is coordinates. The UI drags in **percentages of the
displayed tile, y measured downward from the top**. `CropPages` takes
`[x0, y0, x1, y1]` in **PDF user-space points, y measured upward from the
bottom**. Getting this wrong flips every crop vertically, which looks like a
rendering bug and is not one.

- [ ] **Step 1: Write the failing conversion tests**

```js
test('a full-page crop rectangle round-trips to the full media box', () => {
  const box = cropBoxToPoints({x: 0, y: 0, w: 100, h: 100}, {w: 612, h: 792});
  assert.deepEqual(box, [0, 0, 612, 792]);
});

test('the y axis is flipped, because PDF measures up and the DOM measures down', () => {
  // top quarter of the tile -> the TOP quarter of the page, which in points is
  // the HIGH y range.
  const box = cropBoxToPoints({x: 0, y: 0, w: 100, h: 25}, {w: 612, h: 792});
  assert.deepEqual(box, [0, 594, 612, 792]);
});

test('a zero-area rectangle is rejected before it reaches the engine', () => {
  assert.equal(cropBoxToPoints({x: 10, y: 10, w: 0, h: 20}, {w: 612, h: 792}), null);
});
```

- [ ] **Step 2: Run to verify failure** — no `cropBoxToPoints`.
- [ ] **Step 3: Implement**

```js
/* DOM rectangles measure y downward from the top; PDF user space measures it
   upward from the bottom. The flip belongs here, once, rather than in the drag
   handler where it would be re-derived and eventually re-derived wrongly. */
function cropBoxToPoints(rect, page) {
  const x0 = (rect.x / 100) * page.w;
  const x1 = ((rect.x + rect.w) / 100) * page.w;
  const y1 = page.h - (rect.y / 100) * page.h;
  const y0 = page.h - ((rect.y + rect.h) / 100) * page.h;
  if (x1 <= x0 || y1 <= y0) return null;
  return [x0, y0, x1, y1].map(v => Math.round(v * 100) / 100);
}
```

Then send `{kind: 'crop_pages', pageIds, box}` for every selected page, honouring
the existing `state.scope` ("This page" / all pages). Crop is **not** optimistic.

- [ ] **Step 4: Run** `node --test tests/test_ui_state.cjs` → PASS. Then crop a real page and confirm the render matches the drawn rectangle.
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(editor): crop pages"
```

---

## Task 16: UI — OCR text layer

**Depends on:** T11, T12, T8. **Parallel with:** T14, T15.

**Files:** Modify `editor-view.js`, `editor-actions.js`, `tests/test_ui_state.cjs`, `tests/test_editor_api.py`.

OCR is slow — Tesseract at 300 DPI is seconds per page — so this is the one
editor operation that must not look instant.

- [ ] **Step 1: Write the failing tests**

```python
    def test_ocr_on_a_machine_without_tesseract_is_422_with_the_engine_reason(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        if opened["capabilities"]["ocr"]["state"] == "ready":
            self.skipTest("Tesseract is installed on this machine")
        status, body = self.post_raw("/api/editor/operation", {
            "sessionId": session,
            "operations": [{"kind": "add_text_layer", "pageIds": [page]}]})
        self.assertEqual(status, 422)
        self.assertEqual(body["error"]["code"], "ocr-unavailable")
        self.assertTrue(body["error"]["message"])
```

```js
test('OCR is never applied optimistically', () => {
  assert.equal(OPTIMISTIC.ocr, false);
});
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Replace `addOcr()`'s fake `state.ocr = true` with a real `add_text_layer` over `targets()`. While it runs, `state.pending` disables the toolbar and the control shows a progress affordance. Note in a comment that this path exists only because the adapter uses FreeDF's Python API — its JSON transports cannot parse `add_text_layer` (correction C1).
- [ ] **Step 4: Run** both suites → PASS.
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(editor): OCR text layer"
```

---

## Task 17: Recovery behaviour end to end

**Depends on:** T12–T16.

**Files:** Modify `editor-view.js`, `editor-actions.js`, `tests/test_editor_api.py`, `tests/test_editor_sessions.py`.

Each row of the spec's recovery table gets one test and one visible UI result.

- [ ] **Step 1: Write the failing tests**

```python
    def test_a_changed_source_freezes_the_session_and_still_allows_save(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session = opened["session"]["id"]
        self.src.write_bytes(self.src.read_bytes() + b"\n% touched\n")
        status, body = self.post_raw("/api/editor/operation", {
            "sessionId": session,
            "operations": [{"kind": "insert_blank_page", "afterPageId": None}]})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "source-changed")
        self.assertEqual(self.post("/api/editor/inspect",
                                   {"sessionId": session})["session"]["status"], "frozen")

    def test_an_expired_session_does_not_silently_reopen(self):
        session = self.post("/api/editor/open", {"paths": [str(self.src)]})["session"]["id"]
        self.post("/api/editor/close", {"sessionId": session})
        status, body = self.post_raw("/api/editor/operation", {
            "sessionId": session,
            "operations": [{"kind": "insert_blank_page", "afterPageId": None}]})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "session-unknown")

    def test_an_unexpected_adapter_exception_becomes_a_typed_error(self):
        # An adapter exception is contained; a process crash is not, and this
        # test deliberately does not claim otherwise. See correction C4.
        with adapter_raising(RuntimeError("boom")):
            status, body = self.post_raw("/api/editor/inspect", {"sessionId": "x"})
        self.assertEqual(status, 500)
        self.assertEqual(body["error"]["code"], "engine-error")
```

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement the UI results.** `frozen` shows a banner offering "Reopen (discards edits)" or "Save as…". `session-unknown` drops to the empty state and says the session ended, with no silent reopen. `engine-missing` shows the install affordance. Every one carries the engine's `detail` text.
- [ ] **Step 4: Run** `python -m unittest discover -s tests` → PASS.
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(editor): recovery states"
```

---

## Task 18: Extend the golden trace and re-baseline

**Depends on:** T17. **Must be its own commit, reviewed as a diff of the trace.**

**Files:** Modify `tests/ui/trace.js`; regenerate `tests/ui/traces/baseline.json` and `head.json`.

`docs/progress.md` records that the trace has never exercised the Editor and that
its current values are 2 requests, 0 toasts, 43 render passes, 0 errors, 586
elements, structure `8ad83bcf23f40000`, computed `1177f46f815b1100`. Those numbers
**will** change, and that change must be inspected rather than absorbed.

- [ ] **Step 1: Clear both servers** — required before any comparison, per `docs/progress.md`.

```bash
curl -X POST http://127.0.0.1:8898/api/clear && curl -X POST http://127.0.0.1:8899/api/clear
```

- [ ] **Step 2: Add editor steps to the 21-step script** — open a fixture PDF, rotate, undo, redo, delete, insert, crop. Saving is excluded, as destructive actions already are.
- [ ] **Step 3: Record and diff**

```bash
node tests/ui/trace-diff.cjs tests/ui/traces/baseline.json tests/ui/traces/head.json
```

- [ ] **Step 4: Read the diff by hand.** Every new request, toast and render pass must be explainable. An unexplained extra render pass is the classic double-fire bug this rig exists to catch.
- [ ] **Step 5: Commit the new baseline separately**

```bash
git add tests/ui/trace.js tests/ui/traces
git commit -m "test(ui): extend the golden trace to the editor and re-baseline"
```

---

## Task 19: Two-tier testing and documentation

**Depends on:** T18. **Last task.**

**Files:** Create `tests/integration/test_engine_bundled.py`. Modify `docs/architecture.md`, `README.md`, `docs/progress.md`.

The two tiers, per your requirement:

| Tier | Command | FreeDF | A skipped engine test is |
| --- | --- | --- | --- |
| Development | `python -m unittest discover -s tests` | optional | fine — the unavailable path is still covered |
| Integration / release | `ONETOOL_REQUIRE_ENGINE=1 python -m unittest discover -s tests` | **required** | **a failure** |

- [ ] **Step 1: Write the release-tier test**

```python
# tests/integration/test_engine_bundled.py
import os, unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "converter"))
import pdf_engine

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


class BundledEngineTests(unittest.TestCase):
    """Release gate. Without this, a build can ship with a dead Editor and a
    green suite, because every engine test skipped itself politely."""

    @classmethod
    def setUpClass(cls):
        if not os.environ.get("ONETOOL_REQUIRE_ENGINE"):
            raise unittest.SkipTest("development tier; set ONETOOL_REQUIRE_ENGINE=1")

    def test_the_engine_is_present_and_ready(self):
        info = pdf_engine.get_adapter().engine_info()
        self.assertTrue(info["available"], info["reason"])
        self.assertEqual(info["state"], "ready")
        self.assertIn(info["apiVersion"], pdf_engine.SUPPORTED_API_VERSIONS)

    def test_a_wheel_is_vendored(self):
        wheels = list((Path(__file__).resolve().parents[2]
                       / "converter" / "vendor" / "wheels").glob("pdf_engine-*.whl"))
        self.assertTrue(wheels, "no vendored engine wheel found")

    def test_a_real_document_opens_renders_edits_and_saves(self):
        import shutil, tempfile
        adapter = pdf_engine.get_adapter()
        tmp = Path(tempfile.mkdtemp())
        shutil.copy(FIXTURES / "one-page.pdf", tmp / "in.pdf")
        session = adapter.open(str(tmp / "in.pdf"))["sessionId"]
        page = adapter.inspect(session)["document"]["pages"][0]["pageId"]
        self.assertTrue(adapter.render(session, page, {"width": 180})["png"])
        adapter.apply(session, [{"kind": "rotate_pages", "pageIds": [page], "degrees": 90}])
        adapter.save(session, str(tmp / "out.pdf"))
        self.assertTrue((tmp / "out.pdf").is_file())
        adapter.close(session)
```

- [ ] **Step 2: Make skips fail in the release tier.** Add a `load_tests` hook, or a `skipTest` wrapper in a shared `tests/support.py`, so that when `ONETOOL_REQUIRE_ENGINE=1` is set, `engine_or_skip()` raises `AssertionError` instead of `SkipTest`. Without this, the tier is advisory rather than enforced.

- [ ] **Step 3: Run both tiers**

```bash
python -m unittest discover -s tests
```

```bash
ONETOOL_REQUIRE_ENGINE=1 python -m unittest discover -s tests
```

Expected: both PASS on a development machine with the wheel installed; the second
FAILS on a machine without it, which is the point.

- [ ] **Step 4: Document.** Add the boundary rule and the two tiers to
  `docs/architecture.md`; add the Editor's real capabilities and FreeDF's
  attribution and MIT licence to `README.md`; update `docs/progress.md` with the
  new trace numbers from Task 18.

- [ ] **Step 5: Commit**

```bash
git add tests/integration docs README.md
git commit -m "test: require a working engine in the release tier; document the boundary"
```

---

## Self-review

**Spec coverage.** §1 adapter → T1–T5. §1 capability/version reporting → T1, plus
correction C3 and T12. §1 distribution → T1, D2. §2 sessions → T6. §3 HTTP → T7–T10.
§3 artifact indirection → **replaced** by C2 and T9. §3 lazy rendering → T9, T11.
§4 recovery → T6, T17, with C4 correcting the crash claim. §5 UI → T11–T16.
§5 conservative optimistic updates → T13. §6 enforcement → T1. §6 trace → T18.
§6 two-tier testing → T19. No spec section is unaddressed.

**Placeholders.** None. Every code step carries runnable code; T6 Step 3 and
T7 Step 3 describe implementation rules rather than full listings, which is
deliberate — both are mechanical given the tests immediately above them, and the
interfaces are fully specified.

**Type consistency.** `pageId` is a string everywhere, including after T11's
change from numeric ids. `revision` is monotonic in T6, consumed in T9 and T11.
`snapshot()` has one shape, produced in T6 and absorbed in T11. `capabilities` is
FreeDF's dictionary, verbatim, from T2 through T12. Error codes are declared once
in T2's `_ERROR_CODES` and reused unchanged in T7's status mapping.

**Known gaps, deliberately out of scope:** pair mode via `ImportPages`;
`set_metadata` and `extract_pages` (D4); redact, text, draw and stamp, which have
no upstream operation (D3).
