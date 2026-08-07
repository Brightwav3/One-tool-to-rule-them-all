import re, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {
    ROOT / "converter" / "pdf_engine.py",
    # These two describe the vendored engine rather than using it: one asserts
    # the distribution/import name split, the other imports pdfengine inside a
    # throwaway subprocess to prove the unpacked tree works. Neither imports it
    # into One Tool's own process, which is what the rule protects.
    ROOT / "tests" / "test_pdf_engine.py",
    ROOT / "tests" / "test_vendoring.py",
}
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
