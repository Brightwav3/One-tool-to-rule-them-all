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


if __name__ == "__main__":
    unittest.main()
