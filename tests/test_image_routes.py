import binascii
import struct
import tempfile
import unittest
import zlib
import zipfile
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "converter"))
import formats  # noqa: E402


def png_1x1() -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        checksum = binascii.crc32(kind + payload) & 0xFFFFFFFF
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", checksum)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
        + chunk(b"IEND", b"")
    )


class ImageRouteTests(unittest.TestCase):
    def test_common_image_routes_are_declared(self):
        for converter_id in ("png-jpg", "png-pdf", "jpg-pdf"):
            with self.subTest(converter_id=converter_id):
                converter = formats.REGISTRY.get(converter_id)
                self.assertIsNotNone(converter)
                self.assertIsNotNone(converter.convert)

        self.assertEqual(formats.REGISTRY.get("png-jpg").extensions, (".png",))
        self.assertEqual(formats.REGISTRY.get("png-jpg").ext, ".jpg")

    def test_intuitive_edges_between_existing_formats_are_declared(self):
        expected = {
            "heic-png": (".png", (".heic", ".heif")),
            "heic-webp": (".webp", (".heic", ".heif")),
            "heic-pdf": (".pdf", (".heic", ".heif")),
            "webp-pdf": (".pdf", (".webp",)),
            "svg-jpg": (".jpg", (".svg",)),
            "svg-pdf": (".pdf", (".svg",)),
            "cbr-cbz": (".cbz", (".cbr",)),
            "rar-cbz": (".cbz", (".rar",)),
            "7z-cbz": (".cbz", (".7z",)),
            "epub-txt": (".txt", (".epub",)),
            "azw3-pdf": (".pdf", (".azw3",)),
            "pdf-epub": (".epub", (".pdf",)),
        }

        for converter_id, (output_extension, input_extensions) in expected.items():
            with self.subTest(converter_id=converter_id):
                converter = formats.REGISTRY.get(converter_id)
                self.assertIsNotNone(converter)
                self.assertIsNotNone(converter.convert)
                self.assertEqual(converter.ext, output_extension)
                self.assertEqual(converter.extensions, input_extensions)

    @unittest.skipUnless(formats.find_magick() or formats.FFMPEG.locate(), "an image encoder is required")
    def test_png_to_jpg_writes_a_real_jpeg(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "source.png"
            output = root / "converted.jpg"
            source.write_bytes(png_1x1())

            count = formats.raster_image_convert(source, output, {"quality": "90"}, lambda *_args: None)

            self.assertEqual(count, 1)
            self.assertTrue(output.is_file())
            self.assertEqual(formats._jpeg_metadata(output.read_bytes())[:2], (1, 1))

    def test_newly_added_raster_and_pdf_page_routes_are_declared(self):
        expected = {
            "pdf-jpg": (".jpg", (".pdf",)),
            "pdf-png": (".png", (".pdf",)),
            "gif-jpg": (".jpg", (".gif",)),
            "gif-png": (".png", (".gif",)),
            "gif-pdf": (".pdf", (".gif",)),
            "avif-jpg": (".jpg", (".avif",)),
            "avif-png": (".png", (".avif",)),
            "avif-pdf": (".pdf", (".avif",)),
            "bmp-jpg": (".jpg", (".bmp",)),
            "bmp-png": (".png", (".bmp",)),
            "bmp-pdf": (".pdf", (".bmp",)),
            "tiff-jpg": (".jpg", (".tiff", ".tif")),
            "tiff-png": (".png", (".tiff", ".tif")),
            "tiff-pdf": (".pdf", (".tiff", ".tif")),
        }

        for converter_id, (output_extension, input_extensions) in expected.items():
            with self.subTest(converter_id=converter_id):
                converter = formats.REGISTRY.get(converter_id)
                self.assertIsNotNone(converter)
                self.assertIsNotNone(converter.convert)
                self.assertEqual(converter.ext, output_extension)
                self.assertEqual(converter.extensions, input_extensions)

    def test_pdf_page_routes_offer_a_page_choice(self):
        for converter_id in ("pdf-jpg", "pdf-png"):
            with self.subTest(converter_id=converter_id):
                keys = [option.key for option in formats.REGISTRY.get(converter_id).options]
                self.assertEqual(keys, ["page", "dpi"])

    def test_pdf_page_selection_is_validated_before_any_rendering(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "doc.pdf"
            source.write_bytes(b"%PDF-1.4\n")

            for bad_page in ("0", "-2", "one", ""):
                with self.subTest(page=bad_page):
                    with self.assertRaises(ValueError) as caught:
                        formats.pdf_to_image_convert(
                            source, root / "page.png", {"page": bad_page or "0", "dpi": "150"}, lambda *_args: None
                        )
                    self.assertIn("positive whole number", str(caught.exception))

    def test_multi_frame_sources_are_read_as_a_single_frame(self):
        # Left alone ImageMagick writes one numbered file per frame, so these
        # suffixes must be recognised or the single expected output never lands.
        for suffix in (".gif", ".tif", ".tiff", ".avif"):
            with self.subTest(suffix=suffix):
                self.assertIn(suffix, formats.MULTI_FRAME_SUFFIXES)

    def test_epub_to_txt_extracts_readable_text(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "book.epub"
            output = root / "book.txt"
            with zipfile.ZipFile(source, "w") as archive:
                archive.writestr(
                    "OEBPS/chapter.xhtml",
                    "<html><body><h1>Chapter one</h1><p>Hello, reader.</p></body></html>",
                )

            formats.epub_to_txt_convert(source, output, {}, lambda *_args: None)

            self.assertEqual(output.read_text(encoding="utf-8").splitlines(), ["Chapter one", "Hello, reader."])


if __name__ == "__main__":
    unittest.main()
