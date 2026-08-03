import threading
import time
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


class Phase3Tests(unittest.TestCase):
    def make_cbz(self, root: Path, members: dict[str, bytes]) -> Path:
        source = root / "book.cbz"
        with zipfile.ZipFile(source, "w") as archive:
            for name, payload in members.items():
                archive.writestr(name, payload)
        return source

    def test_cbr_epub_uses_extracted_files_without_repacking_cbz(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "book.cbr"
            output = root / "book.epub"

            def fake_extract(_source: Path, target: Path) -> None:
                (target / "page-10.jpg").write_bytes(JPEG_1X1)
                (target / "page-2.jpg").write_bytes(JPEG_1X1)

            with mock.patch.object(formats, "extract_with_7zip", side_effect=fake_extract):
                with mock.patch.object(
                    formats.cbz_to_epub,
                    "convert",
                    side_effect=AssertionError("CBR conversion repacked a temporary CBZ"),
                ):
                    count = formats.cbr_to_epub_convert(source, output, {}, lambda *_args: None)

            self.assertEqual(count, 2)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.namelist()[0], "mimetype")
                self.assertEqual(archive.getinfo("EPUB/images/0001.jpeg").compress_type, zipfile.ZIP_STORED)
                self.assertEqual(archive.getinfo("EPUB/images/0002.jpeg").compress_type, zipfile.ZIP_STORED)
                self.assertEqual(archive.testzip(), None)

    def test_cbz_epub_failure_preserves_existing_output_and_removes_partial(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_cbz(root, {"page.jpg": JPEG_1X1})
            output = root / "book.epub"
            previous = b"previous valid EPUB"
            output.write_bytes(previous)

            with mock.patch.object(cbz_to_epub, "make_page", side_effect=ValueError("page failed")):
                with self.assertRaisesRegex(ValueError, "page failed"):
                    cbz_to_epub.convert(source, output)

            self.assertEqual(output.read_bytes(), previous)
            self.assertFalse(Path(f"{output}.partial").exists())

    def test_pdf_page_ranges_are_bounded_and_cover_every_page(self):
        self.assertEqual(formats._pdf_page_ranges(7, 3), [(1, 3), (4, 6), (7, 7)])
        self.assertEqual(formats._pdf_page_ranges(1, 4), [(1, 1)])

    def test_pdf_worker_count_respects_cpu_and_memory_bounds(self):
        with mock.patch.object(formats.os, "cpu_count", return_value=128):
            with mock.patch.object(formats, "_available_memory_bytes", return_value=512 * 1024 * 1024):
                self.assertEqual(formats._pdf_worker_count(20), 2)
        self.assertEqual(formats._pdf_worker_count(1), 1)

    def test_pdf_to_cbz_uses_bounded_parallel_ranges_and_preserves_order(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "book.pdf"
            source.write_bytes(b"synthetic PDF")
            output = root / "book.cbz"
            active = 0
            peak = 0
            lock = threading.Lock()
            ranges = []

            def fake_render(_source, target, first, last, _dpi, _fmt):
                nonlocal active, peak
                with lock:
                    active += 1
                    peak = max(peak, active)
                    ranges.append((first, last))
                time.sleep(0.02)
                target.mkdir(parents=True, exist_ok=True)
                pages = []
                for page_number in range(first, last + 1):
                    page = target / f"page-{page_number:04d}.jpg"
                    page.write_bytes(JPEG_1X1)
                    pages.append(page)
                with lock:
                    active -= 1
                return pages

            with mock.patch.object(formats, "_pdf_page_count", return_value=5):
                with mock.patch.object(formats, "_pdf_worker_count", return_value=2):
                    with mock.patch.object(formats, "_render_pdf_range", side_effect=fake_render):
                        count = formats.pdf_to_cbz_convert(source, output, {"dpi": "72"}, lambda *_args: None)

            self.assertEqual(count, 5)
            self.assertLessEqual(peak, 2)
            self.assertEqual(sorted(ranges), [(1, 3), (4, 5)])
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.namelist(), [
                    "page-0001.jpg",
                    "page-0002.jpg",
                    "page-0003.jpg",
                    "page-0004.jpg",
                    "page-0005.jpg",
                ])
                self.assertTrue(all(info.compress_type == zipfile.ZIP_STORED for info in archive.infolist()))
                self.assertIsNone(archive.testzip())

    def test_pdf_to_cbz_uses_embedded_image_extraction_before_raster_fallback(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "book.pdf"
            source.write_bytes(b"synthetic PDF")
            output = root / "book.cbz"

            def fake_run(command, _what, **_kwargs):
                if Path(command[0]).stem.casefold() != "pdfimages":
                    raise AssertionError("unexpected helper call")
                prefix = Path(command[-1])
                prefix.parent.mkdir(parents=True, exist_ok=True)
                for index in range(2):
                    (prefix.parent / f"{prefix.name}-{index:03d}.jpg").write_bytes(JPEG_1X1)

            with mock.patch.object(formats, "_try_direct_pdf_to_cbz", return_value=None):
                with mock.patch.object(formats, "which", return_value="pdfimages.exe"):
                    with mock.patch.object(formats, "run", side_effect=fake_run):
                        with mock.patch.object(formats, "_pdf_page_count", return_value=2):
                            with mock.patch.object(formats, "_render_pdf_range", side_effect=AssertionError("raster fallback used")):
                                count = formats.pdf_to_cbz_convert(source, output, {}, lambda *_args: None)

            self.assertEqual(count, 2)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.namelist(), ["page-0001.jpg", "page-0002.jpg"])

    def test_direct_pdf_to_cbz_validates_and_writes_each_jpeg_once(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "book.pdf"
            source.write_bytes(b"synthetic PDF")
            output = root / "book.cbz"
            descriptors = [
                (0, len(JPEG_1X1), "page-0001.jpg"),
                (len(JPEG_1X1), len(JPEG_1X1), "page-0002.jpg"),
            ]

            class CountingMap:
                def __init__(self):
                    self.reads = 0

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return None

                def __getitem__(self, _slice):
                    self.reads += 1
                    return JPEG_1X1

            mapped = CountingMap()
            with mock.patch.object(formats, "_pdf_jpeg_ranges", return_value=descriptors):
                with mock.patch.object(formats.mmap, "mmap", return_value=mapped):
                    with mock.patch.object(formats, "_valid_extracted_jpeg", return_value=True):
                        count = formats._try_direct_pdf_to_cbz(source, output, lambda *_args: None)

            self.assertEqual(count, 2)
            self.assertEqual(mapped.reads, 2)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.namelist(), ["page-0001.jpg", "page-0002.jpg"])

    def test_pdf_to_cbz_failure_preserves_existing_output_and_removes_partial(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "book.pdf"
            source.write_bytes(b"synthetic PDF")
            output = root / "book.cbz"
            previous = b"previous valid CBZ"
            output.write_bytes(previous)

            def fail_render(_source, _target, first, _last, _dpi, _fmt):
                if first == 4:
                    raise ValueError("Poppler range failed")
                return []

            with mock.patch.object(formats, "_pdf_page_count", return_value=5):
                with mock.patch.object(formats, "_pdf_worker_count", return_value=2):
                    with mock.patch.object(formats, "_render_pdf_range", side_effect=fail_render):
                        with self.assertRaisesRegex(ValueError, "Poppler range failed"):
                            formats.pdf_to_cbz_convert(source, output, {}, lambda *_args: None)

            self.assertEqual(output.read_bytes(), previous)
            self.assertFalse(Path(f"{output}.partial").exists())

    def test_zip_files_failure_preserves_existing_output_and_removes_partial(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            first = root / "page.jpg"
            missing = root / "missing.jpg"
            first.write_bytes(JPEG_1X1)
            output = root / "archive.cbz"
            previous = b"previous valid CBZ"
            output.write_bytes(previous)

            with self.assertRaises(FileNotFoundError):
                formats.zip_files([first, missing], root, output, lambda *_args: None)

            self.assertEqual(output.read_bytes(), previous)
            self.assertFalse(Path(f"{output}.partial").exists())


if __name__ == "__main__":
    unittest.main()
