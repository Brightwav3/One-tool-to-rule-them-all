import base64
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "converter"))
import formats  # noqa: E402


JPEG_1X1 = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z"
)


def png_1x1() -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", __import__("binascii").crc32(kind + payload) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", __import__("zlib").compress(b"\x00\xff\x00\x00"))
        + chunk(b"IEND", b"")
    )


class DirectPdfTests(unittest.TestCase):
    def make_cbz(self, root: Path, members: dict[str, bytes]) -> Path:
        source = root / "book.cbz"
        with zipfile.ZipFile(source, "w") as archive:
            for name, payload in members.items():
                archive.writestr(name, payload)
        return source

    def test_jpeg_pages_bypass_imagemagick_and_preserve_payloads(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_cbz(root, {"page-001.jpg": JPEG_1X1, "page-002.jpg": JPEG_1X1 + b"\n"})
            output = root / "book.pdf"
            with mock.patch.object(formats, "find_magick", side_effect=AssertionError("ImageMagick used")):
                formats.cbz_to_pdf_convert(source, output, {}, lambda *_args: None)

            data = output.read_bytes()
            self.assertTrue(data.startswith(b"%PDF-"))
            self.assertTrue(data.rstrip().endswith(b"%%EOF"))
            self.assertEqual(data.count(b"/Type /Page /Parent"), 2)
            self.assertIn(JPEG_1X1, data)

    @unittest.skipUnless(formats.find_magick(), "ImageMagick is required for PNG conversion")
    def test_png_pages_are_converted_then_written_by_direct_pdf_writer(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_cbz(root, {"page-001.png": png_1x1()})
            output = root / "book.pdf"
            with mock.patch.object(formats, "images_to_pdf_convert", side_effect=AssertionError("fallback used")):
                formats.cbz_to_pdf_convert(source, output, {}, lambda *_args: None)

            data = output.read_bytes()
            self.assertEqual(data.count(b"/Type /Page /Parent"), 1)
            self.assertNotIn(b"\x89PNG\r\n\x1a\n", data)

    @unittest.skipUnless(formats.find_magick(), "ImageMagick is required for mixed PNG conversion")
    def test_mixed_jpeg_and_png_pages_share_the_direct_writer(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_cbz(root, {"page-001.jpg": JPEG_1X1, "page-002.png": png_1x1()})
            output = root / "book.pdf"
            with mock.patch.object(formats, "images_to_pdf_convert", side_effect=AssertionError("fallback used")):
                formats.cbz_to_pdf_convert(source, output, {}, lambda *_args: None)

            data = output.read_bytes()
            self.assertEqual(data.count(b"/Type /Page /Parent"), 2)
            self.assertIn(JPEG_1X1, data)

    def test_standalone_png_uses_safe_flate_embedding_without_imagemagick(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "page.png"
            source.write_bytes(png_1x1())
            output = root / "page.pdf"

            with mock.patch.object(formats, "find_magick", side_effect=AssertionError("ImageMagick used")):
                formats.image_to_pdf_convert(source, output, {}, lambda *_args: None)

            data = output.read_bytes()
            self.assertIn(b"/Filter /FlateDecode", data)
            self.assertIn(b"/Predictor 15", data)
            self.assertNotIn(b"/Filter /DCTDecode", data)

    def test_standalone_jpeg_uses_direct_writer(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "page.jpg"
            source.write_bytes(JPEG_1X1)
            output = root / "page.pdf"

            with mock.patch.object(formats, "images_to_pdf_convert", side_effect=AssertionError("fallback used")):
                formats.image_to_pdf_convert(source, output, {}, lambda *_args: None)

            self.assertIn(b"/Filter /DCTDecode", output.read_bytes())

    def test_progressive_jpeg_sof_is_accepted_by_direct_writer(self):
        progressive = JPEG_1X1.replace(b"\xff\xc0", b"\xff\xc2", 1)
        self.assertEqual(formats._jpeg_metadata(progressive)[:2], (1, 1))
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "progressive.jpg"
            source.write_bytes(progressive)
            output = root / "progressive.pdf"
            formats.image_to_pdf_convert(source, output, {}, lambda *_args: None)
            self.assertIn(b"/Filter /DCTDecode", output.read_bytes())

    def test_cmyk_jpeg_gets_inverting_decode_array(self):
        cmyk = JPEG_1X1.replace(b"\xff\xc0", b"\xff\xc0", 1)
        sof = cmyk.index(b"\xff\xc0")
        component_count = sof + 9
        cmyk = cmyk[:component_count] + b"\x04" + cmyk[component_count + 1:]
        adobe = b"\xff\xee\x00\x0eAdobe\x00d\x00\x00\x00\x00\x00\x00"
        cmyk = cmyk[:2] + adobe + cmyk[2:]
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "cmyk.jpg"
            source.write_bytes(cmyk)
            output = root / "cmyk.pdf"
            formats.image_to_pdf_convert(source, output, {}, lambda *_args: None)
            data = output.read_bytes()
            self.assertIn(b"/ColorSpace /DeviceCMYK", data)
            self.assertIn(b"/Decode [1 0 1 0 1 0 1 0]", data)

    def test_mixed_comic_fallback_rasterizes_each_non_direct_page_once(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_cbz(root, {"page-001.jpg": JPEG_1X1, "page-002.webp": b"webp"})
            output = root / "book.pdf"
            with mock.patch.object(formats, "_image_to_jpeg", return_value=JPEG_1X1) as rasterize:
                formats.cbz_to_pdf_convert(source, output, {}, lambda *_args: None)
            rasterize.assert_called_once()
            self.assertEqual(output.read_bytes().count(b"/Type /Page /Parent"), 2)


if __name__ == "__main__":
    unittest.main()
