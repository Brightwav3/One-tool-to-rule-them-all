import tempfile
import unittest
from pathlib import Path
from unittest import mock

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "converter"))

import registry  # noqa: E402


class RegistryTests(unittest.TestCase):
    def test_locate_binary_resolves_nested_command_shim_to_real_executable(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            shim = root / "dependencies" / "bin" / "override" / "pdftoppm.cmd"
            nested_shim = root / "dependencies" / "native" / "poppler" / "bin" / "pdftoppm.cmd"
            executable = root / "dependencies" / "native" / "poppler" / "Library" / "bin" / "pdftoppm.exe"
            shim.parent.mkdir(parents=True)
            nested_shim.parent.mkdir(parents=True)
            executable.parent.mkdir(parents=True)
            shim.write_text(
                '@echo off\nset "SCRIPT_DIR=%~dp0"\ncall "%SCRIPT_DIR%..\\..\\native\\poppler\\bin\\pdftoppm.cmd" %*\n',
                encoding="utf-8",
            )
            nested_shim.write_text(
                '@echo off\n"%~dp0..\\Library\\bin\\pdftoppm.exe" %*\n',
                encoding="utf-8",
            )
            executable.write_bytes(b"not a real executable")
            helper = registry.Helper(
                name="test",
                why="test",
                binaries=("pdftoppm",),
                url="",
                commands={},
            )

            registry._HELPER_CACHE.clear()
            with mock.patch.object(registry.shutil, "which", return_value=str(shim)):
                self.assertEqual(helper.locate_binary("pdftoppm"), str(executable))


if __name__ == "__main__":
    unittest.main()
