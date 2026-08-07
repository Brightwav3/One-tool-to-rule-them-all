# FreeDF Editor Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make One Tool's Editor operate on real PDF files by putting FreeDF behind a single adapter, replacing the prototype's generated pages with a real page model, real renders, and real saves.

**Architecture:** Editor UI → `editor-actions.js` → One Tool editor HTTP API → `EditorSession` → `PdfEngineAdapter` → FreeDF Python façade (`pdfengine.PdfEngine`). Only `converter/pdf_engine.py` imports `pdfengine`; that rule is enforced by a test. FreeDF is discovered as a registry `Helper`, so an absent or unsupported engine yields a blocked Editor rather than a crash.

**Tech Stack:** Python 3.11+ (this machine runs 3.12.10), `converter/server.py`'s stdlib HTTP server, existing registry/queue/history model, FreeDF 0.2.0 (distribution `freedf`, import `pdfengine`, MIT), Poppler and Tesseract as FreeDF's optional backends, `unittest`.

**Engine source of truth:** `C:\Users\Sajmon\pdf engine`, branch `feat/v0.2-integration` at `2a48e49`, working tree clean, **not pushed to GitHub**. `origin/main` is `0ec5ddfb` and is pre-v0.2. Every fact below was read from that branch's source, cross-checked against `docs/CONTRACT-CHANGELOG.md`, `docs/deployment.md`, and `docs/contract-policy.md`.

**Spec:** `docs/specs/2026-08-07-freedf-editor-integration-design.md`. Where this plan and the spec disagree, this plan wins.

---

## Stale assumptions in the previous revision

The previous plan was written against `origin/main` (`0ec5ddfb`, pre-v0.2). Nine
assumptions were wrong. Every one is corrected below and carried through the
tasks.

| # | Previously claimed (C1–C6) | v0.2 source actually says |
| --- | --- | --- |
| **S1** | `add_text_layer` has no branch in `parse_operation`; OCR is Python-only, and that is an argument for the in-process adapter. | **False in v0.2.** `contracts.py:195` parses `add_text_layer`, accepting `{kind, pageIds, language, mode, dpi, minConfidence}`. `CONTRACT-CHANGELOG.md` lists it under Added: "previously reachable only from Python." OCR works on **all three surfaces**. The in-process choice must be justified on other grounds — it still is, but not this one. |
| **S2** | `artifact` is not in `COMMANDS`. | **False.** `COMMANDS` is `("open", "inspect", "capabilities", "render", "artifact", "apply", "undo", "redo", "save", "close")` — exactly ten, matching your original interface after all. |
| **S3** | Artifact ids are per-call randoms in an unbounded dict with no retrieval path, therefore "no artifact subsystem exists". | **False.** `api/artifacts.py` is a designed subsystem: `ArtifactRegistry` with `register` / `get` (ownership-checked) / `get_for_transport` / `forget_session`; three storage strategies (`MemoryArtifact`, `CacheArtifact`, `FileArtifact`); kinds `page_render`, `thumbnail`, `saved_document`; descriptors carry `sha256`, `byteSize`, `contentType`, `metadata`. `forget_session` is called on close, so it is not unbounded. |
| **S4** | `render` returns bytes only; `save` returns a path only. | **Half true, and the half matters.** On the **Python façade** `render_page()` returns `RenderResult` and `save()` returns `Path` — neither touches the registry. Artifacts are minted by **`CommandDispatcher`** only (`_command_render` registers a `MemoryArtifact`, `_command_save` registers a `FileArtifact`). This distinction decides question 2 — see D1. |
| **S5** | Capability states are `ready` / `blocked` / `error`. | **Incomplete.** `ocr/base.py:28` — `CAPABILITY_STATES = ("ready", "blocked", "unavailable", "error")`. The changelog defines the new one: `unavailable` means "this installation cannot provide it", `blocked` means "this document blocks it". Collapsing them destroys exactly the distinction that decides whether to offer an install button. |
| **S6** | Tool state must be inferred by mapping `capabilities.ocr` onto tools. | **Unnecessary.** `capabilities.operations` now carries per-operation `state` and `detail`, and `requires: ["ocr"]` on `add_text_layer`. The UI reads operation state directly. |
| **S7** | A closed session and an unknown session both yield `session_not_found` → one One Tool code `session-unknown`. | **False.** `engine.session()` raises `SessionStateError` (code `session_invalid_state`) with `details.state` and `details.allowed` for a **closed** session, and `SessionNotFoundError` (`session_not_found`) only for an id never issued. The changelog flags this as a deliberate behaviour change. Two codes, two different UI results. |
| **S8** | Distribution and version: `pdf-engine` 0.1.0; pin on `API_VERSION` because package metadata lags. | **Superseded.** Distribution is **`freedf`**, version **0.2.0**; import package is **`pdfengine`**; `pdfengine.__version__ == "0.2.0"`; `API_VERSION == "v1"`. The name split is deliberate and documented. Metadata no longer lags, so gate on **both**: `API_VERSION` for contract compatibility and `__version__` for a minimum-feature floor. |
| **S9** | "Vendor a wheel into `converter/vendor/wheels/`" was treated as sufficient. | **Insufficient, as you said.** `app/main.js:16` spawns the user's **system Python** (`process.env.CBZ_PYTHON` or `python`/`python3` on PATH). There is no bundled interpreter and no virtualenv, so nothing ever installs the wheel. See Task 1 for the mechanism that actually works. |

Two further corrections that follow from the above:

- **S4 kills the previous "no second lifecycle" reasoning by inversion.** The old
  plan invented a `revision` counter partly because it believed FreeDF exposed no
  stable render identity. It still needs one, but for a different and smaller
  reason — see D2.
- **`engine.save()` already refuses to overwrite the source** (`replaces_source
  and not options.allow_replace_source`) **and already checks `source_changed()`**
  before writing. The previous plan's adapter-level `os.path.samefile` guard is
  redundant and is removed; the adapter defers to the engine and translates.

---

## Global Constraints

- Only `converter/pdf_engine.py` may import `pdfengine`, in any form. Enforced by `tests/test_pdf_engine_boundary.py`.
- No FreeDF object, dataclass, or exception crosses out of `converter/pdf_engine.py`. Outbound values are `dict` / `list` / `str` / `int` / `float` / `bool` / `None` / `bytes` only.
- FreeDF stays behind `PdfEngineAdapter`. The server owns editor sessions, undo and redo.
- The service binds only to `127.0.0.1`. No telemetry, no cloud, no external storage.
- Every existing API route, queue behaviour, and history behaviour is preserved.
- One Tool never mutates the source PDF. `allow_replace_source` is never set to `True`.
- Save runs on the existing conversion queue.
- Every local path, page id, operation kind, and output name is validated server-side. Renderer state is untrusted input.
- Python floor is 3.11 (FreeDF `requires-python = ">=3.11"`).
- Distribution `freedf` 0.2.0; import package `pdfengine`; `API_VERSION` `"v1"`. The distribution/import split is preserved verbatim and never "corrected" in code or docs.
- Development tests may exercise `UnavailablePdfAdapter`. Release tests require the bundled engine.
- Every commit leaves the application launchable and the full suite green.

---

## What v0.2 gives us, verified

| Need | v0.2 |
| --- | --- |
| Stable page ids | `page_id` on every `PageInfo`; all operations target ids, never positions |
| Undo/redo | `session.state.can_undo` / `can_redo`; `engine.undo/redo` |
| Validate without committing | `apply_operations(..., dry_run=True)` |
| Source-changed detection | `session.source_changed()`, checked inside `save()`; `SourceChangedError` |
| Render caching | `RenderCache`, keyed by `(state fingerprint, page_id, width, renderer version)` |
| Per-operation readiness | `capabilities.operations[].state` / `.detail` / `.requires` |
| Document-level readiness | `capabilities.document` (aliased as `read`): `structuralEdit`, `textContent` |
| Decodable filter list | `capabilities.filters.decodable` |
| Allowed commands while open | `capabilities.allowedCommands` |
| Lifecycle state | `SessionState.OPEN` / `CLOSED`; `SessionTombstone`; `inspect` result carries `state` |
| Sensible save name | `engine.default_target(session)` → `<stem>-edited.pdf`, collision-avoiding |
| Crop | `CropPages(page_ids, box)`, box in PDF points |
| OCR | `AddTextLayer(page_ids, language, mode, dpi, min_confidence)` |
| Pair mode, later | `ImportPages(source_session_id, page_ids, after_page_id)` |

---

## Decisions

**D1, D2 and D3 were approved on 2026-08-07 as recommended.** D1 = option A,
`RenderResult` bytes, **including** the narrow save-artifact exception. D2 =
keep `rev`. D3 = `ONETOOL_PDFENGINE` → vendored → installed. The engine branch
`feat/v0.2-integration` was pushed to `origin` the same day, so the vendored
tree is no longer the only copy of that code.

D4 and D5 remain open and are answered inside their tasks.

### D1 — Consume FreeDF's artifact abstraction, or take `RenderResult` bytes?

This is question 2, and S4 decides it. On the Python façade, `render_page()`
returns `RenderResult(image_bytes=…)` and `save()` returns a `Path`. **Neither
registers an artifact.** `engine.artifacts` exists on the engine object, but only
`CommandDispatcher` ever writes to it. Using the façade, the registry stays empty
unless we populate it ourselves.

| Option | Consequence |
| --- | --- |
| **A. Take `RenderResult.image_bytes` directly (recommended)** | Matches the surface we chose. One call, bytes in hand, no descriptor bookkeeping, no base64. FreeDF's on-disk `RenderCache` still does the caching that matters. |
| B. Switch to `CommandDispatcher` to get artifacts | Every thumbnail becomes JSON with a base64 payload — roughly 33% larger and an encode/decode per page — and we lose the typed models. Buys a `sha256` we do not need for an `<img>` tag. |
| C. Keep the façade but register artifacts ourselves into `engine.artifacts` | Uses a registry the façade does not maintain, so we would own its lifetime while FreeDF owns `forget_session`. Two owners, one structure. |

**Recommendation: A.** Take the bytes. Do not build a competing artifact
subsystem *and* do not adopt one the chosen surface does not populate.

**One narrow exception worth taking:** after a successful save, register a single
`saved_document` `FileArtifact` so the history record can carry FreeDF's `sha256`
and `byteSize`. That is one call on a path we already own, it is the registry's
documented purpose, and `forget_session` cleans it up. Include it or not — say
which.

### D2 — Browser cache key

Given D1-A, One Tool serves PNG bytes from its own route and needs a URL that is
safe to mark `immutable`. FreeDF's internal `RenderCache.key()` is not on the
public façade, so we cannot reuse it without reaching into internals.

**Recommendation:** keep the `rev` query parameter — a monotonic
`EditorSession.revision` One Tool increments on every mutation, undo and redo.
It is not a second lifecycle; it is a cache-busting integer, and Task 6 no longer
uses it for anything else.

### D3 — Vendoring precedence

Task 1 vendors an unpacked `pdfengine` tree and prepends it to `sys.path`. When a
developer also has FreeDF pip-installed, which wins?

**Recommendation:** `ONETOOL_PDFENGINE` (explicit) → vendored (predictable) →
whatever is already importable (last resort). A shipped app should not change
behaviour because of an unrelated global install; a FreeDF developer sets the
environment variable. `engine_info().location` always reports which one loaded.

### D4 — Deferred, answer by end of Task 12

Redact, text, draw and stamp have no FreeDF operation: disable with a reason
(recommended) or remove from the toolbar. `set_metadata` and `extract_pages` are
implemented with no UI: leave unexposed this pass (recommended).

### D5 — Answered 2026-08-07, end of Task 9

**Answer: the grid asks for 180 at `devicePixelRatio <= 1` and 360 above it.
The route's default when `w` is omitted stays FreeDF's
`DEFAULT_THUMBNAIL_WIDTH` of 180. Range is 16–4000; outside it is 400.**

Measured on `tests/fixtures/inherited-pages.pdf` through the real adapter:

| `w` | rendered | PNG bytes | render |
| --- | --- | --- | --- |
| 180 | 255×180 | 607 B | 69 ms |
| 360 | 510×360 | 1569 B | 69 ms |
| 1000 | 1416×1000 | 8456 B | 100 ms |

Two things this settled. First, the 2× variant is nearly free — 1 KB and no
measurable extra render time, since Poppler's cost here is fixed overhead, not
pixels — so there is no reason to wait for it to visibly blur before shipping
it. Second, FreeDF's `width` is a **bounding** dimension, not a literal pixel
width: a landscape page asked for 180 came back 255×180. Any CSS that assumes
`w` is the rendered width will mis-size landscape pages, so the grid must size
from the returned `width`/`height`, not from what it requested.

`DEFAULT_PREVIEW_WIDTH` of 1000 is left for a future single-page preview; the
grid never asks for it.

---

## File structure

**Created**

| File | Responsibility |
| --- | --- |
| `converter/pdf_engine.py` | The only file importing `pdfengine`. Vendor path setup, adapter protocol, `FreeDFAdapter`, `UnavailablePdfAdapter`, `PdfEngineError`, error translation, `get_adapter()` |
| `converter/vendor/pdfengine/` | Unpacked FreeDF package tree, including `schemas/v1/*.json` |
| `converter/vendor/README.md` | Source commit, version, and how to refresh |
| `converter/editor_sessions.py` | `EditorSession`, `EditorSessionStore`, revision counter, operation log, JSON persistence, expiry |
| `converter/ui/workspaces/editor/editor-actions.js` | Editor's backend calls and snapshot absorption |
| `tests/test_pdf_engine_boundary.py` | Enforces the import rule |
| `tests/test_pdf_engine.py` | Adapter contract, both implementations |
| `tests/test_vendoring.py` | The vendored tree is importable, complete, and version-correct |
| `tests/test_editor_sessions.py` | Session model, revisions, persistence, recovery |
| `tests/test_editor_api.py` | HTTP route contract |
| `tests/integration/test_engine_bundled.py` | Release tier |

**Modified**

`converter/registry.py`, `converter/server.py`,
`converter/ui/workspaces/editor/editor-state.js`, `editor-view.js`,
`converter/ui/index.html`, `converter/ui/interaction/action-router.js`,
`docs/architecture.md`, `tests/ui/trace.js`.

---

## Task dependency graph

```
T1 vendor + import + helper + engine_info
   │
   ├──> T2 adapter open/inspect/close/capabilities
   │       ├──> T3 adapter render          ┐
   │       ├──> T4 adapter apply/undo/redo ├ parallel
   │       └──> T5 adapter save            ┘
   │
   └──> T6 EditorSession store ──> T7 routes: open/inspect/close
                                      ├──> T8 operation/undo/redo  (needs T4)  ┐
                                      ├──> T9 page.png             (needs T3)  ├ parallel
                                      └──> T10 save via queue      (needs T5)  ┘
                                             └──> T11 UI: open + real grid
                                                    ├──> T12 capabilities + tool state
                                                    ├──> T13 structural ops ─┐ sequence
                                                    ├──> T14 undo/redo ──────┘ these two
                                                    ├──> T15 crop
                                                    └──> T16 OCR
                                                           └──> T17 recovery UX
                                                                  └──> T18 trace re-baseline
                                                                         └──> T19 release tier + docs
```

**Parallelizable:** T3/T4/T5 after T2. T8/T9/T10 after T7 plus their adapter dep.
T12/T15/T16 after T11.
**Sequence:** T13 then T14 — both rewrite `editor-state.js`.
**Serial:** T1→T2, T6→T7, T11 gates all UI, T18 immediately before T19.

---

## Task 1: Vendor FreeDF so it actually imports, then report it

**Blocks:** everything. **Answers:** D3.

**Files:** Create `converter/pdf_engine.py`, `converter/vendor/pdfengine/`,
`converter/vendor/README.md`, `tests/test_pdf_engine_boundary.py`,
`tests/test_pdf_engine.py`, `tests/test_vendoring.py`.
Modify `converter/registry.py`, `converter/server.py`.

**Interfaces:**
- Produces: `PdfEngineError(code, message, hint="", details=None, engine_code=None)`; `get_adapter(refresh=False) -> PdfEngineAdapter`; `engine_info() -> dict`; `SUPPORTED_API_VERSIONS = ("v1",)`; `MINIMUM_ENGINE_VERSION = (0, 2, 0)`.

### Why a wheel drop is not enough

`app/main.js:16` resolves Python as `process.env.CBZ_PYTHON || (win32 ? 'python' :
'python3')` and spawns `server.py` with it. The packaged app therefore runs on
**the user's system interpreter**, with no virtualenv and no install step at any
point. A `.whl` sitting in `converter/` would never be installed by anything.

electron-builder copies `../converter` → `resources/converter` with filter
`**/*`, so anything inside `converter/` ships verbatim. That is the delivery
mechanism we already have: ship the package **unpacked** and put it on
`sys.path`.

Zipimporting the wheel directly would *mostly* work — it is `py3-none-any` — but
`contracts.SCHEMA_DIR` resolves from `__file__` and `schema_bytes()` calls
`Path.read_bytes()`, which fails inside a zip. We do not call `schema_bytes()`,
but shipping a build with a latent "works until someone touches schemas" failure
is not worth the one file saved.

- [ ] **Step 1: Build the wheel and unpack it**

```bash
cd "/c/Users/Sajmon/pdf engine/pdf-engine" && python -m pip wheel . -w /tmp/freedf-wheel --no-deps
```

```bash
cd "C:/Users/Sajmon/pdf  tool" && mkdir -p converter/vendor && python -c "
import glob, zipfile, pathlib, shutil
whl = glob.glob('/tmp/freedf-wheel/freedf-*.whl')[0]
dest = pathlib.Path('converter/vendor')
shutil.rmtree(dest / 'pdfengine', ignore_errors=True)
with zipfile.ZipFile(whl) as z:
    z.extractall(dest, [n for n in z.namelist() if n.startswith('pdfengine/')])
print('unpacked', whl)
"
```

The wheel is named `freedf-0.2.0-py3-none-any.whl` — **distribution `freedf`** —
while the extracted package directory is **`pdfengine/`**. Both names are correct
and neither is a typo; `pyproject.toml` documents the split, and
`docs/CONTRACT-CHANGELOG.md` records the deferred rename.

- [ ] **Step 2: Record provenance** in `converter/vendor/README.md`: distribution `freedf`, version `0.2.0`, import package `pdfengine`, source repo, branch `feat/v0.2-integration`, commit `2a48e49`, and the two commands above.

- [ ] **Step 3: Write the boundary test**

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
        self.assertEqual(offenders, [], f"only converter/pdf_engine.py may reference pdfengine; found: {offenders}")

    def test_the_vendored_tree_is_deliberately_exempt(self):
        # Vendored FreeDF source imports itself. Excluding it is intentional,
        # not an oversight, so the exclusion is asserted rather than assumed.
        self.assertIn("vendor", SKIP_DIRS)
        self.assertTrue((ROOT / "converter" / "vendor" / "pdfengine").is_dir())
```

- [ ] **Step 4: Write the vendoring test**

```python
# tests/test_vendoring.py
import subprocess, sys, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "converter" / "vendor"


class VendoringTests(unittest.TestCase):
    def test_the_unpacked_package_is_present_with_its_schemas(self):
        self.assertTrue((VENDOR / "pdfengine" / "__init__.py").is_file())
        self.assertTrue((VENDOR / "pdfengine" / "api" / "engine.py").is_file())
        # package-data that zipimport would have broken
        self.assertTrue(list((VENDOR / "pdfengine" / "schemas" / "v1").glob("*.json")))

    def test_it_imports_in_a_clean_interpreter_with_only_the_vendor_path(self):
        code = (
            "import sys; sys.path.insert(0, r'%s');"
            "import pdfengine;"
            "from pdfengine.api.contracts import API_VERSION;"
            "print(pdfengine.__version__, API_VERSION)" % VENDOR
        )
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), "0.2.0 v1")

    def test_schema_bytes_works_from_the_unpacked_tree(self):
        # The specific thing a zipimported wheel would have broken.
        code = (
            "import sys; sys.path.insert(0, r'%s');"
            "from pdfengine.api.contracts import schema_bytes;"
            "print(len(schema_bytes('response')) > 0)" % VENDOR
        )
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertEqual(out.stdout.strip(), "True", out.stderr)

    def test_the_electron_filter_would_ship_the_vendor_tree(self):
        import json
        pkg = json.loads((ROOT / "app" / "package.json").read_text(encoding="utf-8"))
        extra = pkg["build"]["extraResources"]
        self.assertTrue(any(e["from"] == "../converter" for e in extra))
```

- [ ] **Step 5: Write the failing adapter tests**

```python
# tests/test_pdf_engine.py
import os, unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "converter"))
import pdf_engine


class EngineInfoTests(unittest.TestCase):
    def test_unavailable_adapter_reports_a_reason_and_never_raises(self):
        info = pdf_engine.UnavailablePdfAdapter("not installed").engine_info()
        self.assertFalse(info["available"])
        self.assertEqual(info["state"], "unavailable")
        self.assertTrue(info["reason"])

    def test_unavailable_adapter_raises_typed_errors_from_every_operation(self):
        adapter = pdf_engine.UnavailablePdfAdapter("not installed")
        for call in (lambda: adapter.open("x.pdf"), lambda: adapter.inspect("s"),
                     lambda: adapter.capabilities(), lambda: adapter.close("s")):
            with self.assertRaises(pdf_engine.PdfEngineError) as caught:
                call()
            self.assertEqual(caught.exception.code, "engine-missing")

    def test_engine_info_reports_distribution_and_import_names_separately(self):
        info = pdf_engine.get_adapter().engine_info()
        self.assertEqual(info["distribution"], "freedf")
        self.assertEqual(info["package"], "pdfengine")

    def test_engine_info_shape_is_stable(self):
        info = pdf_engine.get_adapter().engine_info()
        for key in ("available", "name", "distribution", "package", "version",
                    "apiVersion", "supportedApiVersions", "minimumVersion",
                    "source", "location", "renderer", "ocr", "capabilities",
                    "state", "reason"):
            self.assertIn(key, info)
        self.assertIn(info["state"], {"ready", "blocked", "unavailable", "unsupported", "error"})

    def test_the_vendored_engine_is_the_one_that_loaded(self):
        info = pdf_engine.get_adapter().engine_info()
        if info["source"] != "vendored":
            self.skipTest(f"engine loaded from {info['source']}")
        self.assertIn("vendor", info["location"].replace("\\", "/"))

    def test_an_override_path_takes_precedence(self):
        os.environ["ONETOOL_PDFENGINE"] = str(Path(__file__).resolve().parents[1]
                                              / "converter" / "vendor")
        try:
            info = pdf_engine.get_adapter(refresh=True).engine_info()
            self.assertEqual(info["source"], "override")
        finally:
            os.environ.pop("ONETOOL_PDFENGINE", None)
            pdf_engine.get_adapter(refresh=True)
```

- [ ] **Step 6: Run to verify failure**

Run: `python -m unittest tests.test_pdf_engine -v`
Expected: FAIL, `ModuleNotFoundError: No module named 'pdf_engine'`.

- [ ] **Step 7: Implement path resolution, the error type, and the unavailable adapter**

```python
# converter/pdf_engine.py
"""The only module permitted to import pdfengine.

FreeDF is the distribution; `pdfengine` is the import package. That split is
deliberate upstream (see pdf-engine/pyproject.toml) and is preserved here.

No FreeDF object, dataclass, or exception may cross out of this file. See
docs/architecture.md and tests/test_pdf_engine_boundary.py.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

DISTRIBUTION = "freedf"
PACKAGE = "pdfengine"
SUPPORTED_API_VERSIONS = ("v1",)
MINIMUM_ENGINE_VERSION = (0, 2, 0)
VENDOR_DIR = Path(__file__).resolve().parent / "vendor"


class PdfEngineError(Exception):
    """A typed failure One Tool routes on, carrying FreeDF's own code."""

    def __init__(self, code, message, *, hint="", details=None, engine_code=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.details = dict(details or {})
        self.engine_code = engine_code

    def as_dict(self):
        return {"code": self.code, "message": self.message, "hint": self.hint,
                "details": self.details, "engineCode": self.engine_code}


def _candidate_paths():
    """Where to look, in precedence order. See decision D3.

    Explicit override first, then the tree we shipped, then whatever the
    interpreter can already see. A shipped build must not change behaviour
    because of an unrelated global install, so 'vendored' outranks 'installed'.
    """
    override = os.environ.get("ONETOOL_PDFENGINE")
    if override:
        yield "override", Path(override)
    if (VENDOR_DIR / PACKAGE / "__init__.py").is_file():
        yield "vendored", VENDOR_DIR
    yield "installed", None


class UnavailablePdfAdapter:
    """Stands in when no usable engine is present. Never imports pdfengine."""

    def __init__(self, reason, state="unavailable", hint=""):
        self._reason = reason
        self._state = state
        self._hint = hint or "Reinstall One Tool's PDF engine, then press Recheck."

    def engine_info(self):
        return {
            "available": False, "name": "FreeDF", "distribution": DISTRIBUTION,
            "package": PACKAGE, "version": None, "apiVersion": None,
            "supportedApiVersions": list(SUPPORTED_API_VERSIONS),
            "minimumVersion": ".".join(map(str, MINIMUM_ENGINE_VERSION)),
            "source": None, "location": None, "renderer": None, "ocr": None,
            "capabilities": {}, "state": self._state, "reason": self._reason,
        }

    def _fail(self, *_a, **_k):
        code = "engine-unsupported" if self._state == "unsupported" else "engine-missing"
        raise PdfEngineError(code, self._reason, hint=self._hint)

    open = inspect = capabilities = render = _fail
    apply = undo = redo = save = close = _fail
```

- [ ] **Step 8: Implement loading and `engine_info`**

```python
def _load():
    """Return (module, PdfEngine, api_version, source, location) or a problem."""
    for source, path in _candidate_paths():
        if path is not None:
            entry = str(path)
            if entry not in sys.path:
                sys.path.insert(0, entry)
        for name in list(sys.modules):
            if name == PACKAGE or name.startswith(PACKAGE + "."):
                del sys.modules[name]
        try:
            import pdfengine
            from pdfengine.api.contracts import API_VERSION
            from pdfengine.api.engine import PdfEngine
        except ImportError:
            continue
        return (pdfengine, PdfEngine, API_VERSION, source,
                str(Path(pdfengine.__file__).resolve().parent)), None
    return None, ("unavailable",
                  f"the {DISTRIBUTION} PDF engine ({PACKAGE}) could not be imported")


def _version_tuple(text):
    parts = []
    for chunk in str(text or "0").split("."):
        digits = "".join(c for c in chunk if c.isdigit())
        parts.append(int(digits or 0))
    return tuple(parts + [0, 0])[:3]


class FreeDFAdapter:
    def __init__(self, module, engine_cls, api_version, source, location):
        self._module = module
        self._api_version = api_version
        self._source = source
        self._location = location
        self._engine = engine_cls()

    def engine_info(self):
        # capabilities() never raises: FreeDF catches broken backends itself and
        # reports them as an 'error' capability state.
        caps = self._engine.capabilities()
        return {
            "available": True, "name": "FreeDF", "distribution": DISTRIBUTION,
            "package": PACKAGE,
            "version": getattr(self._module, "__version__", None),
            "apiVersion": self._api_version,
            "supportedApiVersions": list(SUPPORTED_API_VERSIONS),
            "minimumVersion": ".".join(map(str, MINIMUM_ENGINE_VERSION)),
            "source": self._source, "location": self._location,
            "renderer": caps.get("preview"), "ocr": caps.get("ocr"),
            "capabilities": caps,      # verbatim — see correction S5/S6
            "state": "ready", "reason": None,
        }


_ADAPTER = None


def get_adapter(refresh=False):
    """Pick an adapter. Gates on API_VERSION *and* a minimum engine version."""
    global _ADAPTER
    if _ADAPTER is not None and not refresh:
        return _ADAPTER
    loaded, problem = _load()
    if problem is not None:
        state, reason = problem
        _ADAPTER = UnavailablePdfAdapter(reason, state=state)
        return _ADAPTER
    module, engine_cls, api_version, source, location = loaded
    if api_version not in SUPPORTED_API_VERSIONS:
        _ADAPTER = UnavailablePdfAdapter(
            f"this build supports PDF engine API {', '.join(SUPPORTED_API_VERSIONS)}, "
            f"but the engine at {location} speaks {api_version}", state="unsupported")
        return _ADAPTER
    version = _version_tuple(getattr(module, "__version__", "0"))
    if version < MINIMUM_ENGINE_VERSION:
        _ADAPTER = UnavailablePdfAdapter(
            f"FreeDF {'.'.join(map(str, MINIMUM_ENGINE_VERSION))} or newer is required, "
            f"but {'.'.join(map(str, version))} is installed at {location}",
            state="unsupported")
        return _ADAPTER
    _ADAPTER = FreeDFAdapter(module, engine_cls, api_version, source, location)
    return _ADAPTER
```

Both gates matter and neither is redundant: `API_VERSION` catches a contract
break, `__version__` catches a build that speaks `v1` but predates the features
this plan depends on — `artifact`, `add_text_layer` on JSON, the `unavailable`
state, `session_invalid_state`.

- [ ] **Step 9: Register the helper and surface it**

In `registry.py`, add a `Helper` whose readiness comes from
`get_adapter().engine_info()["state"]` rather than a `PATH` lookup, honouring
`ONETOOL_PDFENGINE`. In `server.py`, include `engine_info()` in `/api/tools` and
call `get_adapter(refresh=True)` from `/api/recheck`.

- [ ] **Step 10: Run everything and commit**

Run: `python -m unittest discover -s tests` → PASS.

```bash
git add converter/pdf_engine.py converter/vendor converter/registry.py converter/server.py tests/test_pdf_engine.py tests/test_pdf_engine_boundary.py tests/test_vendoring.py
git commit -m "feat(editor): vendor FreeDF 0.2.0 and report engine availability"
```

---

## Task 2: Adapter — open, inspect, capabilities, close

**Depends on:** T1. **Blocks:** T3, T4, T5, T6.

**Files:** Modify `converter/pdf_engine.py`, `tests/test_pdf_engine.py`. Create `tests/fixtures/`.

**Interfaces:**
- `open(path, password=None) -> {"sessionId", "path", "document", "capabilities", "defaultTarget"}`
- `inspect(session_id) -> {"sessionId", "document", "canUndo", "canRedo", "state"}`
- `capabilities(session_id=None) -> dict` — FreeDF's shape, verbatim
- `close(session_id) -> {"closed": True}`
- `DocumentDict = {"pageCount", "title", "pages": [PageDict]}`
- `PageDict = {"pageId", "index", "sourceIndex", "width", "height", "rotation"}`

- [ ] **Step 1: Copy fixtures**

```bash
cd "C:/Users/Sajmon/pdf  tool" && mkdir -p tests/fixtures && cp "/c/Users/Sajmon/pdf engine/pdf-engine/fixtures/basic/one-page.pdf" "/c/Users/Sajmon/pdf engine/pdf-engine/fixtures/basic/inherited-pages.pdf" "/c/Users/Sajmon/pdf engine/pdf-engine/fixtures/unsupported/xref-stream.pdf" tests/fixtures/
```

- [ ] **Step 2: Write the failing tests**

```python
FIXTURES = Path(__file__).resolve().parent / "fixtures"


def engine_or_skip(case):
    adapter = pdf_engine.get_adapter()
    if not adapter.engine_info()["available"]:
        if os.environ.get("ONETOOL_REQUIRE_ENGINE"):
            raise AssertionError("release tier requires a working engine")
        case.skipTest("FreeDF not available (development tier)")
    return adapter


class OpenTests(unittest.TestCase):
    def setUp(self):
        self.adapter = engine_or_skip(self)
        self.session = self.adapter.open(str(FIXTURES / "one-page.pdf"))["sessionId"]

    def tearDown(self):
        try: self.adapter.close(self.session)
        except pdf_engine.PdfEngineError: pass

    def test_open_returns_pages_with_stable_ids_and_a_default_target(self):
        opened = self.adapter.open(str(FIXTURES / "inherited-pages.pdf"))
        self.assertTrue(opened["document"]["pages"][0]["pageId"])
        self.assertTrue(opened["defaultTarget"].endswith("-edited.pdf"))
        self.adapter.close(opened["sessionId"])

    def test_inspect_reports_lifecycle_state(self):
        self.assertEqual(self.adapter.inspect(self.session)["state"], "open")

    def test_capabilities_keep_all_four_states_and_per_operation_detail(self):
        caps = self.adapter.capabilities(self.session)
        valid = {"ready", "blocked", "unavailable", "error"}
        self.assertIn(caps["preview"]["state"], valid)
        self.assertIn(caps["ocr"]["state"], valid)
        by_kind = {op["kind"]: op for op in caps["operations"]}
        self.assertIn("crop_pages", by_kind)
        self.assertIn("add_text_layer", by_kind)
        self.assertIn(by_kind["add_text_layer"]["state"], valid)
        self.assertEqual(by_kind["add_text_layer"]["requires"], ["ocr"])
        self.assertIn("document", caps)
        self.assertIn("allowedCommands", caps)
        self.assertIn("filters", caps)

    def test_a_closed_session_is_distinct_from_an_unknown_one(self):
        session = self.adapter.open(str(FIXTURES / "one-page.pdf"))["sessionId"]
        self.adapter.close(session)
        with self.assertRaises(pdf_engine.PdfEngineError) as closed:
            self.adapter.inspect(session)
        self.assertEqual(closed.exception.code, "session-closed")
        self.assertEqual(closed.exception.engine_code, "session_invalid_state")
        with self.assertRaises(pdf_engine.PdfEngineError) as unknown:
            self.adapter.inspect("session_never_issued")
        self.assertEqual(unknown.exception.code, "session-unknown")
        self.assertEqual(unknown.exception.engine_code, "session_not_found")

    def test_missing_file_is_a_typed_error(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.open(str(FIXTURES / "nope.pdf"))
        self.assertEqual(caught.exception.code, "source-unreadable")

    def test_unsupported_document_keeps_the_engine_code_and_feature(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.open(str(FIXTURES / "xref-stream.pdf"))
        self.assertEqual(caught.exception.engine_code, "unsupported_pdf")
        self.assertIn("feature", caught.exception.details)

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

- [ ] **Step 3: Run to verify failure** — `AttributeError: … has no attribute 'open'`.

- [ ] **Step 4: Implement error translation**

```python
_ERROR_CODES = {
    "parse_error": "source-unreadable",
    "unsupported_pdf": "source-unreadable",
    "session_not_found": "session-unknown",
    "session_invalid_state": "session-closed",     # v0.2: distinct — see S7
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
    """Any engine exception -> a typed One Tool error, preserving its detail."""
    if isinstance(exc, ValueError) and not hasattr(exc, "code"):
        # Model __post_init__ validation, e.g. a rotation that is not 90/180/270.
        return PdfEngineError("operation-invalid", str(exc))
    engine_code = getattr(exc, "code", None)
    details = {}
    for name in ("field", "feature", "offset", "session_id", "state", "allowed"):
        value = getattr(exc, name, None)
        if value is not None:
            details[name] = value
    return PdfEngineError(_ERROR_CODES.get(engine_code, "engine-error"),
                          str(exc), details=details, engine_code=engine_code)


def _guarded(fn):
    """Every boundary crossing goes through here.

    This converts adapter *exceptions* into typed errors. It cannot and does not
    protect against a process-level crash: FreeDF's own docs/deployment.md says
    of the Python surface that "a parser crash takes the host down with it".
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
        if not os.path.isfile(path):
            raise PdfEngineError("source-unreadable", f"no such PDF file: {path}")
        session = self._engine.open_document(path, password)
        return {
            "sessionId": session.session_id,
            "path": str(session.path),
            "document": self._document(session),
            "capabilities": self._engine.capabilities(session),
            "defaultTarget": str(self._engine.default_target(session)),
        }

    @_guarded
    def inspect(self, session_id):
        session = self._engine.session(session_id)
        return {
            "sessionId": session_id,
            "document": self._document(session),
            "canUndo": session.state.can_undo,
            "canRedo": session.state.can_redo,
            "state": session.state_name.value,
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
        info = self._engine.inspect_document(session)
        return {
            "pageCount": info.page_count, "title": info.title,
            "pages": [{"pageId": p.page_id, "index": p.index,
                       "sourceIndex": p.source_index, "width": p.width,
                       "height": p.height, "rotation": p.rotation}
                      for p in info.pages],
        }
```

- [ ] **Step 6: Run** `python -m unittest tests.test_pdf_engine tests.test_pdf_engine_boundary -v` → PASS.
- [ ] **Step 7: Commit**

```bash
git add converter/pdf_engine.py tests/test_pdf_engine.py tests/fixtures
git commit -m "feat(editor): adapter open, inspect, capabilities, close"
```

---

## Task 3: Adapter — render

**Depends on:** T2. **Parallel with:** T4, T5. **Implements:** D1-A.

**Files:** Modify `converter/pdf_engine.py`, `tests/test_pdf_engine.py`.

**Interfaces:**
- `render(session_id, page_id, options=None) -> {"pageId", "width", "height", "png": bytes, "cacheHit": bool}`; `options` accepts `{"width": int}`, default 180.
- No artifact id. Per D1, the Python façade returns bytes and mints no artifact; `ArtifactRegistry` is populated only by `CommandDispatcher`, which we do not use.

- [ ] **Step 1: Write the failing tests**

```python
class RenderTests(unittest.TestCase):
    def setUp(self):
        self.adapter = engine_or_skip(self)
        if self.adapter.capabilities()["preview"]["state"] != "ready":
            self.skipTest("no working renderer (Poppler unavailable)")
        self.session = self.adapter.open(str(FIXTURES / "one-page.pdf"))["sessionId"]
        self.page = self.adapter.inspect(self.session)["document"]["pages"][0]["pageId"]

    def tearDown(self):
        self.adapter.close(self.session)

    def test_render_returns_png_bytes(self):
        out = self.adapter.render(self.session, self.page, {"width": 180})
        self.assertTrue(out["png"].startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(out["width"], 180)

    def test_second_render_hits_the_engine_cache(self):
        self.adapter.render(self.session, self.page, {"width": 180})
        self.assertTrue(self.adapter.render(self.session, self.page, {"width": 180})["cacheHit"])

    def test_render_does_not_mint_artifacts_on_the_python_facade(self):
        # Guards decision D1: if this ever fails, the surface changed and the
        # artifact question must be reopened rather than worked around.
        out = self.adapter.render(self.session, self.page, {"width": 180})
        self.assertNotIn("artifactId", out)

    def test_unknown_page_is_a_typed_error(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.render(self.session, "page_nope", {"width": 180})
        self.assertEqual(caught.exception.code, "operation-invalid")

    def test_an_absurd_width_is_rejected_before_the_engine_sees_it(self):
        with self.assertRaises(pdf_engine.PdfEngineError):
            self.adapter.render(self.session, self.page, {"width": 99999})
```

- [ ] **Step 2: Run to verify failure** — no attribute `render`.
- [ ] **Step 3: Implement**

```python
    DEFAULT_THUMBNAIL_WIDTH = 180

    @_guarded
    def render(self, session_id, page_id, options=None):
        options = options or {}
        width = int(options.get("width") or self.DEFAULT_THUMBNAIL_WIDTH)
        if not 16 <= width <= 4000:
            raise PdfEngineError("operation-invalid", f"render width out of range: {width}")
        session = self._engine.session(session_id)
        result = self._engine.render_page(session, page_id, width)
        return {"pageId": result.page_id, "width": result.width,
                "height": result.height, "png": result.image_bytes,
                "cacheHit": result.cache_hit}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit**

```bash
git commit -am "feat(editor): adapter page rendering"
```

---

## Task 4: Adapter — apply, undo, redo

**Depends on:** T2. **Parallel with:** T3, T5.

**Interfaces:**
- `apply(session_id, operations, dry_run=False) -> {"sessionId", "document", "canUndo", "canRedo", "state", "dryRun"}`; `undo/redo(session_id)` → same shape as `inspect`.
- Operation payloads are FreeDF's camelCase JSON forms, passed straight to `parse_operation`. All nine kinds parse in v0.2, `add_text_layer` included (S1):

```python
{"kind": "rotate_pages",      "pageIds": [...], "degrees": 90|180|270}
{"kind": "delete_pages",      "pageIds": [...]}
{"kind": "reorder_pages",     "pageIds": [...]}            # full permutation
{"kind": "extract_pages",     "pageIds": [...]}
{"kind": "insert_blank_page", "afterPageId": str|None, "width": float, "height": float}
{"kind": "crop_pages",        "pageIds": [...], "box": [x0, y0, x1, y1]}
{"kind": "set_metadata",      "entries": {...}}
{"kind": "import_pages",      "sourceSessionId": str, "pageIds": [...], "afterPageId": str|None}
{"kind": "add_text_layer",    "pageIds": [...], "language": "eng", "mode": "lstm",
                              "dpi": 300, "minConfidence": 0.0}
```

- [ ] **Step 1: Write the failing tests**

```python
class ApplyTests(unittest.TestCase):
    def setUp(self):
        self.adapter = engine_or_skip(self)
        self.session = self.adapter.open(str(FIXTURES / "one-page.pdf"))["sessionId"]
        self.page = self.adapter.inspect(self.session)["document"]["pages"][0]["pageId"]

    def tearDown(self):
        self.adapter.close(self.session)

    def test_rotate_changes_rotation_and_enables_undo(self):
        out = self.adapter.apply(self.session, [
            {"kind": "rotate_pages", "pageIds": [self.page], "degrees": 90}])
        self.assertEqual(out["document"]["pages"][0]["rotation"] % 360, 90)
        self.assertTrue(out["canUndo"])

    def test_undo_restores_and_redo_reapplies(self):
        self.adapter.apply(self.session, [
            {"kind": "rotate_pages", "pageIds": [self.page], "degrees": 90}])
        out = self.adapter.undo(self.session)
        self.assertEqual(out["document"]["pages"][0]["rotation"] % 360, 0)
        self.assertTrue(out["canRedo"])
        self.assertEqual(self.adapter.redo(self.session)
                         ["document"]["pages"][0]["rotation"] % 360, 90)

    def test_page_ids_survive_an_insert(self):
        out = self.adapter.apply(self.session, [
            {"kind": "insert_blank_page", "afterPageId": self.page}])
        ids = [p["pageId"] for p in out["document"]["pages"]]
        self.assertIn(self.page, ids)
        self.assertEqual(len(ids), 2)

    def test_dry_run_does_not_commit(self):
        self.adapter.apply(self.session, [
            {"kind": "delete_pages", "pageIds": [self.page]}], dry_run=True)
        self.assertEqual(self.adapter.inspect(self.session)["document"]["pageCount"], 1)

    def test_negative_rotation_is_rejected(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.apply(self.session, [
                {"kind": "rotate_pages", "pageIds": [self.page], "degrees": -90}])
        self.assertEqual(caught.exception.code, "operation-invalid")

    def test_unknown_operation_kind_is_rejected(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.apply(self.session, [
                {"kind": "redact_pages", "pageIds": [self.page]}])
        self.assertEqual(caught.exception.code, "operation-invalid")

    def test_ocr_without_tesseract_reports_the_engine_reason(self):
        if self.adapter.capabilities()["ocr"]["state"] == "ready":
            self.skipTest("Tesseract is installed on this machine")
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.apply(self.session, [
                {"kind": "add_text_layer", "pageIds": [self.page]}])
        self.assertIn(caught.exception.code, {"ocr-unavailable", "operation-unsupported"})
        self.assertTrue(caught.exception.message)
```

- [ ] **Step 2: Run to verify failure** — no attribute `apply`.
- [ ] **Step 3: Implement**

Unlike the previous revision, there is **no special case for `add_text_layer`**:
v0.2's `parse_operation` handles every kind, so the adapter reuses FreeDF's own
validation for all of them and duplicates none of it.

```python
    @_guarded
    def apply(self, session_id, operations, dry_run=False):
        from pdfengine.api.contracts import parse_operation
        if not isinstance(operations, list) or not operations:
            raise PdfEngineError("operation-invalid", "operations must be a non-empty array")
        session = self._engine.session(session_id)
        built = [parse_operation(item) for item in operations]
        state = self._engine.apply_operations(session, built, dry_run=dry_run)
        if dry_run:
            return {"sessionId": session_id, "dryRun": True,
                    "document": self._document(session),
                    "canUndo": state.can_undo, "canRedo": state.can_redo,
                    "state": session.state_name.value}
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

- [ ] **Step 4: Run** → PASS. **Step 5: Commit**

```bash
git commit -am "feat(editor): adapter apply, undo, redo"
```

---

## Task 5: Adapter — save

**Depends on:** T2. **Parallel with:** T3, T4. **Implements:** D1's exception, if taken.

**Interfaces:**
- `save(session_id, path, options=None) -> {"path", "written", "dryRun", "artifact": dict|None}`; `options` accepts `{"dryRun": bool}`. `allow_replace_source` is never exposed and never set.

- [ ] **Step 1: Write the failing tests**

```python
class SaveTests(unittest.TestCase):
    def setUp(self):
        import shutil, tempfile
        self.adapter = engine_or_skip(self)
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

    def test_saving_over_the_source_is_refused_by_the_engine(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.save(self.session, str(self.src))
        self.assertEqual(caught.exception.code, "save-refused")

    def test_dry_run_writes_nothing(self):
        out = self.adapter.save(self.session, str(self.tmp / "dry.pdf"), {"dryRun": True})
        self.assertFalse((self.tmp / "dry.pdf").exists())
        self.assertIsNone(out["artifact"])

    def test_a_real_save_describes_the_output(self):
        out = self.adapter.save(self.session, str(self.tmp / "out.pdf"))
        self.assertEqual(out["artifact"]["kind"], "saved_document")
        self.assertEqual(out["artifact"]["contentType"], "application/pdf")
        self.assertEqual(len(out["artifact"]["sha256"]), 64)

    def test_a_changed_source_blocks_the_save(self):
        self.src.write_bytes(self.src.read_bytes() + b"\n% touched\n")
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.adapter.save(self.session, str(self.tmp / "out.pdf"))
        self.assertEqual(caught.exception.code, "source-changed")
```

- [ ] **Step 2: Run to verify failure** — no attribute `save`.
- [ ] **Step 3: Implement**

`engine.save()` already refuses to overwrite the source and already calls
`session.source_changed()` first, so the adapter adds no guard of its own — it
translates. The one refusal message needs mapping, because the engine raises a
bare `PdfEngineError` (code `engine_error`) for it.

```python
    @_guarded
    def save(self, session_id, path, options=None):
        from pdfengine.api.artifacts import FileArtifact
        from pdfengine.api.models import SaveOptions
        options = options or {}
        dry_run = bool(options.get("dryRun"))
        session = self._engine.session(session_id)
        try:
            written = self._engine.save(
                session, path,
                SaveOptions(allow_replace_source=False, dry_run=dry_run))
        except Exception as exc:
            if "allow_replace_source" in str(exc):
                raise PdfEngineError(
                    "save-refused", "saving over the source document is not permitted",
                    hint="Choose a different output name.") from exc
            raise
        artifact = None
        if not dry_run:
            # D1's narrow exception: one descriptor, for the history record's
            # sha256 and byte size. FreeDF forgets it when the session closes.
            artifact = self._engine.artifacts.register(
                kind="saved_document", content_type="application/pdf",
                session_id=session_id, storage=FileArtifact(written)).as_dict()
        return {"path": str(written), "written": not dry_run,
                "dryRun": dry_run, "artifact": artifact}
```

If D1's exception is declined, drop the `register` call and return
`"artifact": None` always; the tests above drop with it.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit**

```bash
git commit -am "feat(editor): adapter save"
```

---

## Task 6: `EditorSession` and its store

**Depends on:** T2. **Blocks:** T7.

**Files:** Create `converter/editor_sessions.py`, `tests/test_editor_sessions.py`.

### Not a second lifecycle

FreeDF owns the session lifecycle: `SessionState.OPEN` / `CLOSED`, tombstones,
`session_invalid_state`, and cache directories. One Tool must not maintain a
parallel copy of any of that.

What One Tool persists is only what FreeDF deliberately does not, because
FreeDF's Python sessions live and die with the process:

| One Tool stores | Why FreeDF cannot |
| --- | --- |
| the operation log | needed to rebuild a session after **the One Tool backend restarts**, which ends FreeDF's process too |
| the chosen output path | an application preference, not an engine concern |
| `revision` | a browser cache-busting integer for One Tool's image URL (D2) |
| `status` (`active` / `frozen` / `degraded`) | a UI concept layered on engine errors |

Lifecycle state is **read from the engine** — `inspect()["state"]`, and the
`session-closed` vs `session-unknown` distinction — never tracked independently.

**Interfaces:**
- `EditorSession`: `.id`, `.engine_session_ids: list[str]`, `.source_paths: list[str]`, `.revision: int`, `.ops: list[dict]`, `.cursor: int`, `.output_path`, `.created`, `.touched`, `.status`.
- `EditorSessionStore(path, adapter)`: `.open(paths)`, `.get(id)`, `.snapshot(id)`, `.apply(id, ops)`, `.undo(id)`, `.redo(id)`, `.close(id)`, `.prune()`, `.reattach(id)`.
- `.snapshot(id) -> {"session", "document", "capabilities", "canUndo", "canRedo", "revision", "engineState"}` — the one shape the HTTP layer returns and the UI absorbs.

`engine_session_ids` is a list so pair mode via `ImportPages` needs no model change.

- [ ] **Step 1: Write the failing tests**

```python
class SessionTests(unittest.TestCase):
    def setUp(self):
        adapter = pdf_engine.get_adapter()
        if not adapter.engine_info()["available"]:
            self.skipTest("FreeDF not available (development tier)")
        self.tmp = Path(tempfile.mkdtemp())
        self.src = self.tmp / "in.pdf"
        shutil.copy(FIXTURES / "one-page.pdf", self.src)
        self.store = editor_sessions.EditorSessionStore(self.tmp / "sessions.json", adapter)
        self.session = self.store.open([str(self.src)])
        self.page = self.store.snapshot(self.session.id)["document"]["pages"][0]["pageId"]

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_revision_starts_at_zero_and_increments_per_mutation(self):
        self.assertEqual(self.session.revision, 0)
        self.store.apply(self.session.id, [
            {"kind": "rotate_pages", "pageIds": [self.page], "degrees": 90}])
        self.assertEqual(self.store.get(self.session.id).revision, 1)

    def test_undo_advances_the_revision_rather_than_rewinding_it(self):
        # It is a cache key, so a repeated value would serve a stale image.
        self.store.apply(self.session.id, [
            {"kind": "rotate_pages", "pageIds": [self.page], "degrees": 90}])
        self.store.undo(self.session.id)
        self.assertEqual(self.store.get(self.session.id).revision, 2)

    def test_apply_after_undo_truncates_the_redo_tail(self):
        self.store.apply(self.session.id, [
            {"kind": "rotate_pages", "pageIds": [self.page], "degrees": 90}])
        self.store.undo(self.session.id)
        self.store.apply(self.session.id, [
            {"kind": "rotate_pages", "pageIds": [self.page], "degrees": 180}])
        self.assertFalse(self.store.snapshot(self.session.id)["canRedo"])

    def test_a_failed_operation_leaves_the_log_untouched(self):
        before = len(self.store.get(self.session.id).ops)
        with self.assertRaises(pdf_engine.PdfEngineError):
            self.store.apply(self.session.id, [
                {"kind": "rotate_pages", "pageIds": ["page_nope"], "degrees": 90}])
        self.assertEqual(len(self.store.get(self.session.id).ops), before)

    def test_lifecycle_state_is_read_from_the_engine_not_tracked_locally(self):
        self.assertEqual(self.store.snapshot(self.session.id)["engineState"], "open")

    def test_sessions_persist_and_replay_after_a_backend_restart(self):
        self.store.apply(self.session.id, [
            {"kind": "rotate_pages", "pageIds": [self.page], "degrees": 90}])
        revived = editor_sessions.EditorSessionStore(
            self.tmp / "sessions.json", pdf_engine.get_adapter())
        snap = revived.snapshot(self.session.id)
        self.assertEqual(snap["document"]["pages"][0]["rotation"] % 360, 90)

    def test_a_changed_source_freezes_the_session_but_keeps_it_readable(self):
        self.src.write_bytes(self.src.read_bytes() + b"\n% touched\n")
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.store.apply(self.session.id, [
                {"kind": "insert_blank_page", "afterPageId": None}])
        self.assertEqual(caught.exception.code, "source-changed")
        self.assertEqual(self.store.get(self.session.id).status, "frozen")
        self.assertTrue(self.store.snapshot(self.session.id)["document"])

    def test_an_unknown_editor_session_raises_session_unknown(self):
        with self.assertRaises(pdf_engine.PdfEngineError) as caught:
            self.store.snapshot("nope")
        self.assertEqual(caught.exception.code, "session-unknown")
```

- [ ] **Step 2: Run to verify failure** — `ModuleNotFoundError: editor_sessions`.

- [ ] **Step 3: Implement**

Rules the implementation must honour:

- `revision` is **monotonic**, incrementing on apply, undo and redo alike.
- `fingerprint` is `sha256(size, mtime_ns, first 64 KiB)` per source, taken at open. A mismatch surfaces as `source-changed` and sets `status = "frozen"`. FreeDF checks its own `FileFingerprint` inside `save()`; One Tool's copy exists to fail earlier, on the *first* mutation rather than at save time.
- A frozen session refuses mutations but still answers `snapshot` and `save`.
- `apply` calls the adapter first and appends to `ops` **only on success**.
- `reattach` reopens the engine session and replays `ops[:cursor]`. Replay is deterministic because `InsertBlankPage` fixes its `page_id` at construction.
- Persistence writes `ops`, never renders, via `tmp + os.replace`.
- `prune()` drops sessions untouched for over 7 days; called at startup and on each `open`.

- [ ] **Step 4: Run** → PASS. **Step 5: Commit**

```bash
git add converter/editor_sessions.py tests/test_editor_sessions.py
git commit -m "feat(editor): server-owned sessions with replay after restart"
```

---

## Task 7: HTTP — open, inspect, close

**Depends on:** T6. **Blocks:** T8, T9, T10.

**Files:** Modify `converter/server.py`. Create `tests/test_editor_api.py`.

**Interfaces:**
- `POST /api/editor/open` `{paths: [str]}` → snapshot
- `POST /api/editor/inspect` `{sessionId}` → snapshot
- `POST /api/editor/close` `{sessionId}` → `{closed: true}`, idempotent
- Error envelope on every editor route: `{"error": {"code", "message", "hint", "details", "engineCode"}}`

Status mapping — note `session-closed` and `session-unknown` are **both 409 but
distinct codes** (S7), because the UI reacts differently:

| Code | Status |
| --- | --- |
| `engine-missing`, `engine-unsupported`, `render-unavailable` | 503 |
| `source-unreadable`, `operation-invalid`, `save-refused` | 400 |
| `session-unknown`, `session-closed`, `source-changed`, `save-conflict` | 409 |
| `operation-unsupported`, `ocr-unavailable` | 422 |
| anything else | 500 |

- [ ] **Step 1: Write the failing tests**

```python
class EditorRouteTests(ServerTestCase):
    def test_open_returns_a_snapshot(self):
        body = self.post("/api/editor/open", {"paths": [str(self.src)]})
        for key in ("session", "document", "capabilities", "revision", "engineState"):
            self.assertIn(key, body)
        self.assertEqual(body["revision"], 0)

    def test_open_a_non_pdf_is_400_with_a_code(self):
        status, body = self.post_raw("/api/editor/open", {"paths": [str(self.txt)]})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "source-unreadable")

    def test_a_closed_session_and_an_unknown_one_are_both_409_but_distinguishable(self):
        session = self.post("/api/editor/open", {"paths": [str(self.src)]})["session"]["id"]
        self.post("/api/editor/close", {"sessionId": session})
        closed_status, closed = self.post_raw("/api/editor/inspect", {"sessionId": session})
        unknown_status, unknown = self.post_raw("/api/editor/inspect", {"sessionId": "nope"})
        self.assertEqual((closed_status, unknown_status), (409, 409))
        self.assertEqual(closed["error"]["code"], "session-closed")
        self.assertEqual(unknown["error"]["code"], "session-unknown")

    def test_close_is_idempotent(self):
        session = self.post("/api/editor/open", {"paths": [str(self.src)]})["session"]["id"]
        self.assertTrue(self.post("/api/editor/close", {"sessionId": session})["closed"])
        self.assertTrue(self.post("/api/editor/close", {"sessionId": session})["closed"])

    def test_editor_routes_return_503_when_the_engine_is_missing(self):
        with unavailable_engine():
            status, body = self.post_raw("/api/editor/open", {"paths": [str(self.src)]})
        self.assertEqual(status, 503)
        self.assertEqual(body["error"]["code"], "engine-missing")

    def test_tools_reports_the_engine_with_both_names(self):
        engine = self.get("/api/tools")["engine"]
        self.assertEqual(engine["distribution"], "freedf")
        self.assertEqual(engine["package"], "pdfengine")

    def test_existing_routes_still_work(self):
        self.assertIn("files", self.get("/api/state"))
```

- [ ] **Step 2: Run to verify failure** — 404 on `/api/editor/open`.
- [ ] **Step 3: Implement.** Add `_editor_error` on `Handler` for the envelope and status table, construct `EditorSessionStore` alongside `HistoryStore` and `SettingsStore` using the app-data directory Electron passes in, and wire the three routes.
- [ ] **Step 4: Run** `python -m unittest discover -s tests` → PASS.
- [ ] **Step 5: Commit**

```bash
git add converter/server.py tests/test_editor_api.py
git commit -m "feat(editor): open, inspect and close routes"
```

---

## Task 8: HTTP — operation, undo, redo

**Depends on:** T7, T4. **Parallel with:** T9, T10.

**Interfaces:** `POST /api/editor/operation` `{sessionId, operations, dryRun?}`, `POST /api/editor/undo`, `POST /api/editor/redo` — all returning a snapshot.

- [ ] **Step 1: Write the failing tests**

```python
    def test_rotate_bumps_the_revision(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        body = self.post("/api/editor/operation", {"sessionId": session,
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

    def test_an_unknown_kind_is_400_and_does_not_bump_the_revision(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session = opened["session"]["id"]
        status, _ = self.post_raw("/api/editor/operation", {"sessionId": session,
            "operations": [{"kind": "redact_pages", "pageIds": ["x"]}]})
        self.assertEqual(status, 400)
        self.assertEqual(self.post("/api/editor/inspect", {"sessionId": session})["revision"], 0)

    def test_a_dry_run_does_not_bump_the_revision(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        self.post("/api/editor/operation", {"sessionId": session, "dryRun": True,
            "operations": [{"kind": "delete_pages", "pageIds": [page]}]})
        self.assertEqual(self.post("/api/editor/inspect", {"sessionId": session})["revision"], 0)
```

- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.** **Step 4: Run** full suite → PASS.
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(editor): operation, undo and redo routes"
```

---

## Task 9: HTTP — the page image route

**Depends on:** T7, T3. **Parallel with:** T8, T10. **Answers:** D5.

**Interfaces:** `GET /api/editor/page.png?session=&page=&w=&rev=` → `image/png`.
`rev` is required and must equal the session's current revision; a stale `rev` is
409, never a stale image. That is what makes `immutable` truthful (D2).

- [ ] **Step 1: Write the failing tests**

```python
    def test_page_png_returns_an_image_with_immutable_caching(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        if opened["capabilities"]["preview"]["state"] != "ready":
            self.skipTest("Poppler unavailable")
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

    def test_a_missing_renderer_is_503_not_a_broken_image(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        if opened["capabilities"]["preview"]["state"] == "ready":
            self.skipTest("Poppler is installed on this machine")
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        status, _, _ = self.get_raw(
            f"/api/editor/page.png?session={session}&page={page}&w=180&rev=0")
        self.assertEqual(status, 503)
```

- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** — validate `session`, `page`, `w` (16–4000), `rev`; call `adapter.render`; write bytes with `Content-Type: image/png` and `Cache-Control: public, max-age=31536000, immutable`.
- [ ] **Step 4: Run** → PASS. **Step 5: Answer D5** on a real multi-page PDF.
- [ ] **Step 6: Commit**

```bash
git commit -am "feat(editor): revision-keyed page image route"
```

---

## Task 10: HTTP — save through the existing queue

**Depends on:** T7, T5. **Parallel with:** T8, T9.

**Interfaces:** `POST /api/editor/save` `{sessionId, outputPath?}` → `{jobId, outputPath}`. Omitting `outputPath` uses the adapter's `defaultTarget` from Task 2. The work runs as a `Job` on the existing single worker.

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

    def test_save_without_a_path_uses_the_engine_default_target(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        self.assertTrue(opened["session"]["defaultTarget"].endswith("-edited.pdf"))

    def test_a_second_save_while_one_runs_is_409(self):
        # post save twice without waiting
        self.assertEqual(second_status, 409)
        self.assertEqual(second_body["error"]["code"], "save-conflict")

    def test_saving_over_the_source_is_refused(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        status, body = self.post_raw("/api/editor/save",
            {"sessionId": opened["session"]["id"], "outputPath": str(self.src)})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"]["code"], "save-refused")

    def test_a_failed_save_keeps_the_session_alive(self):
        # outputPath inside a directory that does not exist
        self.wait_for_idle()
        self.assertEqual(self.post("/api/editor/inspect", {"sessionId": session})["revision"], 1)
```

- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** — validate the output name with the helper conversion outputs already use, set a `saving` flag, submit a `Job` calling `adapter.save`, clear the flag on both paths, and record `artifact.sha256` / `byteSize` on the history entry if D1's exception was taken.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit**

```bash
git commit -am "feat(editor): save through the conversion queue"
```

---

## Task 11: UI — open a real document

**Depends on:** T7, T9. **Blocks:** T12–T16. **First visible change.**

**Files:** Create `converter/ui/workspaces/editor/editor-actions.js`. Modify `editor-state.js`, `editor-view.js`, `index.html`, `interaction/action-router.js`, `tests/test_ui_state.cjs`.

**Interfaces:** `OneToolEditorActions` with `openDocument(paths)`, `applyOperations(ops, {optimistic})`, `undo()`, `redo()`, `save(outputPath)`, `absorbEditor(snapshot)`; state gains `sessionId`, `revision`, `capabilities`, `engineState`, `canUndo`, `canRedo`.

- [ ] **Step 1: Write the failing state tests**

```js
const {createEditorState, makePages} = require('../converter/ui/workspaces/editor/editor-state.js');

test('a fresh state is an empty document, not twenty-four invented pages', () => {
  const e = createEditorState();
  assert.equal(e.state.pages.length, 0);
  assert.equal(e.state.sessionId, null);
  assert.equal(e.state.revision, -1);
});

test('placeholder pages remain available for the empty state', () => {
  assert.equal(makePages(4).length, 4);
});

test('absorbing a snapshot replaces the page model wholesale', () => {
  const e = createEditorState();
  e.absorb({session: {id: 's1'}, revision: 0, canUndo: false, canRedo: false,
            engineState: 'open',
            capabilities: {preview: {state: 'ready', detail: ''}},
            document: {pageCount: 1, title: null, pages: [
              {pageId: 'p1', index: 0, width: 612, height: 792, rotation: 0, sourceIndex: 0}]}});
  assert.equal(e.state.pages.length, 1);
  assert.equal(e.state.pages[0].id, 'p1');
  assert.equal(e.state.sessionId, 's1');
});

test('selection is filtered to surviving pages, never merged', () => {
  const e = createEditorState();
  e.absorb(snapshotWithPages(['p1', 'p2']));
  e.select('p2');
  e.absorb(snapshotWithPages(['p1']));
  assert.deepEqual(Object.keys(e.state.sel), []);
  assert.equal(e.state.focus, 'p1');
});

test('rotation is normalized to the quarter turns FreeDF accepts', () => {
  const e = createEditorState();
  assert.equal(e.normalizeRotation(-90), 270);
  assert.equal(e.normalizeRotation(360), 0);
  assert.equal(e.normalizeRotation(-180), 180);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test tests/test_ui_state.cjs` — FAIL: the state seeds 24 generated pages and has no `absorb`.

- [ ] **Step 3: Change the page model**

`makePages`, `noise`, `LINE_WIDTHS` and `KINDS` **stay exported**, demoted to the
empty state. `createEditorState` seeds `pages: []`.

Page ids become **strings**, so `selectedIds()` drops its `Number` coercion:

```js
const selectedIds = () => Object.keys(state.sel).filter(k => state.sel[k])
  .filter(id => state.pages.some(p => p.id === id));
```

```js
/* FreeDF accepts 90, 180 and 270 only (RotatePages.__post_init__). The
   prototype produced -90 and, via (rot + deg) % 360, other negatives; every
   one of those is rejected upstream. */
function normalizeRotation(deg) {
  return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
}

function absorb(snapshot) {
  state.sessionId = snapshot.session ? snapshot.session.id : null;
  state.revision = snapshot.revision;
  state.capabilities = snapshot.capabilities || {};
  state.engineState = snapshot.engineState || null;
  state.canUndo = !!snapshot.canUndo;
  state.canRedo = !!snapshot.canRedo;
  state.pages = (snapshot.document.pages || []).map(p => ({
    id: p.pageId, index: p.index, w: p.width, h: p.height,
    rot: p.rotation, sourceIndex: p.sourceIndex, marks: [],
  }));
  const live = new Set(state.pages.map(p => p.id));
  state.sel = Object.fromEntries(Object.entries(state.sel).filter(([id]) => live.has(id)));
  if (!live.has(state.focus)) state.focus = state.pages.length ? state.pages[0].id : null;
}
```

- [ ] **Step 4: Write `editor-actions.js`** — a classic script (no `type="module"`) defining `window.OneToolEditorActions`, loaded in `index.html` after `editor-state.js` and before `action-router.js`.
- [ ] **Step 5: Render real pages** — a tile with `state.sessionId` set renders `<img src="/api/editor/page.png?session=…&page=…&w=180&rev=…" loading="lazy">`. `loading="lazy"` is the entire laziness requirement for the grid.
- [ ] **Step 6: Run** `node --test tests/test_ui_state.cjs` → PASS, then open a real PDF and confirm page count and first thumbnail.
- [ ] **Step 7: Commit**

```bash
git add converter/ui tests/test_ui_state.cjs
git commit -m "feat(editor): open a real PDF and show real pages"
```

---

## Task 12: UI — capability-driven tool state

**Depends on:** T11. **Answers:** D4.

**Files:** Modify `editor-view.js`, `editor-state.js`, `registry.py`, `tests/test_ui_state.cjs`.

**Interfaces:** `toolState(toolId) -> {enabled, state, detail, action}` where `state` is one of `ready` / `blocked` / `unavailable` / `error` / `unimplemented`.

Per S6, tool state is read from `capabilities.operations[].state` directly — no
inference from `capabilities.ocr`. Per S5, all four states survive, because they
imply **different offers**:

| Engine state | Meaning | What the UI offers |
| --- | --- | --- |
| `ready` | usable | the tool |
| `unavailable` | this installation cannot provide it (Tesseract or Poppler missing) | an **install** affordance, via the existing helper flow |
| `blocked` | this document blocks it (undecodable streams) | an explanation naming the document, **no** install button |
| `error` | the backend is present but broken | the error detail, and a Recheck |
| — | no FreeDF operation exists | `unimplemented`, disabled with a roadmap note |

- [ ] **Step 1: Write the failing tests**

```js
test('crop follows the engine operation state', () => {
  const e = stateWithCaps({operations: [{kind: 'crop_pages', state: 'ready', detail: ''}]});
  assert.equal(e.toolState('crop').enabled, true);
});

test('an unavailable OCR offers an install, a blocked one does not', () => {
  const missing = stateWithCaps({operations: [
    {kind: 'add_text_layer', state: 'unavailable', detail: 'Tesseract executable not found'}]});
  assert.equal(missing.toolState('ocr').state, 'unavailable');
  assert.equal(missing.toolState('ocr').action, 'install');

  const blocked = stateWithCaps({operations: [
    {kind: 'add_text_layer', state: 'blocked', detail: '3 streams use filters this version cannot decode'}]});
  assert.equal(blocked.toolState('ocr').state, 'blocked');
  assert.equal(blocked.toolState('ocr').action, null);
});

test('a broken backend is distinguished from an absent one', () => {
  const e = stateWithCaps({operations: [
    {kind: 'add_text_layer', state: 'error', detail: 'tesseract exited 139'}]});
  assert.equal(e.toolState('ocr').state, 'error');
  assert.equal(e.toolState('ocr').detail, 'tesseract exited 139');
});

test('tools with no engine operation report unimplemented', () => {
  const e = stateWithCaps({operations: [{kind: 'crop_pages', state: 'ready', detail: ''}]});
  assert.equal(e.toolState('redact').state, 'unimplemented');
});

test('the engine detail is never replaced by a generic message', () => {
  const e = stateWithCaps({operations: [
    {kind: 'add_text_layer', state: 'unavailable', detail: 'Tesseract executable not found: tesseract'}]});
  assert.match(e.toolState('ocr').detail, /Tesseract executable not found/);
});
```

- [ ] **Step 2: Run to verify failure** — no `toolState`.
- [ ] **Step 3: Implement `toolState`;** render disabled tools with `title` and `aria-disabled` carrying `detail`.
- [ ] **Step 4: Collapse for the registry** — in `registry.py`, map `ready` → `ready`, `unavailable` → `helper` (installable), `blocked` and `error` → distinct blocked states. Never fold `error` into `blocked`, and always carry `detail`.
- [ ] **Step 5: Answer D4.** **Step 6: Run** both suites → PASS.
- [ ] **Step 7: Commit**

```bash
git commit -am "feat(editor): capability-driven tool state"
```

---

## Task 13: UI — structural operations and the optimistic policy

**Depends on:** T11. **Sequence before T14.**

**Interfaces:** `OPTIMISTIC = {rotate: true, reorder: true, delete: false, insert: false, crop: false, ocr: false, undo: false, redo: false, save: false}`; `state.pending`.

- [ ] **Step 1: Write the failing tests**

```js
test('rotate applies locally before the server answers', () => {
  const e = stateWithPages(['p1']);
  e.rotate(90);
  assert.equal(e.state.pages[0].rot, 90);
});

test('delete waits for the server', () => {
  const e = stateWithPages(['p1', 'p2']);
  e.select('p1'); e.remove();
  assert.equal(e.state.pages.length, 2);
});

test('insert waits, because the engine assigns the page id', () => {
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

- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** — `rotate` and reorder mutate locally after snapshotting the prior page array, then post; everything else posts first. `canMutate()` gates the controls; `rejectPending(code)` restores and toasts the engine's reason.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit**

```bash
git commit -am "feat(editor): conservative optimistic updates"
```

---

## Task 14: UI — undo and redo

**Depends on:** T11, T8. **Sequence after T13.**

- [ ] **Step 1: Write the failing tests**

```js
test('undo and redo controls follow the server flags', () => {
  const e = createEditorState();
  e.absorb(snapshotWith({canUndo: true, canRedo: false}));
  assert.equal(e.state.canUndo, true);
  assert.equal(e.state.canRedo, false);
});

test('the edits pane renders the server op log, not local strings', () => {
  assert.equal(describeOp({kind: 'rotate_pages', pageIds: ['p1'], degrees: 90}),
               'Rotated 1 page by 90°');
  assert.equal(describeOp({kind: 'add_text_layer', pageIds: ['p1', 'p2']}),
               'Added a text layer to 2 pages');
});
```

- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** — toolbar buttons plus `Ctrl+Z` / `Ctrl+Shift+Z`, gated on `canUndo` / `canRedo` and `canMutate()`. `state.edits` becomes a derived view of the server op log via a pure `describeOp(op)`; `log()` and `nextLocalId('edit')` are deleted.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit**

```bash
git commit -am "feat(editor): undo and redo"
```

---

## Task 15: UI — crop

**Depends on:** T11, T12, T8. **Parallel with:** T14, T16.

The one real complexity is coordinates. The UI drags in **percentages of the
displayed tile, y downward from the top**. `CropPages` takes `[x0, y0, x1, y1]`
in **PDF user-space points, y upward from the bottom**, and rejects a box where
`box[2] <= box[0] or box[3] <= box[1]`.

- [ ] **Step 1: Write the failing tests**

```js
test('a full-page rectangle round-trips to the full media box', () => {
  assert.deepEqual(cropBoxToPoints({x: 0, y: 0, w: 100, h: 100}, {w: 612, h: 792}),
                   [0, 0, 612, 792]);
});

test('the y axis is flipped, because PDF measures up and the DOM measures down', () => {
  assert.deepEqual(cropBoxToPoints({x: 0, y: 0, w: 100, h: 25}, {w: 612, h: 792}),
                   [0, 594, 612, 792]);
});

test('a zero-area rectangle is rejected before it reaches the engine', () => {
  assert.equal(cropBoxToPoints({x: 10, y: 10, w: 0, h: 20}, {w: 612, h: 792}), null);
});
```

- [ ] **Step 2: Run to verify failure.** **Step 3: Implement**

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

Send `{kind: 'crop_pages', pageIds, box}` honouring `state.scope`. Crop is not optimistic.

- [ ] **Step 4: Run** → PASS, then crop a real page and confirm the render matches the rectangle. **Step 5: Commit**

```bash
git commit -am "feat(editor): crop pages"
```

---

## Task 16: UI — OCR text layer

**Depends on:** T11, T12, T8. **Parallel with:** T14, T15.

OCR is slow — Tesseract at 300 DPI is seconds per page — so it must not look
instant. Note that v0.2 exposes `add_text_layer` on every surface (S1); no
special-casing is needed anywhere in the stack.

- [ ] **Step 1: Write the failing tests**

```python
    def test_ocr_without_tesseract_is_422_carrying_the_engine_reason(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        if opened["capabilities"]["ocr"]["state"] == "ready":
            self.skipTest("Tesseract is installed on this machine")
        status, body = self.post_raw("/api/editor/operation", {"sessionId": session,
            "operations": [{"kind": "add_text_layer", "pageIds": [page]}]})
        self.assertEqual(status, 422)
        self.assertEqual(body["error"]["code"], "ocr-unavailable")
        self.assertTrue(body["error"]["message"])

    def test_ocr_options_reach_the_engine(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        if opened["capabilities"]["ocr"]["state"] != "ready":
            self.skipTest("Tesseract unavailable")
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        body = self.post("/api/editor/operation", {"sessionId": session,
            "operations": [{"kind": "add_text_layer", "pageIds": [page],
                            "language": "eng", "mode": "lstm", "dpi": 300,
                            "minConfidence": 0.0}]})
        self.assertEqual(body["revision"], 1)
```

```js
test('OCR is never applied optimistically', () => {
  assert.equal(OPTIMISTIC.ocr, false);
});
```

- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** — replace `addOcr()`'s fake `state.ocr = true` with a real `add_text_layer` over `targets()`; `state.pending` disables the toolbar and the control shows progress. Language and mode come from `capabilities.ocr.languages` / `.modes`, which v0.2 reports.
- [ ] **Step 4: Run** both suites → PASS. **Step 5: Commit**

```bash
git commit -am "feat(editor): OCR text layer"
```

---

## Task 17: Recovery behaviour end to end

**Depends on:** T12–T16.

Each code gets one test and one visible result.

| Code | Cause | Status | UI |
| --- | --- | --- | --- |
| `engine-missing` | no importable engine | 503 | Editor blocked, reinstall hint; Convert and Creator unaffected |
| `engine-unsupported` | API or version gate failed | 503 | same, naming both versions |
| `source-unreadable` | not a PDF, or unreadable | 400 | toast, no session |
| `source-changed` | fingerprint mismatch | 409 | frozen banner: Reopen (discards edits) or Save as… |
| `session-closed` | closed session | 409 | "this document was closed" — offers reopen |
| `session-unknown` | id never issued | 409 | drop to empty state, no silent reopen |
| `operation-invalid` | bad page id or payload | 400 | reject, reconcile to server manifest |
| `operation-unsupported` / `ocr-unavailable` | capability absent | 422 | tool disabled with the engine detail |
| `render-unavailable` | Poppler absent | 503 | tiles show a "previews unavailable" placeholder, not broken images |
| `save-conflict` | a save is running | 409 | save disabled while active |
| `save-refused` | target is the source | 400 | inline message on the name field |
| `engine-error` | unexpected adapter exception | 500 | session degraded, ops preserved, offer reopen-and-replay |

- [ ] **Step 1: Write the failing tests**

```python
    def test_a_changed_source_freezes_the_session_and_still_allows_save(self):
        opened = self.post("/api/editor/open", {"paths": [str(self.src)]})
        session = opened["session"]["id"]
        self.src.write_bytes(self.src.read_bytes() + b"\n% touched\n")
        status, body = self.post_raw("/api/editor/operation", {"sessionId": session,
            "operations": [{"kind": "insert_blank_page", "afterPageId": None}]})
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "source-changed")
        self.assertEqual(self.post("/api/editor/inspect",
                                   {"sessionId": session})["session"]["status"], "frozen")

    def test_an_unexpected_adapter_exception_becomes_a_typed_error(self):
        # An adapter exception is contained. A process crash is not, and this
        # test deliberately does not claim otherwise: FreeDF's own
        # docs/deployment.md says the Python surface shares the host process.
        with adapter_raising(RuntimeError("boom")):
            status, body = self.post_raw("/api/editor/inspect", {"sessionId": "x"})
        self.assertEqual(status, 500)
        self.assertEqual(body["error"]["code"], "engine-error")
```

- [ ] **Step 2: Run to verify failure.** **Step 3: Implement the UI results,** each carrying the engine's own `detail`.
- [ ] **Step 4: Run** full suite → PASS. **Step 5: Commit**

```bash
git commit -am "feat(editor): recovery states"
```

---

## Task 18: Extend the golden trace and re-baseline

**Depends on:** T17. **Own commit, reviewed as a diff of the trace.**

`docs/progress.md` records that the trace has never exercised the Editor, and its
current values: 2 requests, 0 toasts, 43 render passes, 0 errors, 586 elements,
structure `8ad83bcf23f40000`, computed `1177f46f815b1100`. Those will change, and
the change must be inspected rather than absorbed.

- [ ] **Step 1: Clear both servers** — required before any comparison.

```bash
curl -X POST http://127.0.0.1:8898/api/clear && curl -X POST http://127.0.0.1:8899/api/clear
```

- [ ] **Step 2: Add editor steps** — open a fixture PDF, rotate, undo, redo, delete, insert, crop. Saving is excluded, as destructive actions already are.
- [ ] **Step 3: Record and diff**

```bash
node tests/ui/trace-diff.cjs tests/ui/traces/baseline.json tests/ui/traces/head.json
```

- [ ] **Step 4: Read the diff by hand.** Every new request, toast and render pass must be explainable. An unexplained extra render pass is the double-fire bug this rig exists to catch.
- [ ] **Step 5: Commit the new baseline separately**

```bash
git add tests/ui/trace.js tests/ui/traces
git commit -m "test(ui): extend the golden trace to the editor and re-baseline"
```

---

## Task 19: Two-tier testing and documentation

**Depends on:** T18. **Last task.**

| Tier | Command | FreeDF | A skipped engine test is |
| --- | --- | --- | --- |
| Development | `python -m unittest discover -s tests` | optional | fine — the unavailable path is still covered |
| Integration / release | `ONETOOL_REQUIRE_ENGINE=1 python -m unittest discover -s tests` | **required** | **a failure** |

- [ ] **Step 1: Write the release-tier test**

```python
# tests/integration/test_engine_bundled.py
import os, shutil, tempfile, unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "converter"))
import pdf_engine

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"


class BundledEngineTests(unittest.TestCase):
    """Release gate. Without this, a build can ship with a dead Editor and a
    green suite, because every engine test skipped itself politely."""

    @classmethod
    def setUpClass(cls):
        if not os.environ.get("ONETOOL_REQUIRE_ENGINE"):
            raise unittest.SkipTest("development tier; set ONETOOL_REQUIRE_ENGINE=1")

    def test_the_engine_is_present_ready_and_vendored(self):
        info = pdf_engine.get_adapter().engine_info()
        self.assertTrue(info["available"], info["reason"])
        self.assertEqual(info["state"], "ready")
        self.assertEqual(info["distribution"], "freedf")
        self.assertEqual(info["package"], "pdfengine")
        self.assertIn(info["apiVersion"], pdf_engine.SUPPORTED_API_VERSIONS)
        self.assertGreaterEqual(pdf_engine._version_tuple(info["version"]),
                                pdf_engine.MINIMUM_ENGINE_VERSION)
        self.assertEqual(info["source"], "vendored")

    def test_the_unpacked_package_ships_inside_converter(self):
        self.assertTrue((ROOT / "converter" / "vendor" / "pdfengine" / "__init__.py").is_file())
        self.assertTrue(list((ROOT / "converter" / "vendor" / "pdfengine"
                              / "schemas" / "v1").glob("*.json")))

    def test_the_backends_the_editor_advertises_are_actually_installed(self):
        caps = pdf_engine.get_adapter().capabilities()
        self.assertEqual(caps["preview"]["state"], "ready", caps["preview"]["detail"])

    def test_a_real_document_opens_renders_edits_and_saves(self):
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

- [ ] **Step 2: Make skips fail in the release tier.** `engine_or_skip()` from Task 2 already raises `AssertionError` when `ONETOOL_REQUIRE_ENGINE` is set. Audit every other `skipTest` added by this plan — the Poppler and Tesseract guards in T3, T9 and T16 — and decide per case: Poppler is required at release (the Editor advertises previews), Tesseract is optional (OCR degrades honestly). Encode that decision in a shared `tests/support.py` rather than repeating it.
- [ ] **Step 3: Run both tiers**

```bash
python -m unittest discover -s tests
```

```bash
ONETOOL_REQUIRE_ENGINE=1 python -m unittest discover -s tests
```

Both pass on a machine with the vendored tree and Poppler; the second fails without them, which is the point.

- [ ] **Step 4: Document.** In `docs/architecture.md`: the boundary rule, the vendoring mechanism, the two tiers, and the `freedf` / `pdfengine` name split. In `README.md`: the Editor's real capabilities, FreeDF's attribution and MIT licence, and that Poppler drives previews while Tesseract drives OCR. In `docs/progress.md`: the new trace numbers from T18.
- [ ] **Step 5: Commit**

```bash
git add tests/integration tests/support.py docs README.md
git commit -m "test: require a working engine in the release tier; document the boundary"
```

---

## Self-review

**Spec coverage.** Adapter → T1–T5. Capability/version reporting → T1, T12.
Distribution → T1, D3. Sessions → T6. HTTP → T7–T10. Rendering → T3, T9, T11.
Recovery → T6, T17. UI → T11–T16. Optimistic policy → T13. Boundary enforcement
→ T1. Trace → T18. Two-tier testing → T19.

**Approved decisions preserved.** Only `converter/pdf_engine.py` imports
`pdfengine` (T1 test). FreeDF stays behind the adapter. Server owns sessions,
undo and redo (T6). Real structural editing and real renders in the first pass
(T11). Crop and OCR are real capabilities (T15, T16). Toolbar state is
capability-driven (T12). Save uses the queue (T10). The source PDF is never
mutated (`allow_replace_source=False`, T5). Development tests exercise
`UnavailablePdfAdapter` (T1). Release tests require the bundled engine (T19).

**Type consistency.** `pageId` is a string throughout. `revision` is monotonic,
set in T6, consumed in T9 and T11. `snapshot()` has one shape, produced in T6 and
absorbed in T11. `capabilities` is FreeDF's dictionary verbatim from T2 to T12,
with all four states intact. Error codes are declared once in T2's `_ERROR_CODES`
and reused in T7's status table and T17's recovery table — `session-closed` and
`session-unknown` remain distinct in all three.

**Known gaps, deliberately out of scope:** pair mode via `ImportPages`;
`set_metadata` and `extract_pages` (D4); redact, text, draw and stamp, which have
no upstream operation (D4).

**One open risk:** the engine branch is unpushed. `converter/vendor/README.md`
pins commit `2a48e49`, but until `feat/v0.2-integration` is pushed, that
provenance cannot be verified by anyone else, and the vendored tree is the only
copy in the One Tool repo. Push the branch before Task 1 lands.
