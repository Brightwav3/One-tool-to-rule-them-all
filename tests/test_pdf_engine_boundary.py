"""The adapter boundary, enforced.

Only ``converter/pdf_engine.py`` may import ``pdfengine``. FreeDF is pre-alpha
and its API will move; that single file is the whole mitigation, so the rule is
checked mechanically rather than trusted.

The check is on *imports*, not on the word. An earlier text-scan version could
not tell `import pdfengine` from a string that merely names it, which made the
rule unenforceable in exactly the files that describe the boundary: the adapter
tests assert the `freedf`/`pdfengine` name split, and the vendoring test proves
the unpacked tree works by importing it in a throwaway subprocess. Neither puts
pdfengine into One Tool's process. Parsing means neither needs an exemption, so
a real import added to either one is still caught.
"""

import ast
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {
    ROOT / "converter" / "pdf_engine.py",
    # This file's own fixtures are import statements by construction.
    Path(__file__).resolve(),
}
PACKAGE = "pdfengine"
SKIP_DIRS = {".git", "node_modules", "vendor", "__pycache__", "traces", "baseline"}

# `import x` and `from x import y` are AST nodes; these two are not, and are the
# realistic ways to reach the package without one.
DYNAMIC = re.compile(r"""(__import__|importlib\.import_module)\s*\(\s*["']pdfengine""")


def _imports_pdfengine(path):
    """Return the offending statement, or None."""
    text = path.read_text(encoding="utf-8", errors="ignore")
    dynamic = DYNAMIC.search(text)
    if dynamic:
        return dynamic.group(0)
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return None
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == PACKAGE or alias.name.startswith(PACKAGE + "."):
                    return f"import {alias.name}"
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if module == PACKAGE or module.startswith(PACKAGE + "."):
                return f"from {module} import ..."
    return None


class BoundaryTests(unittest.TestCase):
    def test_only_the_adapter_imports_pdfengine(self):
        offenders = []
        for path in ROOT.rglob("*.py"):
            if SKIP_DIRS & set(path.parts) or path in ALLOWED:
                continue
            statement = _imports_pdfengine(path)
            if statement:
                offenders.append(f"{path.relative_to(ROOT)}: {statement}")
        self.assertEqual(
            offenders,
            [],
            "only converter/pdf_engine.py may import pdfengine; found: " + str(offenders),
        )

    def test_the_adapter_really_does_import_it(self):
        # Guards the inverse failure: a check that passes because nothing
        # anywhere imports the engine would be worthless.
        self.assertIsNotNone(_imports_pdfengine(ROOT / "converter" / "pdf_engine.py"))

    def test_the_checker_catches_both_import_forms_and_the_dynamic_one(self):
        import tempfile

        for source in (
            "import pdfengine\n",
            "import pdfengine.api.engine\n",
            "from pdfengine import PdfEngine\n",
            "from pdfengine.api.models import CropPages\n",
            "m = __import__('pdfengine')\n",
            "import importlib\nm = importlib.import_module('pdfengine')\n",
        ):
            with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as handle:
                handle.write(source)
                probe = Path(handle.name)
            try:
                self.assertIsNotNone(_imports_pdfengine(probe), source)
            finally:
                probe.unlink()

    def test_the_checker_ignores_a_mere_mention(self):
        import tempfile

        for source in (
            'name = "pdfengine"\n',
            'code = "import pdfengine; print(1)"  # runs in a subprocess\n',
            "# pdfengine is vendored under converter/vendor\n",
        ):
            with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as handle:
                handle.write(source)
                probe = Path(handle.name)
            try:
                self.assertIsNone(_imports_pdfengine(probe), source)
            finally:
                probe.unlink()

    def test_the_vendored_tree_is_deliberately_exempt(self):
        # Vendored FreeDF source imports itself. Excluding it is intentional,
        # not an oversight, so the exclusion is asserted rather than assumed.
        self.assertIn("vendor", SKIP_DIRS)
        self.assertTrue((ROOT / "converter" / "vendor" / PACKAGE).is_dir())
