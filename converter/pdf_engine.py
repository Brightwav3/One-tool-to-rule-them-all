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


def _version_tuple(text):
    parts = []
    for chunk in str(text or "0").split("."):
        digits = "".join(c for c in chunk if c.isdigit())
        parts.append(int(digits or 0))
    return tuple(parts + [0, 0])[:3]


class FreeDFAdapter:
    DEFAULT_THUMBNAIL_WIDTH = 180

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

    @_guarded
    def undo(self, session_id):
        self._engine.undo(self._engine.session(session_id))
        return self.inspect(session_id)

    @_guarded
    def redo(self, session_id):
        self._engine.redo(self._engine.session(session_id))
        return self.inspect(session_id)

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


def engine_info():
    """The engine report the UI and registry read. Never raises."""
    return get_adapter().engine_info()
