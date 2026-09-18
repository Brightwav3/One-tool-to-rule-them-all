"""Focused tests for CBZ-related conversion bugs."""

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


class CbzRouteTests(unittest.TestCase):
    def test_cbz_pdf_is_ready_without_imagemagick(self):
        converter = formats.REGISTRY.get("cbz-pdf")
        self.assertIsNone(converter.helper)
        self.assertEqual(converter.state(), "ready")

    def test_pdf_cbz_is_ready_without_poppler(self):
        converter = formats.REGISTRY.get("pdf-cbz")
        self.assertIsNone(converter.helper)
        self.assertEqual(converter.state(), "ready")

    def test_cbr_pdf_requires_7zip_but_not_imagemagick(self):
        converter = formats.REGISTRY.get("cbr-pdf")
        self.assertIs(converter.helper, formats.SEVEN_ZIP)
        self.assertEqual(converter.requirements, ())
        self.assertNotIn(formats.IMAGEMAGICK, converter.requirements)

    def test_convert_paths_keeps_caller_order(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            later = root / "page-10.jpg"
            earlier = root / "page-2.jpg"
            first_page = JPEG_1X1
            second_page = JPEG_1X1 + b"\n"
            later.write_bytes(first_page)
            earlier.write_bytes(second_page)
            output = root / "book.epub"

            cbz_to_epub.convert_paths([later, earlier], output, title="Order")

            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.read("EPUB/images/0001.jpeg"), first_page)
                self.assertEqual(archive.read("EPUB/images/0002.jpeg"), second_page)

    def test_comic_repack_sorts_pages_and_drops_junk(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "book.cbr"
            source.write_bytes(b"not-a-zip")
            output = root / "book.cbz"

            def fake_extract(_source: Path, target: Path, password: str = "") -> None:
                del password
                (target / "__MACOSX").mkdir()
                (target / "__MACOSX" / "._page-2.jpg").write_bytes(JPEG_1X1)
                (target / "chapter").mkdir()
                (target / "chapter" / "page-10.jpg").write_bytes(JPEG_1X1)
                (target / "chapter" / "page-2.jpg").write_bytes(JPEG_1X1)
                (target / "Thumbs.db").write_bytes(b"junk")
                (target / "ComicInfo.xml").write_bytes(b"<ComicInfo/>")

            with mock.patch.object(formats, "extract_with_7zip", side_effect=fake_extract):
                count = formats.comic_repack_convert(source, output, {}, lambda *_args: None)

            self.assertEqual(count, 3)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(
                    archive.namelist(),
                    ["chapter/page-2.jpg", "chapter/page-10.jpg", "ComicInfo.xml"],
                )
                self.assertTrue(all(
                    info.compress_type == zipfile.ZIP_STORED
                    for info in archive.infolist()
                    if info.filename.endswith(".jpg")
                ))

    def test_unreadable_cbz_falls_back_to_7zip_extract(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "renamed.cbz"
            source.write_bytes(b"Rar!\x1a\x07\x00")
            output = root / "book.epub"

            def fake_extract(_source: Path, target: Path, password: str = "") -> None:
                del password
                (target / "page-2.jpg").write_bytes(JPEG_1X1)
                (target / "page-10.jpg").write_bytes(JPEG_1X1)

            with mock.patch.object(formats, "extract_with_7zip", side_effect=fake_extract):
                count = formats.cbz_to_epub_convert(source, output, {}, lambda *_args: None)

            self.assertEqual(count, 2)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.getinfo("EPUB/images/0001.jpeg").compress_type, zipfile.ZIP_STORED)

    def test_unreadable_cbz_without_7zip_explains_the_real_problem(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "renamed.cbz"
            source.write_bytes(b"Rar!\x1a\x07\x00")
            output = root / "book.epub"

            with mock.patch.object(formats, "which", side_effect=ValueError("none of 7z, 7za, 7zz was found on this machine")):
                with self.assertRaisesRegex(ValueError, "renamed CBR"):
                    formats.cbz_to_epub_convert(source, output, {}, lambda *_args: None)

    def test_queueing_cbz_pdf_without_imagemagick_stays_idle(self):
        import server  # noqa: WPS433

        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "book.cbz"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("page.jpg", JPEG_1X1)
            job = server.Job("1", source, formats.REGISTRY.get("cbz-pdf"), output_folder=root)
            self.assertEqual(job.status, "idle", job.error)
            self.assertEqual(job.error_title, "")

    def test_cbr_cbz_and_rar_cbz_use_the_comic_repack(self):
        for converter_id in ("cbr-cbz", "rar-cbz", "7z-cbz"):
            with self.subTest(converter_id=converter_id):
                converter = formats.REGISTRY.get(converter_id)
                self.assertIs(converter.convert, formats.comic_repack_convert)


if __name__ == "__main__":
    unittest.main()
