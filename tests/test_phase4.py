import base64
import json
import os
import shutil
import struct
import subprocess
import tempfile
import time
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


class Phase4Tests(unittest.TestCase):
    def make_cbz(self, root: Path, members: dict[str, bytes], title: str = "Book", creator: str = "Author") -> Path:
        source = root / "book.cbz"
        with zipfile.ZipFile(source, "w") as archive:
            for name, payload in members.items():
                archive.writestr(name, payload)
        return source

    def make_direct_pdf(self, root: Path) -> Path:
        output = root / "scan.pdf"
        pages = [
            formats.PdfPageSource("page-2.jpg", ".jpg", lambda: JPEG_1X1),
            formats.PdfPageSource("page-10.jpg", ".jpg", lambda: JPEG_1X1),
        ]
        formats.write_direct_pdf(pages, output)
        return output

    def test_scan_style_pdf_extracts_jpegs_without_poppler_and_preserves_order(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_direct_pdf(root)
            output = root / "scan.cbz"
            progress = []

            with mock.patch.object(formats, "_pdf_page_count", side_effect=AssertionError("raster fallback used")):
                with mock.patch.object(formats, "_render_pdf_range", side_effect=AssertionError("raster fallback used")):
                    count = formats.pdf_to_cbz_convert(source, output, {}, lambda *args: progress.append(args))

            self.assertEqual(count, 2)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.namelist(), ["page-0001.jpg", "page-0002.jpg"])
                self.assertEqual(archive.read("page-0001.jpg"), JPEG_1X1)
                self.assertEqual(archive.read("page-0002.jpg"), JPEG_1X1)
            self.assertEqual(progress[-1][:2], (2, 2))

    def test_malformed_xref_falls_back_and_never_writes_direct_output(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_direct_pdf(root)
            data = source.read_bytes()
            marker = b"startxref\n"
            offset = data.index(marker) + len(marker)
            end = data.index(b"\n", offset)
            source.write_bytes(data[:offset] + b"0" + data[end:])
            output = root / "scan.cbz"
            previous = b"previous valid CBZ"
            output.write_bytes(previous)

            def fake_render(_source, target, first, last, _dpi, _fmt):
                target.mkdir(parents=True, exist_ok=True)
                page = target / f"page-{first:04d}.jpg"
                page.write_bytes(JPEG_1X1)
                return [page]

            with mock.patch.object(formats, "_pdf_page_count", return_value=1):
                with mock.patch.object(formats, "_render_pdf_range", side_effect=fake_render):
                    formats.pdf_to_cbz_convert(source, output, {}, lambda *_args: None)

            self.assertNotEqual(output.read_bytes(), previous)
            self.assertFalse(Path(f"{output}.partial").exists())
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.read("page-0001.jpg"), JPEG_1X1)

    def test_invalid_extracted_jpeg_falls_back_before_output_is_committed(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "invalid.pdf"
            source.write_bytes(b"not a PDF")
            output = root / "scan.cbz"
            previous = b"previous valid CBZ"
            output.write_bytes(previous)
            with mock.patch.object(formats, "_pdf_page_count", return_value=1):
                with mock.patch.object(formats, "_render_pdf_range", return_value=[]):
                    with self.assertRaisesRegex(ValueError, "no pages were rendered"):
                        formats.pdf_to_cbz_convert(source, output, {}, lambda *_args: None)
            self.assertEqual(output.read_bytes(), previous)
            self.assertFalse(Path(f"{output}.partial").exists())

    def test_image_only_epub_uses_direct_pdf_writer_and_keeps_metadata(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_cbz(root, {"page-1.jpg": JPEG_1X1}, title="Tiny Book", creator="Jane Doe")
            epub = root / "book.epub"
            cbz_to_epub.convert(source, epub, title="Tiny Book", creator="Jane Doe")
            output = root / "book.pdf"

            with mock.patch.object(formats, "calibre_convert", side_effect=AssertionError("Calibre used")):
                count = formats.epub_to_pdf_convert(epub, output, {}, lambda *_args: None)

            self.assertEqual(count, 1)
            data = output.read_bytes()
            self.assertTrue(data.startswith(b"%PDF-"))
            self.assertIn(b"Tiny Book", data)
            self.assertIn(b"Jane Doe", data)
            self.assertIn(JPEG_1X1, data)

    def test_non_image_epub_uses_safe_calibre_fallback(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "text.epub"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr("mimetype", "application/epub+zip")
                archive.writestr("META-INF/container.xml", "<container/>")
            output = root / "text.pdf"
            with mock.patch.object(formats, "calibre_convert", return_value=1) as fallback:
                self.assertEqual(formats.epub_to_pdf_convert(source, output, {}, lambda *_args: None), 1)
            fallback.assert_called_once()

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for persistent worker tests")
    def test_pdf_markdown_worker_reuses_process_and_isolates_failures(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            script = root / "fake-worker.cjs"
            script.write_text(
                "const fs=require('node:fs');\n"
                "let line; process.stdin.setEncoding('utf8'); let buf='';\n"
                "process.stdin.on('data', chunk => { buf += chunk; while ((line=buf.indexOf('\\n')) >= 0) { const msg=JSON.parse(buf.slice(0,line)); buf=buf.slice(line+1); if (msg.inputPath.includes('fail')) { process.stdout.write(JSON.stringify({ok:false,error:'expected failure'})+'\\n'); } else { fs.writeFileSync(msg.outputPath, 'markdown for '+msg.inputPath+'\\n'); process.stdout.write(JSON.stringify({ok:true,pageCount:1})+'\\n'); } } });\n",
                encoding="utf-8",
            )
            worker = formats.PdfMarkdownWorker(shutil.which("node"), script)
            first = root / "first.pdf"
            failed = root / "fail.pdf"
            second = root / "second.pdf"
            for path in (first, failed, second):
                path.write_bytes(b"pdf")
            (root / "fail.md").write_text("previous valid markdown\n", encoding="utf-8")
            try:
                worker.convert(first, root / "first.md", lambda *_args: None)
                process_id = worker.process.pid
                with self.assertRaisesRegex(ValueError, "expected failure"):
                    worker.convert(failed, root / "fail.md", lambda *_args: None)
                self.assertEqual((root / "fail.md").read_text(encoding="utf-8"), "previous valid markdown\n")
                worker.convert(second, root / "second.md", lambda *_args: None)
                self.assertEqual(worker.process.pid, process_id)
                self.assertEqual((root / "second.md").read_text(encoding="utf-8"), "markdown for " + str(second) + "\n")
            finally:
                worker.close()

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for persistent worker tests")
    def test_pdf_markdown_worker_restarts_after_process_failure(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            script = root / "restart-worker.cjs"
            script.write_text(
                "const fs=require('node:fs'); let buf=''; process.stdin.setEncoding('utf8');\n"
                "process.stdin.on('data', chunk => { buf += chunk; while (buf.includes('\\n')) { const i=buf.indexOf('\\n'); const msg=JSON.parse(buf.slice(0,i)); buf=buf.slice(i+1); fs.writeFileSync(msg.outputPath, 'ok\\n'); process.stdout.write(JSON.stringify({ok:true})+'\\n'); } });\n",
                encoding="utf-8",
            )
            worker = formats.PdfMarkdownWorker(shutil.which("node"), script)
            source = root / "source.pdf"
            source.write_bytes(b"pdf")
            try:
                worker.convert(source, root / "one.md", lambda *_args: None)
                old_pid = worker.process.pid
                worker.process.kill()
                worker.convert(source, root / "two.md", lambda *_args: None)
                self.assertNotEqual(worker.process.pid, old_pid)
                self.assertEqual((root / "two.md").read_text(encoding="utf-8"), "ok\n")
            finally:
                worker.close()


if __name__ == "__main__":
    unittest.main()
