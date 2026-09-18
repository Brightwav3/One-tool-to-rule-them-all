#!/usr/bin/env python3
"""Direct JPEG/PNG PDF embed and JPEG-from-PDF extract.

Stdlib-first kernel used by comic, image, EPUB and Creator routes in formats.py.
formats.py re-exports these names so `import formats` and test patches on the
facade keep working. This module must not import formats at load time.
"""

from __future__ import annotations

import binascii
import mmap
import os
import re
import subprocess
import sys
import zipfile
import zlib
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

JPEG_SUFFIXES = {".jpg", ".jpeg"}
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def _facade(name: str):
    """Use the formats.py binding when tests have patched it."""
    local = globals()[name]
    facade = sys.modules.get("formats")
    if facade is None:
        return local
    return facade.__dict__.get(name, local)


def _partial_output_path(out: Path) -> Path:
    partial = Path(f"{out}.partial")
    partial.unlink(missing_ok=True)
    return partial


def _discard_partial(partial: Path) -> None:
    try:
        partial.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


@contextmanager
def _atomic_output(out: Path):
    partial = _partial_output_path(out)
    try:
        yield partial
        os.replace(partial, out)
    except Exception:
        _discard_partial(partial)
        raise


@dataclass(frozen=True)
class PdfPageSource:
    """A lazily-read page used by the direct PDF writer."""

    name: str
    suffix: str
    read: Callable[[], bytes]


PageSource = PdfPageSource


@dataclass(frozen=True)
class _PdfStream:
    dictionary: bytes
    offset: int
    length: int


class _DirectPdfNotSafe(ValueError):
    """The PDF is valid enough to try rasterization, but not direct copying."""


def _pdf_line(data, cursor: int) -> tuple[bytes, int] | None:
    if cursor >= len(data):
        return None
    end = data.find(b"\n", cursor)
    if end < 0:
        return data[cursor:], len(data)
    line = data[cursor:end]
    if line.endswith(b"\r"):
        line = line[:-1]
    return line, end + 1


def _pdf_xref(data) -> dict[int, int] | None:
    """Read only a classic xref table with strict bounds checks."""
    marker = data.rfind(b"startxref")
    if marker < 0:
        return None
    cursor_after_marker = marker + len(b"startxref")
    while cursor_after_marker < len(data) and data[cursor_after_marker] in b" \t\r\n":
        cursor_after_marker += 1
    line = _pdf_line(data, cursor_after_marker)
    if not line:
        return None
    raw_offset = line[0].strip()
    if not raw_offset.isdigit():
        return None
    xref_offset = int(raw_offset)
    if xref_offset < 0 or xref_offset >= len(data) or data[xref_offset:xref_offset + 4] != b"xref":
        return None

    entries: dict[int, int] = {}
    cursor = xref_offset + 4
    while True:
        item = _pdf_line(data, cursor)
        if not item:
            return None
        line, cursor = item
        stripped = line.strip()
        if not stripped:
            continue
        if stripped == b"trailer":
            break
        parts = stripped.split()
        if len(parts) != 2 or not all(part.isdigit() for part in parts):
            return None
        first, count = map(int, parts)
        if count < 1 or count > 10_000_000:
            return None
        for number in range(first, first + count):
            item = _pdf_line(data, cursor)
            if not item:
                return None
            entry, cursor = item
            match = re.fullmatch(rb"(\d{10})\s+(\d{5})\s+([nf])\s*", entry)
            if not match:
                return None
            offset, generation, state = int(match.group(1)), int(match.group(2)), match.group(3)
            if state == b"n":
                if generation != 0 or offset >= len(data):
                    return None
                entries[number] = offset

    trailer_end = data.find(b"startxref", cursor)
    if trailer_end < 0:
        return None
    trailer = data[cursor:trailer_end]
    if b"/Prev" in trailer or b"/XRefStm" in trailer:
        return None
    root = re.search(rb"/Root\s+(\d+)\s+0\s+R\b", trailer)
    if not root or int(root.group(1)) not in entries:
        return None
    entries[-1] = int(root.group(1))
    return entries


def _pdf_object(data, offsets: dict[int, int], number: int) -> tuple[bytes, _PdfStream | None] | None:
    offset = offsets.get(number)
    if offset is None or offset < 0 or offset >= len(data):
        return None
    header = re.match(rb"(\d+)\s+(\d+)\s+obj(?:\s|\r?\n)", data[offset:offset + 64])
    if not header or int(header.group(1)) != number or int(header.group(2)) != 0:
        return None
    body_start = offset + header.end()
    end = data.find(b"endobj", body_start)
    if end < 0:
        return None
    stream_marker = data.find(b"stream", body_start, end)
    if stream_marker < 0:
        return data[body_start:end], None
    dictionary = data[body_start:stream_marker]
    length_match = re.search(rb"/Length\s+(\d+)\b", dictionary)
    if not length_match:
        return None
    length = int(length_match.group(1))
    stream_start = stream_marker + len(b"stream")
    if data[stream_start:stream_start + 2] == b"\r\n":
        stream_start += 2
    elif data[stream_start:stream_start + 1] in (b"\n", b"\r"):
        stream_start += 1
    stream_end = stream_start + length
    if length < 0 or stream_end > end:
        return None
    endstream = data[stream_end:stream_end + len(b"\nendstream")]
    if not (endstream.startswith(b"\nendstream") or endstream.startswith(b"\rendstream") or endstream.startswith(b"endstream")):
        return None
    return dictionary, _PdfStream(dictionary, stream_start, length)


def _pdf_ref(body: bytes, key: bytes) -> int | None:
    match = re.search(rb"/" + re.escape(key) + rb"\s+(\d+)\s+0\s+R\b", body)
    return int(match.group(1)) if match else None


def _pdf_inline_dictionary(body: bytes, key: bytes) -> bytes | None:
    match = re.search(rb"/" + re.escape(key) + rb"\s*<<(.*?)>>", body, re.DOTALL)
    return match.group(1) if match else None


def _pdf_stream_filter(dictionary: bytes) -> str | None:
    if re.search(rb"/Filter\s*\[", dictionary):
        return None
    match = re.search(rb"/Filter\s*/([A-Za-z0-9]+)", dictionary)
    return match.group(1).decode("ascii") if match else ""


def _pdf_page_references(data, offsets: dict[int, int]) -> list[int] | None:
    root_number = offsets.get(-1)
    root = _pdf_object(data, offsets, root_number) if root_number is not None else None
    if not root:
        return None
    catalog = root[0]
    pages_number = _pdf_ref(catalog, b"Pages")
    if pages_number is None:
        return None
    result: list[int] = []
    visiting: set[int] = set()

    def walk(number: int) -> bool:
        if number in visiting:
            return False
        visiting.add(number)
        item = _pdf_object(data, offsets, number)
        if not item:
            return False
        body = item[0]
        if re.search(rb"/Type\s*/Page\b", body):
            result.append(number)
            visiting.remove(number)
            return True
        if not re.search(rb"/Type\s*/Pages\b", body):
            return False
        kids = re.search(rb"/Kids\s*\[(.*?)\]", body, re.DOTALL)
        if not kids:
            return False
        refs = [int(value) for value in re.findall(rb"(\d+)\s+0\s+R\b", kids.group(1))]
        if not refs or not all(walk(child) for child in refs):
            return False
        visiting.remove(number)
        return True

    return result if walk(pages_number) and result else None


def _pdf_content_is_image_only(data, offsets: dict[int, int], page_body: bytes, image_name: bytes) -> bool:
    contents_number = _pdf_ref(page_body, b"Contents")
    if contents_number is None:
        return False
    item = _pdf_object(data, offsets, contents_number)
    if not item or not item[1]:
        return False
    dictionary, stream = item
    filter_name = _pdf_stream_filter(dictionary)
    if filter_name == "":
        content = data[stream.offset:stream.offset + stream.length]
    elif filter_name == "FlateDecode":
        try:
            content = zlib.decompress(data[stream.offset:stream.offset + stream.length])
        except zlib.error:
            return False
    else:
        return False
    image_token = image_name if image_name.startswith(b"/") else b"/" + image_name
    tokens = re.findall(rb"/[A-Za-z0-9_.+-]+|[-+]?(?:\d+(?:\.\d*)?|\.\d+)|q|Q|cm|Do", content)
    if not tokens or b"".join(re.sub(rb"\s+", b"", token) for token in tokens) != re.sub(rb"\s+", b"", content):
        return False
    return tokens.count(b"Do") == 1 and tokens.count(image_token) == 1 and all(
        token in {b"q", b"Q", b"cm", b"Do", image_token} or re.fullmatch(rb"[-+]?(?:\d+(?:\.\d*)?|\.\d+)", token)
        for token in tokens
    )


def _pdf_jpeg_ranges(source: Path) -> list[tuple[int, int, str]] | None:
    if source.stat().st_size < 32:
        return None
    with source.open("rb") as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
        offsets = _pdf_xref(data)
        if not offsets:
            return None
        pages = _pdf_page_references(data, offsets)
        if not pages:
            return None
        descriptors: list[tuple[int, int, str]] = []
        for page_number, page_ref in enumerate(pages, start=1):
            page_item = _pdf_object(data, offsets, page_ref)
            if not page_item:
                return None
            page_body = page_item[0]
            resources_number = _pdf_ref(page_body, b"Resources")
            resources_item = _pdf_object(data, offsets, resources_number) if resources_number else None
            resources = resources_item[0] if resources_item else page_body
            xobject_dict = _pdf_inline_dictionary(resources, b"XObject")
            if xobject_dict is None:
                return None
            xobjects = re.findall(rb"/(\S+)\s+(\d+)\s+0\s+R\b", xobject_dict)
            images = []
            for raw_name, raw_ref in xobjects:
                item = _pdf_object(data, offsets, int(raw_ref))
                if not item or not item[1]:
                    continue
                dictionary, stream = item
                if re.search(rb"/Subtype\s*/Image\b", dictionary) and _pdf_stream_filter(dictionary) == "DCTDecode":
                    images.append((raw_name, stream))
            if len(images) != 1:
                return None
            image_name, image_stream = images[0]
            if not _pdf_content_is_image_only(data, offsets, page_body, image_name):
                return None
            if not re.search(rb"/Width\s+\d+\b", image_stream.dictionary) or not re.search(rb"/Height\s+\d+\b", image_stream.dictionary):
                return None
            descriptors.append((image_stream.offset, image_stream.length, f"page-{page_number:04d}.jpg"))
        return descriptors


def _valid_extracted_jpeg(data: bytes) -> bool:
    if not data.startswith(b"\xff\xd8") or not data.rstrip().endswith(b"\xff\xd9"):
        return False
    try:
        _jpeg_metadata(data)
    except ValueError:
        return False
    return True


def _try_direct_pdf_to_cbz(source: Path, out: Path, progress) -> int | None:
    descriptors = _facade("_pdf_jpeg_ranges")(source)
    if not descriptors:
        return None
    with source.open("rb") as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
        try:
            with _atomic_output(out) as partial:
                with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    for index, (offset, length, name) in enumerate(descriptors, start=1):
                        image = data[offset:offset + length]
                        if not _facade("_valid_extracted_jpeg")(image):
                            raise _DirectPdfNotSafe
                        info = zipfile.ZipInfo(name)
                        info.compress_type = zipfile.ZIP_STORED
                        archive.writestr(info, image)
                        progress(index, len(descriptors), "extracting")
        except _DirectPdfNotSafe:
            return None
    return len(descriptors)



@dataclass(frozen=True)
class _PdfImage:
    width: int
    height: int
    colorspace: str
    bits: int
    data: bytes
    filter_name: str
    decode_parms: str | None = None
    decode: str | None = None
    icc_profile: bytes | None = None
    smask: "_PdfImage | None" = None
    orientation: int = 1


JPEG_SOF_MARKERS = {
    *range(0xC0, 0xC4),
    *range(0xC5, 0xC8),
    *range(0xC9, 0xCC),
    *range(0xCD, 0xD0),
}


def _jpeg_segments(data: bytes):
    """Yield JPEG marker payloads before the compressed scan data."""
    if len(data) < 4 or data[:2] != b"\xff\xd8":
        raise ValueError("the page is not a readable JPEG")
    cursor = 2
    while cursor < len(data):
        while cursor < len(data) and data[cursor] != 0xFF:
            cursor += 1
        while cursor < len(data) and data[cursor] == 0xFF:
            cursor += 1
        if cursor >= len(data):
            break
        marker = data[cursor]
        cursor += 1
        if marker == 0xDA:
            break
        if marker in (0xD8, 0xD9, 0x01) or 0xD0 <= marker <= 0xD7:
            continue
        if cursor + 2 > len(data):
            raise ValueError("the JPEG has a truncated marker")
        length = int.from_bytes(data[cursor:cursor + 2], "big")
        if length < 2 or cursor + length > len(data):
            raise ValueError("the JPEG has a truncated segment")
        yield marker, data[cursor + 2:cursor + length]
        cursor += length


def _jpeg_exif_orientation(payload: bytes) -> int:
    if not payload.startswith(b"Exif\x00\x00"):
        return 1
    tiff = payload[6:]
    if len(tiff) < 8 or tiff[:2] not in (b"II", b"MM"):
        return 1
    endian = "little" if tiff[:2] == b"II" else "big"
    if int.from_bytes(tiff[2:4], endian) != 42:
        return 1
    ifd_offset = int.from_bytes(tiff[4:8], endian)
    if ifd_offset + 2 > len(tiff):
        return 1
    count = int.from_bytes(tiff[ifd_offset:ifd_offset + 2], endian)
    cursor = ifd_offset + 2
    for _ in range(count):
        if cursor + 12 > len(tiff):
            return 1
        tag = int.from_bytes(tiff[cursor:cursor + 2], endian)
        kind = int.from_bytes(tiff[cursor + 2:cursor + 4], endian)
        number = int.from_bytes(tiff[cursor + 4:cursor + 8], endian)
        if tag == 0x0112 and kind == 3 and number == 1:
            value = int.from_bytes(tiff[cursor + 8:cursor + 10], endian)
            return value if 1 <= value <= 8 else 1
        cursor += 12
    return 1


def _jpeg_properties(data: bytes) -> tuple[int, int, str, int, int | None, bytes | None]:
    width = height = components = 0
    orientation = 1
    adobe_transform = None
    icc_parts: dict[int, bytes] = {}
    for marker, payload in _jpeg_segments(data):
        if marker in JPEG_SOF_MARKERS:
            if len(payload) < 6:
                raise ValueError("the JPEG has an invalid frame header")
            height = int.from_bytes(payload[1:3], "big")
            width = int.from_bytes(payload[3:5], "big")
            components = payload[5]
        elif marker == 0xE1:
            orientation = _jpeg_exif_orientation(payload)
        elif marker == 0xEE and payload.startswith(b"Adobe") and len(payload) >= 12:
            adobe_transform = payload[11]
        elif marker == 0xE2 and payload.startswith(b"ICC_PROFILE\x00") and len(payload) >= 14:
            sequence = payload[12]
            icc_parts[sequence] = payload[14:]
    if not width or not height:
        raise ValueError("the JPEG has no readable dimensions")
    colorspace = "DeviceGray" if components == 1 else "DeviceCMYK" if components == 4 else "DeviceRGB"
    icc_profile = b"".join(icc_parts[index] for index in sorted(icc_parts)) if icc_parts else None
    return width, height, colorspace, orientation, adobe_transform, icc_profile


def _jpeg_metadata(data: bytes) -> tuple[int, int, str]:
    """Read JPEG dimensions and colour space without decoding its pixels."""
    bound = _facade("_jpeg_metadata")
    if bound is not _jpeg_metadata:
        return bound(data)
    width, height, colorspace, _orientation, _adobe, _icc = _jpeg_properties(data)
    return width, height, colorspace


def _png_paeth(left: int, above: int, upper_left: int) -> int:
    estimate = left + above - upper_left
    distances = abs(estimate - left), abs(estimate - above), abs(estimate - upper_left)
    return left if distances[0] <= distances[1] and distances[0] <= distances[2] else above if distances[1] <= distances[2] else upper_left


def _png_unfilter(data: bytes, width: int, height: int, bytes_per_pixel: int) -> list[bytearray]:
    row_length = width * bytes_per_pixel
    expected = height * (row_length + 1)
    if len(data) != expected:
        raise ValueError("the PNG has truncated or excess scanline data")
    rows: list[bytearray] = []
    cursor = 0
    previous = bytearray(row_length)
    for _ in range(height):
        filter_type = data[cursor]
        cursor += 1
        row = bytearray(data[cursor:cursor + row_length])
        cursor += row_length
        if filter_type == 1:
            for index in range(row_length):
                row[index] = (row[index] + (row[index - bytes_per_pixel] if index >= bytes_per_pixel else 0)) & 0xFF
        elif filter_type == 2:
            for index in range(row_length):
                row[index] = (row[index] + previous[index]) & 0xFF
        elif filter_type == 3:
            for index in range(row_length):
                left = row[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
                row[index] = (row[index] + ((left + previous[index]) // 2)) & 0xFF
        elif filter_type == 4:
            for index in range(row_length):
                left = row[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
                upper_left = previous[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
                row[index] = (row[index] + _png_paeth(left, previous[index], upper_left)) & 0xFF
        elif filter_type != 0:
            raise ValueError(f"the PNG uses unsupported filter {filter_type}")
        rows.append(row)
        previous = row
    return rows


def _png_image(data: bytes) -> _PdfImage:
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("the page is not a readable PNG")
    cursor = 8
    width = height = bit_depth = color_type = interlace = None
    idat = bytearray()
    palette = b""
    transparency = b""
    icc_profile = None
    while cursor + 12 <= len(data):
        length = int.from_bytes(data[cursor:cursor + 4], "big")
        kind = data[cursor + 4:cursor + 8]
        end = cursor + 12 + length
        if end > len(data):
            raise ValueError("the PNG has a truncated chunk")
        payload = data[cursor + 8:cursor + 8 + length]
        expected_crc = int.from_bytes(data[end - 4:end], "big")
        actual_crc = binascii.crc32(kind + payload) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            raise ValueError("the PNG has an invalid chunk checksum")
        if kind == b"IHDR" and len(payload) == 13:
            width = int.from_bytes(payload[0:4], "big")
            height = int.from_bytes(payload[4:8], "big")
            bit_depth, color_type, interlace = payload[8], payload[9], payload[12]
        elif kind == b"IDAT":
            idat.extend(payload)
        elif kind == b"PLTE":
            palette = payload
        elif kind == b"tRNS":
            transparency = payload
        elif kind == b"iCCP":
            separator = payload.find(b"\x00")
            if separator >= 0 and separator + 2 <= len(payload) and payload[separator + 1] == 0:
                icc_profile = zlib.decompress(payload[separator + 2:])
        cursor = end
        if kind == b"IEND":
            break
    if not width or not height or bit_depth != 8 or interlace != 0:
        raise ValueError("the PNG is not a compatible non-interlaced 8-bit PNG")
    if color_type not in (0, 2, 3, 4, 6) or not idat:
        raise ValueError("the PNG uses an unsupported colour format")
    if color_type in (0, 2) and transparency:
        raise ValueError("the PNG uses a transparency key that needs raster conversion")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    rows = _png_unfilter(zlib.decompress(bytes(idat)), width, height, channels)
    alpha_rows = None
    if color_type == 0:
        color_rows = rows
        colors = 1
    elif color_type == 2:
        color_rows = rows
        colors = 3
    elif color_type == 3:
        if len(palette) % 3 or not palette:
            raise ValueError("the indexed PNG has no valid palette")
        color_rows = []
        alpha_rows = [] if transparency else None
        for row in rows:
            rgb = bytearray()
            alpha = bytearray()
            for index in row:
                offset = index * 3
                if offset + 3 > len(palette):
                    raise ValueError("the indexed PNG references a missing palette entry")
                rgb.extend(palette[offset:offset + 3])
                if alpha_rows is not None:
                    alpha.append(transparency[index] if index < len(transparency) else 255)
            color_rows.append(rgb)
            if alpha_rows is not None:
                alpha_rows.append(alpha)
        colors = 3
    elif color_type == 4:
        color_rows = [row[::2] for row in rows]
        alpha_rows = [row[1::2] for row in rows]
        colors = 1
    else:
        color_rows = [bytearray(value for index, value in enumerate(row) if index % 4 != 3) for row in rows]
        alpha_rows = [row[3::4] for row in rows]
        colors = 3
    color_stream = zlib.compress(b"".join(b"\x00" + bytes(row) for row in color_rows))
    smask = None
    if alpha_rows is not None:
        smask = _PdfImage(
            width, height, "DeviceGray", 8,
            zlib.compress(b"".join(b"\x00" + bytes(row) for row in alpha_rows)),
            "FlateDecode", f"/Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns {width}",
        )
    return _PdfImage(
        width, height, "DeviceGray" if colors == 1 else "DeviceRGB", 8, color_stream, "FlateDecode",
        f"/Predictor 15 /Colors {colors} /BitsPerComponent 8 /Columns {width}",
        icc_profile=icc_profile, smask=smask,
    )


def _jpeg_image(data: bytes) -> _PdfImage:
    width, height, colorspace = _jpeg_metadata(data)
    _parsed_width, _parsed_height, _parsed_colorspace, orientation, adobe_transform, icc_profile = _jpeg_properties(data)
    if colorspace == "DeviceCMYK" and adobe_transform == 2:
        raise ValueError("YCCK JPEGs need raster conversion before PDF embedding")
    decode = "[1 0 1 0 1 0 1 0]" if colorspace == "DeviceCMYK" else None
    return _PdfImage(width, height, colorspace, 8, data, "DCTDecode", decode=decode,
                     icc_profile=icc_profile, orientation=orientation)


def _pdf_number(value: float) -> str:
    return f"{value:.2f}".rstrip("0").rstrip(".")


def _pdf_literal(value: str) -> bytes:
    safe = value.encode("utf-8", errors="replace").decode("latin-1", errors="replace")
    return safe.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)").encode("latin-1", errors="replace")


def _pdf_page_size(width: int, height: int) -> tuple[float, float]:
    if width >= height:
        max_width, max_height = 792.0, 612.0
    else:
        max_width, max_height = 612.0, 792.0
    scale = min(max_width / width, max_height / height)
    return width * scale, height * scale


def _jpeg_quality(opts: dict) -> str:
    quality = (opts.get("quality") or "90").strip()
    if not quality.isdigit() or not 1 <= int(quality) <= 100:
        raise ValueError("JPEG quality must be a whole number from 1 to 100")
    return quality


def _png_to_jpeg(data: bytes, quality: str) -> bytes:
    """Convert one PNG in memory when it is not safe for direct embedding."""
    return _facade("_image_to_jpeg")(data, ".png", quality)


def _image_to_jpeg(data: bytes, suffix: str, quality: str) -> bytes:
    bound = _facade("_image_to_jpeg")
    if bound is not _image_to_jpeg:
        return bound(data, suffix, quality)
    from formats import magick_command
    command = magick_command([
        f"{suffix.lstrip('.') or 'auto'}:-", "-background", "white", "-alpha", "remove", "-alpha", "off",
        "-quality", quality, "jpg:-",
    ])
    try:
        result = subprocess.run(
            command,
            input=data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            **NO_WINDOW,
        )
    except OSError as exc:
        raise ValueError(f"ImageMagick could not be started: {exc}") from exc
    if result.returncode != 0 or not result.stdout:
        detail = (result.stderr or b"").decode(errors="replace").strip().splitlines()
        tail = detail[-1] if detail else f"exit code {result.returncode}"
        raise ValueError(f"ImageMagick {suffix.lstrip('.').upper()} conversion failed: {tail}")
    return result.stdout


def _direct_pdf_page_bytes(data: bytes, suffix: str, quality: str) -> bytes:
    if suffix in JPEG_SUFFIXES:
        return data
    if suffix == ".png":
        return _facade("_png_to_jpeg")(data, quality)
    return _facade("_image_to_jpeg")(data, suffix, quality)


def _page_image(source: PdfPageSource, quality: str) -> _PdfImage:
    data = source.read()
    if source.suffix in JPEG_SUFFIXES:
        try:
            return _jpeg_image(data)
        except ValueError as exc:
            if "YCCK" not in str(exc):
                raise
            return _jpeg_image(_facade("_image_to_jpeg")(data, source.suffix, quality))
    if source.suffix == ".png":
        try:
            return _png_image(data)
        except (ValueError, zlib.error):
            return _jpeg_image(_facade("_png_to_jpeg")(data, quality))
    return _jpeg_image(_facade("_image_to_jpeg")(data, source.suffix, quality))


def _page_dimensions(image: _PdfImage, geometry: str, dpi: float | None) -> tuple[float, float, float]:
    oriented_width, oriented_height = (
        (image.height, image.width) if image.orientation in (5, 6, 7, 8) else (image.width, image.height)
    )
    if geometry == "dpi":
        if dpi is None or dpi <= 0:
            raise ValueError("DPI must be a positive number")
        return oriented_width * 72.0 / dpi, oriented_height * 72.0 / dpi, 72.0 / dpi
    page_width, page_height = _pdf_page_size(oriented_width, oriented_height)
    return page_width, page_height, min(page_width / oriented_width, page_height / oriented_height)


def _orientation_matrix(image: _PdfImage, scale: float) -> tuple[float, float, float, float, float, float]:
    width, height = image.width * scale, image.height * scale
    unit = scale
    return {
        1: (width, 0, 0, height, 0, 0),
        2: (-width, 0, 0, height, width, 0),
        3: (-width, 0, 0, -height, width, height),
        4: (width, 0, 0, -height, 0, height),
        5: (0, unit, unit, 0, 0, 0),
        6: (0, unit, -unit, 0, height, 0),
        7: (0, -unit, -unit, 0, height, width),
        8: (0, -unit, unit, 0, 0, width),
    }[image.orientation]


def _write_direct_pdf_sources(
    pages: list[PdfPageSource], out: Path, progress, *, opts: dict | None = None, geometry: str = "letter",
) -> int:
    if not pages:
        raise ValueError("no readable pages were found")
    opts = opts or {}
    quality = _jpeg_quality(opts)
    dpi_value = (opts.get("dpi") or "150").strip() if geometry == "dpi" else None
    dpi = float(dpi_value) if dpi_value and dpi_value.replace(".", "", 1).isdigit() else None
    if geometry == "dpi" and (dpi is None or dpi <= 0):
        raise ValueError("DPI must be a positive number")
    out.parent.mkdir(parents=True, exist_ok=True)
    progress(0, len(pages), "writing")

    offsets = {0: 0}
    next_object = 4
    pages_object, catalog_object, info_object = 1, 2, 3
    page_objects = []

    with out.open("wb", buffering=1024 * 1024) as pdf:
        pdf.write(b"%PDF-1.4\n%\xff\xff\xff\xff\n")

        def reserve() -> int:
            nonlocal next_object
            number = next_object
            next_object += 1
            return number

        def write_object(number: int, body: bytes) -> None:
            offsets[number] = pdf.tell()
            pdf.write(f"{number} 0 obj\n".encode("ascii"))
            pdf.write(body)
            if not body.endswith(b"\n"):
                pdf.write(b"\n")
            pdf.write(b"endobj\n")

        for index, source in enumerate(pages, start=1):
            image = _page_image(source, quality)
            page_width, page_height, scale = _page_dimensions(image, geometry, dpi)
            image_object = reserve()
            smask_object = reserve() if image.smask else None
            icc_object = reserve() if image.icc_profile else None
            content_object, page_object = reserve(), reserve()
            page_objects.append(page_object)

            if image.icc_profile:
                components = 1 if image.colorspace == "DeviceGray" else 4 if image.colorspace == "DeviceCMYK" else 3
                icc_body = (
                    f"<< /N {components} /Length {len(image.icc_profile)} >>\nstream\n".encode("ascii")
                    + image.icc_profile + b"\nendstream\n"
                )
                write_object(icc_object, icc_body)
            if image.smask:
                smask = image.smask
                smask_body = (
                    f"<< /Type /XObject /Subtype /Image /Width {smask.width} /Height {smask.height} "
                    f"/ColorSpace /DeviceGray /BitsPerComponent {smask.bits} /Filter /{smask.filter_name} "
                    f"/DecodeParms << {smask.decode_parms} >> /Interpolate true /Length {len(smask.data)} >>\nstream\n".encode("ascii")
                    + smask.data + b"\nendstream\n"
                )
                write_object(smask_object, smask_body)

            color_space = f"[/ICCBased {icc_object} 0 R]" if icc_object else f"/{image.colorspace}"
            extra = f" /Decode {image.decode}" if image.decode else ""
            if image.decode_parms:
                extra += f" /DecodeParms << {image.decode_parms} >>"
            if smask_object:
                extra += f" /SMask {smask_object} 0 R"
            image_header = (
                f"<< /Type /XObject /Subtype /Image /Width {image.width} /Height {image.height} "
                f"/ColorSpace {color_space} /BitsPerComponent {image.bits} /Filter /{image.filter_name}"
                f"{extra} /Interpolate true /Length {len(image.data)} >>\nstream\n"
            ).encode("ascii")
            write_object(image_object, image_header + image.data + b"\nendstream\n")

            matrix = " ".join(_pdf_number(value) for value in _orientation_matrix(image, scale))
            content = f"q\n{matrix} cm\n/Im{index} Do\nQ\n".encode("ascii")
            write_object(
                content_object,
                f"<< /Length {len(content)} >>\nstream\n".encode("ascii") + content + b"endstream\n",
            )
            page_body = (
                f"<< /Type /Page /Parent {pages_object} 0 R "
                f"/MediaBox [0 0 {_pdf_number(page_width)} {_pdf_number(page_height)}] "
                f"/Resources << /XObject << /Im{index} {image_object} 0 R >> >> "
                f"/Contents {content_object} 0 R >>\n"
            ).encode("ascii")
            write_object(page_object, page_body)
            progress(index, len(pages), "writing")

        kids = " ".join(f"{obj} 0 R" for obj in page_objects)
        write_object(pages_object, f"<< /Type /Pages /Kids [{kids}] /Count {len(page_objects)} >>\n".encode("ascii"))
        write_object(catalog_object, f"<< /Type /Catalog /Pages {pages_object} 0 R >>\n".encode("ascii"))
        title = _pdf_literal(str(opts.get("title") or "Direct image PDF"))
        creator = _pdf_literal(str(opts.get("creator") or "One Tool"))
        write_object(info_object, b"<< /Title (" + title + b") /Creator (" + creator + b") >>\n")

        xref_position = pdf.tell()
        pdf.write(f"xref\n0 {next_object}\n".encode("ascii"))
        pdf.write(b"0000000000 65535 f \n")
        for number in range(1, next_object):
            pdf.write(f"{offsets[number]:010d} 00000 n \n".encode("ascii"))
        pdf.write(
            f"trailer\n<< /Size {next_object} /Root {catalog_object} 0 R /Info {info_object} 0 R >>\n"
            f"startxref\n{xref_position}\n%%EOF\n".encode("ascii")
        )
    return len(pages)


def write_direct_pdf(
    pages: list[PdfPageSource], out: Path, opts: dict | None = None, progress=None, *, geometry: str = "letter",
) -> int:
    """Atomically write lazily supplied raster pages to a PDF."""
    progress = progress or (lambda *_args: None)
    with _atomic_output(out) as partial:
        return _write_direct_pdf_sources(pages, partial, progress, opts=opts, geometry=geometry)


def _write_direct_jpeg_pdf(pages: list[tuple[str, Callable[[], bytes]]], out: Path, progress) -> int:
    sources = [PdfPageSource(name, Path(name).suffix.casefold(), read_page) for name, read_page in pages]
    with _atomic_output(out) as partial:
        return _write_direct_pdf_sources(sources, partial, progress)


def _write_direct_jpeg_pdf_to_path(pages: list[tuple[str, Callable[[], bytes]]], out: Path, progress) -> int:
    sources = [PdfPageSource(name, Path(name).suffix.casefold(), read_page) for name, read_page in pages]
    return _write_direct_pdf_sources(sources, out, progress)


def _direct_pdf_from_archive(archive: zipfile.ZipFile, names: list[str], out: Path, opts: dict, progress) -> int:
    pages = [
        PdfPageSource(name, Path(name).suffix.casefold(), lambda name=name: archive.read(name))
        for name in names
    ]
    return write_direct_pdf(pages, out, opts, progress)


def _direct_pdf_from_paths(paths: list[Path], out: Path, opts: dict, progress, *, geometry: str = "letter") -> int:
    pages = [PdfPageSource(str(path), path.suffix.casefold(), path.read_bytes) for path in paths]
    return write_direct_pdf(pages, out, opts, progress, geometry=geometry)
