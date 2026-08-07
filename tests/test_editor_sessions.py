"""Task 6: the server-owned editor session and its store.

One Tool persists only what FreeDF cannot: the operation log, the output path,
a cache-busting revision, and a UI-facing status. Lifecycle state is read from
the engine, never mirrored here.
"""

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "converter"))
import editor_sessions
import pdf_engine

FIXTURES = Path(__file__).resolve().parent / "fixtures"


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


if __name__ == "__main__":
    unittest.main()
