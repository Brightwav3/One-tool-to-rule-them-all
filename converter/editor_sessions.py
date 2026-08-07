"""Server-owned editor sessions.

This is deliberately **not** a second lifecycle. FreeDF owns OPEN/CLOSED,
tombstones and cache directories; asking it is the only way this module learns
lifecycle state (``adapter.inspect()["state"]`` and the ``session-unknown`` vs
``session-closed`` distinction).

What One Tool persists is only what FreeDF cannot, because FreeDF's Python
sessions die with the process:

* the operation log, so a session survives a backend restart by replaying;
* the chosen output path, an application preference;
* ``revision``, a monotonic cache-busting integer for the page image URL;
* ``status`` (``active`` / ``frozen`` / ``degraded``), a UI concept.

This module must never import ``pdfengine``; the adapter arrives as a
constructor argument. See tests/test_pdf_engine_boundary.py.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from pathlib import Path

from pdf_engine import PdfEngineError

FINGERPRINT_BYTES = 64 * 1024
MAX_AGE_SECONDS = 7 * 24 * 60 * 60
STATUS_ACTIVE = "active"
STATUS_FROZEN = "frozen"
STATUS_DEGRADED = "degraded"


def fingerprint(path):
    """sha256 over size, mtime_ns and the first 64 KiB.

    Cheap enough to recheck before every mutation, which is the point: FreeDF
    checks its own fingerprint inside save(), so One Tool's copy exists only to
    fail earlier — on the first mutation rather than at save time.
    """
    stat = os.stat(path)
    digest = hashlib.sha256()
    digest.update(str(stat.st_size).encode("ascii"))
    digest.update(b"\x00")
    digest.update(str(stat.st_mtime_ns).encode("ascii"))
    digest.update(b"\x00")
    with open(path, "rb") as handle:
        digest.update(handle.read(FINGERPRINT_BYTES))
    return digest.hexdigest()


def _page_ids_by_source_index(document):
    pages = sorted(document.get("pages") or [],
                   key=lambda p: (p.get("sourceIndex"), p.get("index")))
    return [p["pageId"] for p in pages]


def _remap_op(op, remap):
    """Rewrite an operation's page ids through an old-id -> new-id map."""
    if not remap or not isinstance(op, dict):
        return op
    out = dict(op)
    if isinstance(out.get("pageIds"), list):
        out["pageIds"] = [remap.get(pid, pid) for pid in out["pageIds"]]
    if isinstance(out.get("afterPageId"), str):
        out["afterPageId"] = remap.get(out["afterPageId"], out["afterPageId"])
    return out


class EditorSession:
    """One document (or, in pair mode, several) being edited."""

    def __init__(self, id, engine_session_ids, source_paths, fingerprints,
                 default_target=None, revision=0, ops=None, cursor=0,
                 output_path=None, created=None, touched=None,
                 status=STATUS_ACTIVE, base_page_ids=None):
        self.id = id
        self.engine_session_ids = list(engine_session_ids)
        self.source_paths = list(source_paths)
        self.fingerprints = list(fingerprints)
        # Per source, the engine's page ids in source-index order. FreeDF mints
        # a fresh uuid per page on every open, so this is what lets a replayed
        # operation log point at the same pages after a restart.
        self.base_page_ids = [list(ids) for ids in (base_page_ids or [])]
        self.default_target = default_target
        self.revision = revision
        self.ops = list(ops or [])
        self.cursor = cursor
        self.output_path = output_path
        self.created = created if created is not None else time.time()
        self.touched = touched if touched is not None else self.created
        self.status = status

    def as_dict(self):
        return {
            "id": self.id,
            "engineSessionIds": list(self.engine_session_ids),
            "sourcePaths": list(self.source_paths),
            "fingerprints": list(self.fingerprints),
            "basePageIds": [list(ids) for ids in self.base_page_ids],
            "defaultTarget": self.default_target,
            "revision": self.revision,
            "ops": list(self.ops),
            "cursor": self.cursor,
            "outputPath": self.output_path,
            "created": self.created,
            "touched": self.touched,
            "status": self.status,
        }

    @classmethod
    def from_dict(cls, data):
        return cls(
            id=data["id"],
            engine_session_ids=data.get("engineSessionIds") or [],
            source_paths=data.get("sourcePaths") or [],
            fingerprints=data.get("fingerprints") or [],
            base_page_ids=data.get("basePageIds") or [],
            default_target=data.get("defaultTarget"),
            revision=int(data.get("revision") or 0),
            ops=data.get("ops") or [],
            cursor=int(data.get("cursor") or 0),
            output_path=data.get("outputPath"),
            created=data.get("created"),
            touched=data.get("touched"),
            status=data.get("status") or STATUS_ACTIVE,
        )


class EditorSessionStore:
    def __init__(self, path, adapter):
        self._path = Path(path)
        self._adapter = adapter
        self._sessions = {}
        self._load()
        self.prune()

    # ---- persistence -----------------------------------------------------

    def _load(self):
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        for item in raw.get("sessions") or []:
            try:
                session = EditorSession.from_dict(item)
            except (KeyError, TypeError, ValueError):
                continue
            self._sessions[session.id] = session

    def _persist(self):
        """Write the operation log, never renders. tmp + os.replace."""
        payload = {"version": 1,
                   "sessions": [s.as_dict() for s in self._sessions.values()]}
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_name(self._path.name + ".tmp")
            tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError:
            pass

    def prune(self):
        """Drop sessions untouched for over seven days."""
        cutoff = time.time() - MAX_AGE_SECONDS
        stale = [k for k, s in self._sessions.items() if (s.touched or 0) < cutoff]
        for key in stale:
            session = self._sessions.pop(key)
            for engine_id in session.engine_session_ids:
                try:
                    self._adapter.close(engine_id)
                except PdfEngineError:
                    pass
        if stale:
            self._persist()
        return len(stale)

    # ---- lookup ----------------------------------------------------------

    def get(self, session_id):
        session = self._sessions.get(session_id)
        if session is None:
            raise PdfEngineError("session-unknown",
                                 f"no editor session {session_id!r}",
                                 details={"session_id": session_id})
        return session

    # ---- lifecycle -------------------------------------------------------

    def open(self, paths):
        self.prune()
        paths = [str(p) for p in (paths or [])]
        if not paths:
            raise PdfEngineError("source-unreadable", "no document to open")
        engine_ids, fingerprints, base_page_ids, default_target = [], [], [], None
        try:
            for path in paths:
                opened = self._adapter.open(path)
                engine_ids.append(opened["sessionId"])
                fingerprints.append(fingerprint(path))
                base_page_ids.append(_page_ids_by_source_index(opened["document"]))
                if default_target is None:
                    default_target = opened.get("defaultTarget")
        except Exception:
            for engine_id in engine_ids:
                try:
                    self._adapter.close(engine_id)
                except PdfEngineError:
                    pass
            raise
        session = EditorSession(
            id="ed_" + uuid.uuid4().hex, engine_session_ids=engine_ids,
            source_paths=paths, fingerprints=fingerprints,
            base_page_ids=base_page_ids, default_target=default_target)
        self._sessions[session.id] = session
        self._persist()
        return session

    def close(self, session_id):
        session = self.get(session_id)
        for engine_id in session.engine_session_ids:
            try:
                self._adapter.close(engine_id)
            except PdfEngineError as error:
                # Already closed or already forgotten: closing is idempotent.
                if error.code not in ("session-closed", "session-unknown"):
                    raise
        session.touched = time.time()
        self._persist()
        return {"closed": True}

    def reattach(self, session_id):
        """Reopen the engine session and replay ops[:cursor].

        FreeDF mints a fresh page id per page on every open, so the log's page
        ids are translated through source index — the one identity that does
        survive a reopen — before replay. Pages the log itself created keep
        their ids, which is why the store fixes ``pageId`` in _normalize.
        """
        session = session_id if isinstance(session_id, EditorSession) \
            else self.get(session_id)
        engine_ids, base_page_ids = [], []
        for path in session.source_paths:
            opened = self._adapter.open(path)
            engine_ids.append(opened["sessionId"])
            base_page_ids.append(_page_ids_by_source_index(opened["document"]))
        remap = {}
        for old, new in zip(session.base_page_ids, base_page_ids):
            remap.update({o: n for o, n in zip(old, new) if o != n})
        session.ops = [_remap_op(op, remap) for op in session.ops]
        session.engine_session_ids = engine_ids
        session.base_page_ids = base_page_ids
        primary = engine_ids[0]
        for op in session.ops[:session.cursor]:
            self._adapter.apply(primary, [op])
        self._persist()
        return session

    # ---- reads -----------------------------------------------------------

    def _primary(self, session):
        if not session.engine_session_ids:
            self.reattach(session)
        return session.engine_session_ids[0]

    def _inspect(self, session):
        """Ask the engine. session-unknown means the process restarted."""
        try:
            return self._adapter.inspect(self._primary(session))
        except PdfEngineError as error:
            if error.code != "session-unknown":
                raise      # session-closed is a real answer, not a reason to reopen
            self.reattach(session)
            return self._adapter.inspect(session.engine_session_ids[0])

    def snapshot(self, session_id):
        """The one shape the HTTP layer returns and the UI absorbs."""
        session = self.get(session_id)
        info = self._inspect(session)
        engine_id = session.engine_session_ids[0]
        return {
            "session": session.as_dict(),
            "document": info["document"],
            "capabilities": self._adapter.capabilities(engine_id),
            "canUndo": bool(info["canUndo"]),
            "canRedo": bool(info["canRedo"]),
            "revision": session.revision,
            "engineState": info["state"],
            "status": session.status,
        }

    def render(self, session_id, page_id, width=None, revision=None):
        """PNG bytes for one page, keyed by revision.

        The revision is required and must be the current one. Serving a page at
        a revision the session has moved past would make the route's
        ``immutable`` cache header a lie, so a stale request is refused rather
        than answered with an out-of-date image.
        """
        session = self.get(session_id)
        if revision is None:
            raise PdfEngineError("operation-invalid", "rev is required")
        if int(revision) != session.revision:
            raise PdfEngineError(
                "revision-stale",
                f"revision {revision} is not the session's current revision "
                f"{session.revision}",
                hint="Re-request the page image at the current revision.",
                details={"session_id": session.id, "revision": session.revision})
        if not page_id:
            raise PdfEngineError("operation-invalid", "page is required")
        options = {"width": width} if width else {}
        try:
            rendered = self._adapter.render(self._primary(session), page_id, options)
        except PdfEngineError as error:
            if error.code != "session-unknown":
                raise
            self.reattach(session)
            rendered = self._adapter.render(
                session.engine_session_ids[0], page_id, options)
        session.touched = time.time()
        return rendered

    # ---- mutations -------------------------------------------------------

    def _guard(self, session):
        """Frozen sessions refuse mutations; snapshot and save still work."""
        if session.status == STATUS_FROZEN:
            raise PdfEngineError(
                "source-changed",
                "the source document changed on disk after this session opened",
                hint="Close the editor and open the document again.",
                details={"session_id": session.id})
        for path, expected in zip(session.source_paths, session.fingerprints):
            try:
                current = fingerprint(path)
            except OSError:
                current = None
            if current != expected:
                session.status = STATUS_FROZEN
                self._persist()
                raise PdfEngineError(
                    "source-changed",
                    f"the source document changed on disk: {path}",
                    hint="Close the editor and open the document again.",
                    details={"session_id": session.id, "path": path})

    @staticmethod
    def _normalize(operations):
        """Fix insert_blank_page ids here so replay is deterministic.

        FreeDF fixes ``page_id`` at construction for exactly this reason, but
        the id it picks is not returned to us, so the log would replay a
        different page id after a restart. Choosing it before the call keeps
        the persisted op and the applied op identical.
        """
        normalized = []
        for op in operations or []:
            if isinstance(op, dict) and op.get("kind") == "insert_blank_page" \
                    and not op.get("pageId"):
                op = {**op, "pageId": "page_" + uuid.uuid4().hex}
            normalized.append(op)
        return normalized

    def apply(self, session_id, operations, dry_run=False):
        session = self.get(session_id)
        self._guard(session)
        engine_id = self._primary(session)
        if dry_run:
            self._adapter.apply(engine_id, operations, dry_run=True)
            return self.snapshot(session_id)
        operations = self._normalize(operations)
        # The adapter goes first; the log grows only on success.
        self._adapter.apply(engine_id, operations)
        session.ops = session.ops[:session.cursor] + list(operations)
        session.cursor = len(session.ops)
        session.revision += 1
        session.touched = time.time()
        self._persist()
        return self.snapshot(session_id)

    def undo(self, session_id):
        session = self.get(session_id)
        self._guard(session)
        self._adapter.undo(self._primary(session))
        session.cursor = max(0, session.cursor - 1)
        # Monotonic: a repeated revision would serve a stale cached image.
        session.revision += 1
        session.touched = time.time()
        self._persist()
        return self.snapshot(session_id)

    def redo(self, session_id):
        session = self.get(session_id)
        self._guard(session)
        self._adapter.redo(self._primary(session))
        session.cursor = min(len(session.ops), session.cursor + 1)
        session.revision += 1
        session.touched = time.time()
        self._persist()
        return self.snapshot(session_id)

    def set_output_path(self, session_id, output_path):
        session = self.get(session_id)
        session.output_path = output_path
        session.touched = time.time()
        self._persist()
        return session
