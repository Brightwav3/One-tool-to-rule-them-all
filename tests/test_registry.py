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


class EngineCapabilityStateTests(unittest.TestCase):
    """The engine's four operation states collapse onto registry states.

    `unavailable` is installable and so becomes `helper`. `blocked` and `error`
    are different problems with different remedies and must stay distinct: a
    blocked document is not a broken backend. The engine's detail is carried
    verbatim in every case.
    """

    def test_ready_stays_ready(self):
        self.assertEqual(
            registry.collapse_engine_state({"state": "ready", "detail": ""}),
            {"state": "ready", "detail": "", "action": None},
        )

    def test_unavailable_becomes_an_installable_helper(self):
        collapsed = registry.collapse_engine_state(
            {"state": "unavailable", "detail": "Tesseract executable not found"})
        self.assertEqual(collapsed["state"], "helper")
        self.assertEqual(collapsed["action"], "install")
        self.assertEqual(collapsed["detail"], "Tesseract executable not found")

    def test_blocked_and_error_are_distinct(self):
        blocked = registry.collapse_engine_state(
            {"state": "blocked", "detail": "3 streams use filters this version cannot decode"})
        broken = registry.collapse_engine_state(
            {"state": "error", "detail": "tesseract exited 139"})
        self.assertNotEqual(blocked["state"], broken["state"])
        self.assertEqual(blocked["state"], "blocked-document")
        self.assertEqual(broken["state"], "engine-error")
        self.assertIsNone(blocked["action"])
        self.assertEqual(broken["action"], "recheck")

    def test_detail_is_never_replaced(self):
        for state in ("unavailable", "blocked", "error"):
            with self.subTest(state=state):
                self.assertEqual(
                    registry.collapse_engine_state({"state": state, "detail": "the real reason"})["detail"],
                    "the real reason",
                )

    def test_an_unknown_state_is_not_silently_read_as_ready(self):
        self.assertEqual(
            registry.collapse_engine_state({"state": "banana", "detail": ""})["state"],
            "engine-error",
        )

    def test_operation_states_collapses_a_capabilities_report(self):
        collapsed = registry.collapse_operation_states({"operations": [
            {"kind": "crop_pages", "state": "ready", "detail": ""},
            {"kind": "add_text_layer", "state": "unavailable", "detail": "no tesseract"},
        ]})
        self.assertEqual(collapsed["crop_pages"]["state"], "ready")
        self.assertEqual(collapsed["add_text_layer"]["state"], "helper")
        self.assertEqual(collapsed["add_text_layer"]["detail"], "no tesseract")


if __name__ == "__main__":
    unittest.main()
