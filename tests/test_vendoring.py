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
