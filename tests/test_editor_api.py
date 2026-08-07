"""Task 7: the editor's HTTP surface, and the harness Tasks 8-10 reuse.

`ServerTestCase` runs a real server on a loopback port, with the editor session
store and the history store pointed at a throwaway directory so a test never
touches the user's own files. `unavailable_engine()` swaps in the adapter that
stands in when no engine is present, which is the only honest way to exercise
the 503 branch on a machine where FreeDF is installed.
"""

import contextlib
import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "converter"))

import editor_sessions  # noqa: E402
import pdf_engine  # noqa: E402
import server  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@contextlib.contextmanager
def unavailable_engine(reason="test: the engine is not installed", state="unavailable"):
    """Make every adapter call fail the way a missing engine does."""
    previous = pdf_engine._ADAPTER
    pdf_engine._ADAPTER = pdf_engine.UnavailablePdfAdapter(reason, state=state)
    try:
        yield
    finally:
        pdf_engine._ADAPTER = previous


class ServerTestCase(unittest.TestCase):
    """A live server plus JSON helpers. Tasks 8-10 build on this."""

    def setUp(self):
        if not pdf_engine.get_adapter().engine_info()["available"]:
            self.skipTest("FreeDF not available (development tier)")

        self.tmp = Path(tempfile.mkdtemp())
        self.src = self.tmp / "in.pdf"
        shutil.copy(FIXTURES / "one-page.pdf", self.src)
        # A two-page source, for the operations that a one-page document
        # legitimately refuses (deleting the only page, for one).
        self.multi = self.tmp / "two-pages.pdf"
        shutil.copy(FIXTURES / "inherited-pages.pdf", self.multi)
        self.txt = self.tmp / "notes.txt"
        self.txt.write_text("not a pdf at all", encoding="utf-8")

        # Redirect everything that would otherwise write to the real home.
        self._saved_editor_store = server.QUEUE.editor_store
        self._saved_history_store = server.QUEUE.history_store
        server.QUEUE.editor_store = editor_sessions.EditorSessionStore(
            self.tmp / "editor-sessions.json", server.ADAPTER)
        server.QUEUE.history_store = server.HistoryStore(self.tmp / "history.json")

        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.httpd.staging_dir = self.tmp / "staging"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        server.QUEUE.editor_store = self._saved_editor_store
        server.QUEUE.history_store = self._saved_history_store
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- HTTP helpers ------------------------------------------------------ #

    def post_raw(self, route, payload=None):
        """(status, decoded body) — errors included rather than raised."""
        data = json.dumps(payload or {}).encode("utf-8")
        request = Request(self.base_url + route, data=data,
                          headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urlopen(request) as response:
                return response.status, self._decode(response.read())
        except HTTPError as error:
            return error.code, self._decode(error.read())

    def post(self, route, payload=None):
        status, body = self.post_raw(route, payload)
        self.assertLess(status, 400, f"POST {route} -> {status}: {body}")
        return body

    def get_raw(self, route):
        """(status, headers dict, raw bytes) — for the page image route."""
        try:
            with urlopen(self.base_url + route) as response:
                return response.status, dict(response.headers), response.read()
        except HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def get(self, route):
        status, _, raw = self.get_raw(route)
        self.assertLess(status, 400, f"GET {route} -> {status}")
        return self._decode(raw)

    def wait_for_idle(self, timeout=30.0):
        """Block until the conversion queue has nothing queued or running."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self.get("/api/state")["busy"]:
                return True
            time.sleep(0.05)
        raise AssertionError("the queue was still busy after waiting")

    @staticmethod
    def _decode(raw):
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return raw


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

    def test_the_error_envelope_carries_every_field_the_ui_reads(self):
        _, body = self.post_raw("/api/editor/inspect", {"sessionId": "nope"})
        for key in ("code", "message", "hint", "details", "engineCode"):
            self.assertIn(key, body["error"])

    def test_tools_reports_the_engine_with_both_names(self):
        engine = self.get("/api/tools")["engine"]
        self.assertEqual(engine["distribution"], "freedf")
        self.assertEqual(engine["package"], "pdfengine")

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
        opened = self.post("/api/editor/open", {"paths": [str(self.multi)]})
        session, page = opened["session"]["id"], opened["document"]["pages"][0]["pageId"]
        self.post("/api/editor/operation", {"sessionId": session, "dryRun": True,
            "operations": [{"kind": "delete_pages", "pageIds": [page]}]})
        self.assertEqual(self.post("/api/editor/inspect", {"sessionId": session})["revision"], 0)

    def test_existing_routes_still_work(self):
        self.assertIn("files", self.get("/api/state"))


if __name__ == "__main__":
    unittest.main()
