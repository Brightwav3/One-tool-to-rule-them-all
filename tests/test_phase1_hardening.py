import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "converter"))
import cbz_to_epub  # noqa: E402
import formats  # noqa: E402
from test_direct_pdf import JPEG_1X1  # noqa: E402


class Phase1HardeningTests(unittest.TestCase):
    def make_cbz(self, root: Path, members: dict[str, bytes]) -> Path:
        source = root / "book.cbz"
        with zipfile.ZipFile(source, "w") as archive:
            for name, payload in members.items():
                archive.writestr(name, payload)
        return source

    def test_archive_junk_is_filtered_but_cover_is_kept(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_cbz(
                root,
                {
                    "cover.jpg": JPEG_1X1,
                    "__MACOSX/._cover.jpg": JPEG_1X1,
                    ".hidden.jpg": JPEG_1X1,
                    "Thumbs.db": b"junk",
                    "zWater.jpg": JPEG_1X1,
                },
            )

            with zipfile.ZipFile(source) as archive:
                images = cbz_to_epub.list_images(archive)

            self.assertEqual([image.sort_name for image in images], ["cover.jpg"])

            extracted = root / "extracted"
            (extracted / "__MACOSX").mkdir(parents=True)
            (extracted / "cover.jpg").write_bytes(JPEG_1X1)
            (extracted / "zWater.jpg").write_bytes(JPEG_1X1)
            (extracted / "__MACOSX" / "._cover.jpg").write_bytes(JPEG_1X1)
            self.assertEqual(formats.images_in(extracted), [extracted / "cover.jpg"])

    def test_direct_pdf_failure_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_cbz(root, {"01.jpg": JPEG_1X1, "02.jpg": JPEG_1X1})
            output = root / "book.pdf"
            original = b"previous valid PDF"
            output.write_bytes(original)

            with mock.patch.object(
                formats,
                "_jpeg_metadata",
                side_effect=[(1, 1, "DeviceRGB"), ValueError("broken page")],
            ):
                with self.assertRaisesRegex(ValueError, "broken page"):
                    formats.cbz_to_pdf_convert(source, output, {}, lambda *_args: None)

            self.assertEqual(output.read_bytes(), original)
            self.assertFalse(Path(f"{output}.partial").exists())

    def test_cbz_epub_stores_image_media(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_cbz(root, {"cover.jpg": JPEG_1X1})
            output = root / "book.epub"
            cbz_to_epub.convert(source, output)

            with zipfile.ZipFile(output) as archive:
                self.assertEqual(
                    archive.getinfo("EPUB/images/0001.jpeg").compress_type,
                    zipfile.ZIP_STORED,
                )

    def test_epub_cbz_stores_image_media(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_cbz(root, {"cover.jpg": JPEG_1X1})
            epub = root / "book.epub"
            cbz_to_epub.convert(source, epub)
            output = root / "book.cbz"
            formats.epub_to_cbz_convert(epub, output, {}, lambda *_args: None)

            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.getinfo("0001.jpeg").compress_type, zipfile.ZIP_STORED)

    def test_zip_files_stores_images_and_deflates_other_files(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            image = root / "page.jpg"
            text = root / "notes.txt"
            image.write_bytes(JPEG_1X1)
            text.write_text("metadata", encoding="utf-8")
            output = root / "archive.zip"

            formats.zip_files([image, text], root, output, lambda *_args: None)

            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.getinfo("page.jpg").compress_type, zipfile.ZIP_STORED)
                self.assertEqual(archive.getinfo("notes.txt").compress_type, zipfile.ZIP_DEFLATED)

    def test_pdf_fallback_limits_only_multi_page_jobs(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            first = root / "01.webp"
            second = root / "02.webp"
            first.write_bytes(b"page")
            second.write_bytes(b"page")

            def fake_magick(command, _total, _progress, cwd=None):
                del cwd
                Path(command[-1]).write_bytes(b"PDF")

            with mock.patch.object(formats, "find_magick", return_value="magick.exe"):
                with mock.patch.object(formats, "run_magick_pdf", side_effect=fake_magick):
                    multi_output = root / "multi.pdf"
                    formats.images_to_pdf_convert([first, second], multi_output, {}, lambda *_args: None)
                    single_output = root / "single.pdf"
                    formats.images_to_pdf_convert([first], single_output, {}, lambda *_args: None)

            self.assertTrue(multi_output.is_file())
            self.assertTrue(single_output.is_file())

            with mock.patch.object(formats, "find_magick", return_value="magick.exe"):
                multi_command = formats.magick_command(
                    ["01.webp", "02.webp", "multi.pdf"], limit_resources=True
                )
                single_command = formats.magick_command(["01.webp", "single.pdf"])
            self.assertIn("-limit", multi_command)
            self.assertIn("thread", multi_command)
            self.assertIn("memory", multi_command)
            self.assertIn("map", multi_command)
            self.assertNotIn("-limit", single_command)

    def test_pdf_fallback_has_no_30000_character_guard(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            page = root / "page.webp"
            page.write_bytes(b"page")
            output = root / "output.pdf"

            with mock.patch.object(formats, "find_magick", return_value="magick.exe"):
                with mock.patch.object(formats, "shorten_page_arguments", return_value=(None, ["x" * 30001])):
                    with mock.patch.object(
                        formats,
                        "run_magick_pdf",
                        side_effect=lambda command, _total, _progress, cwd=None: Path(command[-1]).write_bytes(b"PDF"),
                    ):
                        formats.images_to_pdf_convert([page], output, {}, lambda *_args: None)

            self.assertEqual(output.read_bytes(), b"PDF")


if __name__ == "__main__":
    unittest.main()
