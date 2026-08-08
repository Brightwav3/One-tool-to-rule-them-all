import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "converter"))
import pdf_engine


class BundledEngineTests(unittest.TestCase):
    """Release gate: the shipped Editor must have a working vendored engine."""
    @classmethod
    def setUpClass(cls):
        if not os.environ.get("ONETOOL_REQUIRE_ENGINE"):
            raise unittest.SkipTest("development tier; set ONETOOL_REQUIRE_ENGINE=1")

    def test_engine_is_present_ready_and_vendored(self):
        info = pdf_engine.get_adapter().engine_info()
        self.assertTrue(info["available"], info["reason"])
        self.assertEqual(info["state"], "ready")
        self.assertEqual(info["distribution"], "freedf")
        self.assertEqual(info["package"], "pdfengine")
        self.assertEqual(info["source"], "vendored")

    def test_vendored_tree_contains_engine_and_schemas(self):
        vendor = ROOT / "converter" / "vendor" / "pdfengine"
        self.assertTrue((vendor / "__init__.py").is_file())
        self.assertTrue(list((vendor / "schemas" / "v1").glob("*.json")))

    def test_preview_backend_is_ready(self):
        caps = pdf_engine.get_adapter().capabilities()
        self.assertEqual(caps["preview"]["state"], "ready", caps["preview"]["detail"])

    def test_real_document_opens_renders_edits_and_saves(self):
        adapter = pdf_engine.get_adapter()
        tmp = Path(tempfile.mkdtemp())
        try:
            source = tmp / "in.pdf"
            shutil.copy(ROOT / "tests" / "fixtures" / "one-page.pdf", source)
            session = adapter.open(str(source))["sessionId"]
            page = adapter.inspect(session)["document"]["pages"][0]["pageId"]
            self.assertTrue(adapter.render(session, page, {"width": 180})["png"])
            adapter.apply(session, [{"kind": "rotate_pages", "pageIds": [page], "degrees": 90}])
            output = tmp / "out.pdf"
            adapter.save(session, str(output))
            self.assertTrue(output.is_file())
            adapter.close(session)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
