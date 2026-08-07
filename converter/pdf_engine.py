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


def engine_info():
    """The engine report the UI and registry read. Never raises."""
    return get_adapter().engine_info()
