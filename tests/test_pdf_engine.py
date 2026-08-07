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
        try:
            self.adapter.close(self.session)
        except pdf_engine.PdfEngineError:
            pass

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
                for k, v in value.items():
                    check(k)
                    check(v)
            elif isinstance(value, list):
                for v in value:
                    check(v)
        check(self.adapter.inspect(self.session))
        check(self.adapter.capabilities(self.session))


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
        # The plan wrote this with delete_pages, but the only fixture is a
        # one-page document and v0.2 rejects emptying a document even in a
        # dry run, so the mutation used here is an insert instead.
        self.adapter.apply(self.session, [
            {"kind": "insert_blank_page", "afterPageId": self.page}], dry_run=True)
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


if __name__ == "__main__":
    unittest.main()
