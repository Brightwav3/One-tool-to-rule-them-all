#!/usr/bin/env python3
"""Every conversion the app knows about.

Converters with `convert=None` are declared but not implemented — the UI shows
them as "Soon". Converters with a `helper` work as soon as that program is on
the machine; until then the UI explains what is missing instead of failing.
"""

from __future__ import annotations

import binascii
import ctypes
import atexit
import json
import mmap
import os
import posixpath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import zipfile
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
import zlib
from urllib.parse import unquote
from xml.etree import ElementTree

import cbz_to_epub
from registry import (
    CALIBRE,
    FFMPEG,
    IMAGEMAGICK,
    LIBREOFFICE,
    PANDOC,
    PDF_RENDERER,
    POPPLER,
    POPPLER_RENDER,
    POPPLER_TEXT,
    RAW_TOOLS,
    SEVEN_ZIP,
    Converter,
    Helper,
    Option,
    Registry,
)

IMAGE_SUFFIXES = tuple(cbz_to_epub.SUPPORTED_IMAGES)
JPEG_SUFFIXES = {".jpg", ".jpeg"}
# Formats that can hold more than one frame. Left alone, ImageMagick writes one
# numbered file per frame and the single expected output never appears, so the
# readers below ask for frame zero explicitly.
MULTI_FRAME_SUFFIXES = {".gif", ".tif", ".tiff", ".avif"}
DIRECT_PDF_SUFFIXES = JPEG_SUFFIXES | {".png"}
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


# --------------------------------------------------------------------------- #
# Shared plumbing
# --------------------------------------------------------------------------- #


def run(command: list[str], what: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    """Run a helper and turn its failure into a message worth showing a user."""
    try:
        result = subprocess.run(command, capture_output=True, text=True, env=env, **NO_WINDOW)
    except OSError as exc:
        raise ValueError(f"{what} could not be started: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip().splitlines()
        tail = detail[-1] if detail else f"exit code {result.returncode}"
        raise ValueError(f"{what} failed: {tail}")
    return result


def run_magick_pdf(command: list[str], total: int, progress, cwd: Path | None = None) -> None:
    """Run ImageMagick's PDF write while forwarding its per-image monitor."""
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(cwd) if cwd else None,
            **NO_WINDOW,
        )
    except OSError as exc:
        raise ValueError(f"ImageMagick could not be started: {exc}") from exc

    details: list[str] = []
    assert process.stderr is not None
    for line in process.stderr:
        details.append(line.strip())
        match = re.search(r"mogrify image\[.*\]:\s*(\d+)\s+of\s+(\d+)", line)
        if match:
            # ImageMagick reports the zero-based image currently being written.
            progress(min(int(match.group(1)) + 1, total), total, "writing")
    returncode = process.wait()
    if returncode != 0:
        detail = next((line for line in reversed(details) if line), f"exit code {returncode}")
        raise ValueError(f"ImageMagick failed: {detail}")


def which(*names: str) -> str:
    wanted = {name.casefold().removesuffix(".exe") for name in names}
    for helper in (SEVEN_ZIP, POPPLER, POPPLER_RENDER, POPPLER_TEXT, FFMPEG, IMAGEMAGICK, LIBREOFFICE, CALIBRE, RAW_TOOLS, PANDOC, PDF_RENDERER):
        helper_names = {name.casefold().removesuffix(".exe") for name in helper.binaries}
        if wanted & helper_names:
            for name in names:
                found = helper.locate_binary(name)
                if found:
                    return found
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    raise ValueError(f"none of {', '.join(names)} was found on this machine")


def natural(value: str) -> list:
    return [int(p) if p.isdigit() else p.casefold() for p in re.split(r"(\d+)", value)]


def images_in(folder: Path) -> list[Path]:
    found = [
        p for p in folder.rglob("*")
        if p.is_file()
        and p.suffix.casefold() in IMAGE_SUFFIXES
        and not cbz_to_epub.is_junk_entry(p.relative_to(folder).as_posix())
    ]
    found.sort(key=lambda p: natural(str(p)))
    return found


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
    descriptors = _pdf_jpeg_ranges(source)
    if not descriptors:
        return None
    with source.open("rb") as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
        try:
            with _atomic_output(out) as partial:
                with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    for index, (offset, length, name) in enumerate(descriptors, start=1):
                        image = data[offset:offset + length]
                        if not _valid_extracted_jpeg(image):
                            raise _DirectPdfNotSafe
                        info = zipfile.ZipInfo(name)
                        info.compress_type = zipfile.ZIP_STORED
                        archive.writestr(info, image)
                        progress(index, len(descriptors), "extracting")
        except _DirectPdfNotSafe:
            return None
    return len(descriptors)


def _try_pdfimages_to_cbz(source: Path, out: Path, progress) -> int | None:
    """Extract embedded JPEG pages without rasterizing the PDF."""
    try:
        pdfimages = which("pdfimages")
        page_count = _pdf_page_count(source)
    except ValueError:
        return None

    with tempfile.TemporaryDirectory(prefix="onetool-pdfimages-") as tmp:
        room = Path(tmp)
        prefix = room / "page"
        try:
            run([pdfimages, "-j", str(source), str(prefix)], "Poppler")
        except ValueError:
            return None
        pages = images_in(room)
        if len(pages) != page_count or any(page.suffix.casefold() not in JPEG_SUFFIXES for page in pages):
            return None
        archive_names = [f"page-{index:04d}{page.suffix.casefold()}" for index, page in enumerate(pages, start=1)]
        return zip_files(pages, room, out, progress, archive_names=archive_names)


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
    return _image_to_jpeg(data, ".png", quality)


def _image_to_jpeg(data: bytes, suffix: str, quality: str) -> bytes:
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
        return _png_to_jpeg(data, quality)
    return _image_to_jpeg(data, suffix, quality)


def _page_image(source: PdfPageSource, quality: str) -> _PdfImage:
    data = source.read()
    if source.suffix in JPEG_SUFFIXES:
        try:
            return _jpeg_image(data)
        except ValueError as exc:
            if "YCCK" not in str(exc):
                raise
            return _jpeg_image(_image_to_jpeg(data, source.suffix, quality))
    if source.suffix == ".png":
        try:
            return _png_image(data)
        except (ValueError, zlib.error):
            return _jpeg_image(_png_to_jpeg(data, quality))
    return _jpeg_image(_image_to_jpeg(data, source.suffix, quality))


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


def shorten_page_arguments(pages: list[Path]) -> tuple[Path | None, list[str]]:
    """Name pages relative to a shared folder so the command line stays short.

    Falls back to absolute paths when the pages have no common parent, which
    happens when someone hand-picks images from several folders at once.
    """
    resolved = [page.resolve() for page in pages]
    try:
        room = Path(os.path.commonpath([str(page.parent) for page in resolved]))
    except ValueError:  # different drives on Windows
        return None, [str(page) for page in resolved]
    if not room.is_dir():
        return None, [str(page) for page in resolved]
    names = [str(page.relative_to(room)) for page in resolved]
    # A leading dash would be read as an ImageMagick option rather than a file.
    if any(name.startswith("-") for name in names):
        return None, [str(page) for page in resolved]
    return room, names


def zip_files(
    paths: list[Path],
    root: Path,
    out: Path,
    progress,
    *,
    archive_names: list[str] | None = None,
) -> int:
    out.parent.mkdir(parents=True, exist_ok=True)
    if archive_names is not None and len(archive_names) != len(paths):
        raise ValueError("archive name count does not match page count")
    with _atomic_output(out) as partial:
        with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for index, path in enumerate(paths, start=1):
                name = archive_names[index - 1] if archive_names is not None else path.relative_to(root).as_posix()
                archive.write(
                    path,
                    name,
                    compress_type=(
                        zipfile.ZIP_STORED
                        if path.suffix.casefold() in IMAGE_SUFFIXES
                        else zipfile.ZIP_DEFLATED
                    ),
                )
                progress(index, len(paths))
    return len(paths)


def extract_with_7zip(source: Path, target: Path, password: str = "") -> None:
    command = [which("7z", "7za", "7zz"), "x", str(source), f"-o{target}", "-y"]
    if password:
        command.append(f"-p{password}")
    try:
        run(command, "7-Zip")
    except ValueError as exc:
        if re.search(r"wrong password|can not open encrypted archive|data error|encrypted", str(exc), re.I):
            raise ValueError("Archive password required") from exc
        raise


# --------------------------------------------------------------------------- #
# Comics
# --------------------------------------------------------------------------- #


def cbz_to_epub_convert(source: Path, out: Path, opts: dict, progress) -> int:
    if opts.get("password"):
        with tempfile.TemporaryDirectory(prefix="onetool-cbz-epub-") as tmp:
            room = Path(tmp)
            extract_with_7zip(source, room, opts["password"])
            pages = images_in(room)
            if not pages:
                raise ValueError("the archive holds no readable comic pages")
            return cbz_to_epub.convert_paths(pages, out, opts.get("title") or source.stem, opts.get("creator") or "Unknown", progress=progress)
    return cbz_to_epub.convert(
        source, out, opts.get("title") or None, opts.get("creator") or "Unknown", progress=progress
    )


def cbz_probe(source: Path) -> int:
    with zipfile.ZipFile(source, "r") as archive:
        return len(cbz_to_epub.list_images(archive))


def images_to_pdf_convert(pages: list[Path], out: Path, opts: dict, progress, phase: str = "writing") -> int:
    if not pages:
        raise ValueError("no readable images were found")
    dpi = (opts.get("dpi") or "150").strip()
    if not dpi.isdigit():
        raise ValueError("DPI must be a whole number")
    quality = (opts.get("quality") or "90").strip()
    if not quality.isdigit() or not 1 <= int(quality) <= 100:
        raise ValueError("JPEG quality must be a whole number from 1 to 100")
    if all(page.suffix.casefold() in DIRECT_PDF_SUFFIXES for page in pages):
        return _direct_pdf_from_paths(pages, out, opts, progress, geometry="dpi")
    out.parent.mkdir(parents=True, exist_ok=True)
    progress(0, len(pages), phase)
    # A long comic contributes one path per page. Naming the pages relative to
    # their shared folder keeps the command line inside the OS limit, which a
    # few hundred absolute temp paths would otherwise blow straight past.
    room, names = shorten_page_arguments(pages)
    with _atomic_output(out) as partial:
        command = magick_command([
            "-monitor", "-density", dpi, *names,
            "-compress", "JPEG", "-quality", quality, str(partial),
        ], limit_resources=len(pages) > 1)
        run_magick_pdf(command, len(pages), progress, cwd=room)
        if not partial.is_file() or partial.stat().st_size == 0:
            raise ValueError("ImageMagick produced no PDF")
    progress(len(pages), len(pages), phase)
    return len(pages)


def cbz_to_pdf_convert(source: Path, out: Path, opts: dict, progress) -> int:
    with tempfile.TemporaryDirectory(prefix="onetool-cbz-pdf-") as tmp:
        room = Path(tmp)
        if opts.get("password"):
            extract_with_7zip(source, room, opts["password"])
            pages = images_in(room)
            if not pages:
                raise ValueError("the archive holds no readable comic pages")
            return _direct_pdf_from_paths(pages, out, opts, progress)
        with zipfile.ZipFile(source, "r") as archive:
            names = [image.name for image in cbz_to_epub.list_images(archive)]
            if not names:
                raise ValueError("the archive holds no readable comic pages")
            return _direct_pdf_from_archive(archive, names, out, opts, progress)


def cbr_to_epub_convert(source: Path, out: Path, opts: dict, progress) -> int:
    with tempfile.TemporaryDirectory(prefix="onetool-cbr-") as tmp:
        room = Path(tmp)
        extract_with_7zip(source, room, opts["password"]) if opts.get("password") else extract_with_7zip(source, room)
        pages = images_in(room)
        if not pages:
            raise ValueError("the archive holds no readable comic pages")
        return cbz_to_epub.convert_paths(
            pages,
            out,
            opts.get("title") or source.stem,
            opts.get("creator") or "Unknown",
            progress=progress,
        )


def cbr_to_pdf_convert(source: Path, out: Path, opts: dict, progress) -> int:
    with tempfile.TemporaryDirectory(prefix="onetool-cbr-pdf-") as tmp:
        room = Path(tmp)
        extract_with_7zip(source, room, opts["password"]) if opts.get("password") else extract_with_7zip(source, room)
        pages = images_in(room)
        if not pages:
            raise ValueError("the archive holds no readable comic pages")
        return _direct_pdf_from_paths(pages, out, opts, progress)


def epub_to_cbz_convert(source: Path, out: Path, opts: dict, progress) -> int:
    with zipfile.ZipFile(source, "r") as book:
        names = [
            n for n in book.namelist()
            if Path(n).suffix.casefold() in IMAGE_SUFFIXES
            and not cbz_to_epub.is_junk_entry(n)
        ]
        if not names:
            raise ValueError("this EPUB has no image resources to pack")
        names.sort(key=natural)
        out.parent.mkdir(parents=True, exist_ok=True)
        with _atomic_output(out) as partial:
            with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                for index, name in enumerate(names, start=1):
                    info = zipfile.ZipInfo(f"{index:04d}{Path(name).suffix.casefold()}")
                    info.compress_type = zipfile.ZIP_STORED
                    with book.open(name) as page, archive.open(info, "w") as target:
                        shutil.copyfileobj(page, target, 1024 * 1024)
                    progress(index, len(names))
    return len(names)


def _epub_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _epub_member_path(base: str, href: str, members: set[str]) -> str | None:
    clean = unquote(href.split("#", 1)[0])
    name = posixpath.normpath(posixpath.join(base, clean))
    if name in ("", ".") or name.startswith("../") or name.startswith("/") or name not in members:
        return None
    return name


def _read_epub_member(source: Path, name: str) -> bytes:
    with zipfile.ZipFile(source, "r") as book:
        return book.read(name)


def _epub_image_pdf_sources(source: Path) -> tuple[list[PdfPageSource], str, str] | None:
    with zipfile.ZipFile(source, "r") as book:
        members = {cbz_to_epub.safe_archive_name(name) for name in book.namelist() if not name.endswith("/")}
        try:
            container = ElementTree.fromstring(book.read("META-INF/container.xml"))
            rootfile = next(
                element.attrib.get("full-path", "")
                for element in container.iter()
                if _epub_local_name(element.tag) == "rootfile"
            )
            opf_name = _epub_member_path("", rootfile, members)
            if not opf_name:
                return None
            package = ElementTree.fromstring(book.read(opf_name))
        except (KeyError, ElementTree.ParseError, StopIteration, ValueError):
            return None

        base = posixpath.dirname(opf_name)
        manifest: dict[str, ElementTree.Element] = {}
        spine: list[str] = []
        title = ""
        creator = ""
        for element in package.iter():
            local = _epub_local_name(element.tag)
            if local == "item" and element.attrib.get("id"):
                manifest[element.attrib["id"]] = element
            elif local == "itemref" and element.attrib.get("idref"):
                spine.append(element.attrib["idref"])
            elif local == "title" and not title and (element.text or "").strip():
                title = (element.text or "").strip()
            elif local == "creator" and not creator and (element.text or "").strip():
                creator = (element.text or "").strip()
        if not spine:
            return None

        pages: list[PdfPageSource] = []
        image_media = {"image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png"}
        for idref in spine:
            page_item = manifest.get(idref)
            if page_item is None or page_item.attrib.get("media-type") not in {"application/xhtml+xml", "text/html"}:
                return None
            page_name = _epub_member_path(base, page_item.attrib.get("href", ""), members)
            if not page_name:
                return None
            try:
                page_root = ElementTree.fromstring(book.read(page_name))
            except (KeyError, ElementTree.ParseError):
                return None
            body = next((element for element in page_root.iter() if _epub_local_name(element.tag) == "body"), None)
            images = [element for element in page_root.iter() if _epub_local_name(element.tag) == "img"]
            if body is None or len(images) != 1 or any((text or "").strip() for text in body.itertext()):
                return None
            image_href = images[0].attrib.get("src", "")
            image_name = _epub_member_path(posixpath.dirname(page_name), image_href, members)
            if not image_name:
                return None
            image_item = next(
                (item for item in manifest.values()
                 if _epub_member_path(base, item.attrib.get("href", ""), members) == image_name),
                None,
            )
            media_type = image_item.attrib.get("media-type", "") if image_item is not None else ""
            suffix = image_media.get(media_type, Path(image_name).suffix.casefold())
            if not media_type.startswith("image/") or suffix not in IMAGE_SUFFIXES:
                return None
            pages.append(PdfPageSource(image_name, suffix, lambda name=image_name: _read_epub_member(source, name)))
        return pages, title, creator


def epub_to_pdf_convert(source: Path, out: Path, opts: dict, progress) -> int:
    direct = _epub_image_pdf_sources(source)
    if direct:
        pages, title, creator = direct
        direct_opts = dict(opts)
        direct_opts.setdefault("title", title or source.stem)
        direct_opts.setdefault("creator", creator or "Unknown")
        try:
            return write_direct_pdf(pages, out, direct_opts, progress)
        except ValueError:
            # A structurally image-only EPUB can still contain an image format
            # the direct writer cannot safely decode. Let Calibre handle it.
            pass
    return calibre_convert(source, out, opts, progress)


def epub_to_txt_convert(source: Path, out: Path, opts: dict, progress) -> int:
    """Extract readable block text from an EPUB without requiring Calibre."""
    block_tags = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "dt", "dd", "blockquote", "pre"}
    with zipfile.ZipFile(source, "r") as book:
        names = sorted(
            [name for name in book.namelist() if Path(name).suffix.casefold() in {".xhtml", ".html", ".htm"}],
            key=natural,
        )
        if not names:
            raise ValueError("this EPUB has no readable XHTML content")

        lines: list[str] = []
        for name in names:
            try:
                root = ElementTree.fromstring(book.read(name))
            except (KeyError, ElementTree.ParseError) as exc:
                raise ValueError(f"EPUB content is not valid XHTML: {name}") from exc

            def visit(element: ElementTree.Element) -> None:
                local = _epub_local_name(element.tag).casefold()
                if local in block_tags:
                    text = " ".join(part.strip() for part in element.itertext() if part.strip())
                    if text:
                        lines.append(text)
                    return
                for child in element:
                    visit(child)

            visit(root)

    if not lines:
        raise ValueError("this EPUB has no readable text")
    out.parent.mkdir(parents=True, exist_ok=True)
    progress(0, 1, "writing")
    with _atomic_output(out) as partial:
        partial.write_text("\n".join(lines) + "\n", encoding="utf-8")
    progress(1, 1, "writing")
    return 1


PDF_MAX_WORKERS = 4
PDF_MEMORY_PER_WORKER = 256 * 1024 * 1024


def _available_memory_bytes() -> int | None:
    """Return available system memory without requiring a third-party package."""
    if sys.platform == "win32":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("length", ctypes.c_ulong),
                ("memory_load", ctypes.c_ulong),
                ("total_phys", ctypes.c_ulonglong),
                ("avail_phys", ctypes.c_ulonglong),
                ("total_page_file", ctypes.c_ulonglong),
                ("avail_page_file", ctypes.c_ulonglong),
                ("total_virtual", ctypes.c_ulonglong),
                ("avail_virtual", ctypes.c_ulonglong),
                ("avail_extended_virtual", ctypes.c_ulonglong),
            ]

        status = MemoryStatus()
        status.length = ctypes.sizeof(MemoryStatus)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return int(status.avail_phys)
        return None
    try:
        pages = os.sysconf("SC_AVPHYS_PAGES")
        page_size = os.sysconf("SC_PAGE_SIZE")
    except (AttributeError, OSError, ValueError):
        return None
    return int(pages * page_size)


def _pdf_worker_count(page_count: int) -> int:
    cpu_count = max(1, min(PDF_MAX_WORKERS, os.cpu_count() or 1))
    available = _available_memory_bytes()
    if available is not None:
        memory_count = max(1, available // PDF_MEMORY_PER_WORKER)
        cpu_count = min(cpu_count, memory_count)
    return max(1, min(page_count, cpu_count))


def _pdf_page_ranges(page_count: int, worker_count: int) -> list[tuple[int, int]]:
    if page_count < 1:
        return []
    worker_count = max(1, min(page_count, worker_count))
    chunk_size = (page_count + worker_count - 1) // worker_count
    return [
        (first, min(first + chunk_size - 1, page_count))
        for first in range(1, page_count + 1, chunk_size)
    ]


def _pdf_page_count(source: Path) -> int:
    result = run([which("pdfinfo"), str(source)], "Poppler")
    match = re.search(r"^Pages:\s*(\d+)\s*$", result.stdout or "", re.MULTILINE)
    if not match:
        raise ValueError("Poppler did not report a PDF page count")
    return int(match.group(1))


def _render_pdf_range(
    source: Path,
    target: Path,
    first: int,
    last: int,
    dpi: str,
    fmt: str,
) -> list[Path]:
    target.mkdir(parents=True, exist_ok=True)
    flag = "-png" if fmt == "png" else "-jpeg"
    prefix = target / "page"
    run(
        [
            which("pdftoppm"),
            flag,
            "-r",
            dpi,
            "-f",
            str(first),
            "-l",
            str(last),
            str(source),
            str(prefix),
        ],
        "Poppler",
    )
    return images_in(target)


def pdf_to_cbz_convert(source: Path, out: Path, opts: dict, progress) -> int:
    dpi = (opts.get("dpi") or "300").strip()
    fmt = (opts.get("format") or "jpg").strip().casefold()
    if not dpi.isdigit() or int(dpi) <= 0:
        raise ValueError("DPI must be a positive whole number")
    if fmt not in {"jpg", "png"}:
        raise ValueError("PDF output format must be jpg or png")
    if fmt == "jpg":
        direct_count = _try_direct_pdf_to_cbz(source, out, progress)
        if direct_count is not None:
            return direct_count
        extracted_count = _try_pdfimages_to_cbz(source, out, progress)
        if extracted_count is not None:
            return extracted_count
    progress(0, 0)
    with tempfile.TemporaryDirectory(prefix="onetool-pdf-") as tmp:
        room = Path(tmp)
        page_count = _pdf_page_count(source)
        workers = _pdf_worker_count(page_count)
        ranges = _pdf_page_ranges(page_count, workers)
        with ThreadPoolExecutor(max_workers=min(workers, len(ranges))) as pool:
            futures = [
                pool.submit(_render_pdf_range, source, room / f"range-{first:04d}", first, last, dpi, fmt)
                for first, last in ranges
            ]
            rendered = [future.result() for future in futures]
        pages = [page for group in rendered for page in group]
        if not pages:
            raise ValueError("no pages were rendered — the PDF may be empty or encrypted")
        if len(pages) != page_count:
            raise ValueError(f"Poppler rendered {len(pages)} of {page_count} pages")
        archive_names = [f"page-{index:04d}{page.suffix.casefold()}" for index, page in enumerate(pages, start=1)]
        return zip_files(pages, room, out, progress, archive_names=archive_names)


def pdf_to_image_convert(source: Path, out: Path, opts: dict, progress) -> int:
    """Render one PDF page as a standalone image.

    A conversion writes a single file, so a page has to be named rather than
    assumed. Whole documents are what PDF -> comic archive is for; this route
    exists for the far more common case of wanting one page out of one.
    """
    target = out.suffix.casefold()
    fmt = "png" if target == ".png" else "jpg"
    dpi = (opts.get("dpi") or "150").strip()
    if not dpi.isdigit() or int(dpi) <= 0:
        raise ValueError("DPI must be a positive whole number")

    raw_page = (opts.get("page") or "1").strip()
    if not raw_page.isdigit() or int(raw_page) <= 0:
        raise ValueError("Page must be a positive whole number")
    page = int(raw_page)

    progress(0, 1, "rendering")
    page_count = _pdf_page_count(source)
    if page > page_count:
        raise ValueError(f"this PDF has {page_count} page{'s' if page_count != 1 else ''}, so page {page} does not exist")

    with tempfile.TemporaryDirectory(prefix="onetool-pdf-image-") as tmp:
        rendered = _render_pdf_range(source, Path(tmp), page, page, dpi, fmt)
        if not rendered:
            raise ValueError("no page was rendered — the PDF may be empty or encrypted")
        out.parent.mkdir(parents=True, exist_ok=True)
        with _atomic_output(out) as partial:
            shutil.copyfile(rendered[0], partial)
    progress(1, 1, "rendering")
    return 1


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #


def pdf_to_txt_convert(source: Path, out: Path, opts: dict, progress) -> int:
    progress(0, 0)
    out.parent.mkdir(parents=True, exist_ok=True)
    run([which("pdftotext"), "-layout", str(source), str(out)], "Poppler")
    if not out.exists() or out.stat().st_size == 0:
        raise ValueError("no text layer found — this looks like a scan, which needs OCR")
    progress(1, 1)
    return 1


class PdfMarkdownWorker:
    """One serialized Node process for a batch of PDF Inspector requests."""

    def __init__(self, runtime: str, runner: Path) -> None:
        self.runtime = runtime
        self.runner = Path(runner)
        self.lock = threading.Lock()
        self.process: subprocess.Popen[str] | None = None

    def _start_locked(self) -> None:
        if self.process is not None and self.process.poll() is None:
            return
        try:
            env = os.environ.copy()
            if os.environ.get("ONETOOL_ELECTRON_RUN_AS_NODE") == "1":
                env["ELECTRON_RUN_AS_NODE"] = "1"
            self.process = subprocess.Popen(
                [self.runtime, str(self.runner), "--worker"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=env,
                **NO_WINDOW,
            )
        except OSError as exc:
            self.process = None
            raise ValueError(f"PDF Inspector worker could not be started: {exc}") from exc

    def _stop_locked(self) -> None:
        process, self.process = self.process, None
        if process is None:
            return
        try:
            if process.stdin:
                process.stdin.close()
        except OSError:
            pass
        try:
            if process.stdout:
                process.stdout.close()
        except OSError:
            pass
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)

    def close(self) -> None:
        with self.lock:
            self._stop_locked()

    def convert(self, source: Path, out: Path, progress) -> dict:
        progress(0, 1, "processing")
        request = json.dumps({"inputPath": str(source), "outputPath": str(out)}) + "\n"
        result: dict | None = None
        with self.lock:
            for attempt in range(2):
                try:
                    self._start_locked()
                    assert self.process is not None
                    assert self.process.stdin is not None and self.process.stdout is not None
                    self.process.stdin.write(request)
                    self.process.stdin.flush()
                    line = self.process.stdout.readline()
                    if not line:
                        raise OSError("the worker exited before returning a result")
                    result = json.loads(line)
                    if not isinstance(result, dict):
                        raise OSError("the worker returned an invalid result")
                    break
                except (OSError, ValueError, json.JSONDecodeError) as exc:
                    self._stop_locked()
                    if attempt:
                        raise ValueError(f"PDF Inspector worker failed: {exc}") from exc
            if result is None:
                raise ValueError("PDF Inspector worker returned no result")
            if not result.get("ok", False):
                raise ValueError(str(result.get("error") or "PDF Inspector failed"))
            partial = Path(f"{out}.partial")
            try:
                if partial.is_file():
                    os.replace(partial, out)
                elif not out.is_file():
                    raise ValueError("PDF Inspector produced no Markdown output")
            except OSError as exc:
                _discard_partial(partial)
                raise ValueError(f"PDF Inspector could not commit Markdown output: {exc}") from exc
        progress(1, 1, "writing")
        return result


_PDF_MD_WORKER: PdfMarkdownWorker | None = None
_PDF_MD_WORKER_CONFIG: tuple[str, str] | None = None


def _get_pdf_md_worker() -> PdfMarkdownWorker:
    global _PDF_MD_WORKER, _PDF_MD_WORKER_CONFIG
    runtime = os.environ.get("ONETOOL_NODE_RUNTIME") or shutil.which("node")
    runner = os.environ.get("ONETOOL_PDF_MD_RUNNER")
    if not runner:
        runner = str(Path(__file__).resolve().parent / "pdf_to_md.cjs")
    if not runtime:
        raise ValueError("PDF Inspector needs the Node.js runtime")
    config = (runtime, runner)
    if _PDF_MD_WORKER is None or _PDF_MD_WORKER_CONFIG != config:
        if _PDF_MD_WORKER is not None:
            _PDF_MD_WORKER.close()
        _PDF_MD_WORKER = PdfMarkdownWorker(runtime, Path(runner))
        _PDF_MD_WORKER_CONFIG = config
    return _PDF_MD_WORKER


def _close_pdf_md_worker() -> None:
    if _PDF_MD_WORKER is not None:
        _PDF_MD_WORKER.close()


atexit.register(_close_pdf_md_worker)


def pdf_to_md_convert(source: Path, out: Path, opts: dict, progress) -> int:
    _get_pdf_md_worker().convert(source, out, progress)
    return 1


def docx_to_pdf_convert(source: Path, out: Path, opts: dict, progress) -> int:
    return libreoffice_convert(source, out, "pdf", progress)


def libreoffice_convert(source: Path, out: Path, target_format: str, progress) -> int:
    progress(0, 0)
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="onetool-doc-") as tmp:
        run(
            [
                which("soffice", "libreoffice"), "--headless",
                f"-env:UserInstallation={(Path(tmp) / 'profile').resolve().as_uri()}",
                "--convert-to", target_format, "--outdir", tmp, str(source),
            ],
            "LibreOffice",
        )
        produced = Path(tmp) / f"{source.stem}{out.suffix}"
        if not produced.is_file():
            produced = next(Path(tmp).glob(f"*{out.suffix}"), None)
        if produced is None:
            raise ValueError(f"LibreOffice produced no {out.suffix.lstrip('.').upper()} file")
        shutil.move(str(produced), out)
    progress(1, 1)
    return 1


def docx_to_epub_convert(source: Path, out: Path, opts: dict, progress) -> int:
    # `EPUB` is LibreOffice Writer's explicit export filter.  Naming it avoids
    # LibreOffice selecting a module-specific default for non-DOCX Writer files.
    return libreoffice_convert(source, out, "epub:EPUB", progress)


def docx_to_txt_convert(source: Path, out: Path, opts: dict, progress) -> int:
    return libreoffice_convert(source, out, "txt:Text", progress)


def image_to_pdf_convert(source: Path, out: Path, opts: dict, progress) -> int:
    if source.suffix.casefold() in DIRECT_PDF_SUFFIXES:
        return _direct_pdf_from_paths([source], out, opts, progress, geometry="dpi")
    return images_to_pdf_convert([source], out, opts, progress)


def raster_image_to_pdf_convert(source: Path, out: Path, opts: dict, progress) -> int:
    """Rasterise a non-PNG/JPEG image, then use the safe direct PDF writer."""
    with tempfile.TemporaryDirectory(prefix="onetool-image-pdf-") as tmp:
        jpeg = Path(tmp) / "page.jpg"
        raster_image_convert(source, jpeg, {"quality": opts.get("quality") or "90"}, progress)
        return image_to_pdf_convert(jpeg, out, opts, progress)


def svg_to_pdf_convert(source: Path, out: Path, opts: dict, progress) -> int:
    """Render SVG to PNG first so PDF output does not depend on ImageMagick PDF policy."""
    with tempfile.TemporaryDirectory(prefix="onetool-svg-pdf-") as tmp:
        png = Path(tmp) / "page.png"
        svg_to_png_convert(source, png, opts, progress)
        return image_to_pdf_convert(png, out, opts, progress)


def calibre_convert(source: Path, out: Path, opts: dict, progress) -> int:
    progress(0, 0)
    out.parent.mkdir(parents=True, exist_ok=True)
    run([which("ebook-convert"), str(source), str(out)], "Calibre")
    if not out.is_file() or out.stat().st_size == 0:
        raise ValueError("Calibre produced no output file")
    progress(1, 1)
    return 1


# --------------------------------------------------------------------------- #
# Archives
# --------------------------------------------------------------------------- #


def repack_convert(source: Path, out: Path, opts: dict, progress) -> int:
    progress(0, 0)
    with tempfile.TemporaryDirectory(prefix="onetool-pack-") as tmp:
        room = Path(tmp)
        extract_with_7zip(source, room, opts["password"]) if opts.get("password") else extract_with_7zip(source, room)
        members = [p for p in room.rglob("*") if p.is_file()]
        if not members:
            raise ValueError("the archive is empty")
        return zip_files(members, room, out, progress)


# --------------------------------------------------------------------------- #
# Creator — many items into one container
# --------------------------------------------------------------------------- #


def _staged_items(items: list[Path]) -> list[tuple[str, Path]]:
    """Flatten the picked items into (archive name, file) pairs.

    A picked folder contributes its whole tree under its own name; a picked file
    contributes itself. Names are made unique so two files called `cover.jpg`
    from different folders cannot silently overwrite one another.
    """
    pairs: list[tuple[str, Path]] = []
    for item in items:
        item = item.expanduser()
        if item.is_dir():
            for member in sorted(item.rglob("*"), key=lambda p: natural(str(p))):
                if member.is_file():
                    pairs.append((f"{item.name}/{member.relative_to(item).as_posix()}", member))
        elif item.is_file():
            pairs.append((item.name, item))
        else:
            raise ValueError(f"{item.name} is no longer at its saved path")
    if not pairs:
        raise ValueError("there is nothing to pack — every item is empty or missing")

    seen: dict[str, int] = {}
    unique: list[tuple[str, Path]] = []
    for name, path in pairs:
        if name in seen:
            seen[name] += 1
            stem, dot, suffix = name.rpartition(".")
            name = f"{stem} ({seen[name]}){dot}{suffix}" if dot else f"{name} ({seen[name]})"
        else:
            seen[name] = 0
        unique.append((name, path))
    return unique


def _item_images(items: list[Path]) -> list[Path]:
    """The images inside the picked items, in the order the user sees them."""
    pages: list[Path] = []
    for name, path in _staged_items(items):
        if path.suffix.casefold() in IMAGE_SUFFIXES:
            pages.append(path)
    if not pages:
        raise ValueError("none of the chosen items are images this can pack")
    return pages


def items_to_zip_convert(items: list[Path], out: Path, opts: dict, progress) -> int:
    staged = _staged_items(items)
    return zip_files(
        [path for _, path in staged],
        Path(out).parent,
        out,
        progress,
        archive_names=[name for name, _ in staged],
    )


def items_to_tgz_convert(items: list[Path], out: Path, opts: dict, progress) -> int:
    staged = _staged_items(items)
    out.parent.mkdir(parents=True, exist_ok=True)
    with _atomic_output(out) as partial:
        with tarfile.open(partial, "w:gz") as archive:
            for index, (name, path) in enumerate(staged, start=1):
                archive.add(path, arcname=name)
                progress(index, len(staged))
    return len(staged)


def items_to_7z_convert(items: list[Path], out: Path, opts: dict, progress) -> int:
    """Pack with 7-Zip. Items are staged under their archive names first so the
    archive's layout matches what the Creator listed, not the disk's."""
    staged = _staged_items(items)
    progress(0, len(staged))
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="onetool-create-7z-") as tmp:
        room = Path(tmp)
        for index, (name, path) in enumerate(staged, start=1):
            target = room / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            progress(index, len(staged), "staging")
        with _atomic_output(out) as partial:
            # 7-Zip expands the wildcard itself and stores names relative to it,
            # so the archive's layout is the staged layout.
            command = [which("7z", "7za", "7zz"), "a", "-t7z", str(partial), str(room / "*"), "-y"]
            if opts.get("password"):
                command.append(f"-p{opts['password']}")
            run(command, "7-Zip")
            if not partial.is_file() or partial.stat().st_size == 0:
                raise ValueError("7-Zip produced no archive")
    progress(len(staged), len(staged), "writing")
    return len(staged)


def items_to_epub_convert(items: list[Path], out: Path, opts: dict, progress) -> int:
    pages = _item_images(items)
    return cbz_to_epub.convert_paths(
        pages,
        out,
        opts.get("title") or out.stem,
        opts.get("creator") or "Unknown",
        progress=progress,
    )


def items_to_pdf_convert(items: list[Path], out: Path, opts: dict, progress) -> int:
    return images_to_pdf_convert(_item_images(items), out, opts, progress)


def items_to_tiff_convert(items: list[Path], out: Path, opts: dict, progress) -> int:
    pages = _item_images(items)
    progress(0, len(pages), "writing")
    out.parent.mkdir(parents=True, exist_ok=True)
    compression = (opts.get("compression") or "lzw").strip() or "lzw"
    names = [str(page.resolve()) for page in pages]
    with _atomic_output(out) as partial:
        # The partial file has no .tiff extension, so name the format explicitly
        # rather than letting ImageMagick guess from `.partial`.
        command = magick_command(
            [*names, "-compress", compression, f"TIFF:{partial}"],
            limit_resources=len(pages) > 1,
        )
        run(command, "ImageMagick")
        if not partial.is_file() or partial.stat().st_size == 0:
            raise ValueError("ImageMagick produced no TIFF")
    progress(len(pages), len(pages), "writing")
    return len(pages)


# --------------------------------------------------------------------------- #
# Images and video
# --------------------------------------------------------------------------- #


def find_magick() -> str | None:
    """Locate ImageMagick without matching Windows' unrelated convert.exe."""
    if sys.platform == "win32":
        return IMAGEMAGICK.locate()
    names = ("magick",) if sys.platform == "win32" else ("magick", "convert")
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def magick_command(args: list[str], *, limit_resources: bool = False) -> list[str]:
    binary = find_magick()
    if not binary:
        raise ValueError("ImageMagick was not found on this machine")
    # ImageMagick 7 takes a subcommand; 6's `convert` does not.
    limits = [
        "-limit", "thread", "2",
        "-limit", "memory", "512MiB",
        "-limit", "map", "1GiB",
    ] if limit_resources else []
    return [binary] + (["convert"] if Path(binary).stem.casefold() == "magick" else []) + limits + args


def heic_to_jpg_convert(source: Path, out: Path, opts: dict, progress) -> int:
    progress(0, 0)
    out.parent.mkdir(parents=True, exist_ok=True)
    quality = (opts.get("quality") or "85").strip()
    resize = (opts.get("resize") or "").strip()
    if find_magick():
        args = [str(source), "-quality", quality]
        if resize.isdigit():
            args += ["-resize", f"{resize}x{resize}>"]
        run(magick_command(args + [str(out)]), "ImageMagick")
    else:
        scale = ["-vf", f"scale='min({resize},iw)':-1"] if resize.isdigit() else []
        run([which("ffmpeg"), "-y", "-i", str(source), *scale, "-q:v", "3", str(out)], "ffmpeg")
    progress(1, 1)
    return 1


def png_to_webp_convert(source: Path, out: Path, opts: dict, progress) -> int:
    return raster_image_convert(source, out, opts, progress)


def _raster_output_signature(target: str, data: bytes) -> bool:
    if target in JPEG_SUFFIXES:
        return data.startswith(b"\xff\xd8\xff")
    if target == ".png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if target == ".webp":
        return data.startswith(b"RIFF") and data[8:12] == b"WEBP"
    return False


def raster_image_convert(source: Path, out: Path, opts: dict, progress) -> int:
    """Convert one raster image while preserving the requested output format."""
    target = out.suffix.casefold()
    if target not in JPEG_SUFFIXES | {".png", ".webp"}:
        raise ValueError(f"unsupported raster output format: {target or 'none'}")

    raw_quality = (opts.get("quality") or ("lossless" if target == ".webp" else "90")).strip().casefold()
    lossless = target == ".webp" and raw_quality == "lossless"
    resize = (opts.get("resize") or "").strip()
    resize_filter = f"scale='min({resize},iw)':-1" if resize.isdigit() else ""
    if lossless:
        quality = ""
    elif not raw_quality.isdigit() or not 1 <= int(raw_quality) <= 100:
        raise ValueError("Image quality must be a whole number from 1 to 100, or lossless for WebP")
    else:
        quality = raw_quality

    progress(0, 0)
    out.parent.mkdir(parents=True, exist_ok=True)
    partial = out.with_name(f".{out.name}.partial{out.suffix}")
    partial.unlink(missing_ok=True)
    try:
        if find_magick():
            first_frame = source.suffix.casefold() in MULTI_FRAME_SUFFIXES
            args = [f"{source}[0]" if first_frame else str(source)]
            if first_frame:
                args.append("-flatten")
            if target in JPEG_SUFFIXES:
                args += ["-background", "white", "-alpha", "remove", "-alpha", "off"]
            if resize.isdigit():
                args += ["-resize", f"{resize}x{resize}>"]
            if target == ".webp" and lossless:
                args += ["-define", "webp:lossless=true"]
            elif quality:
                args += ["-quality", quality]
            run(magick_command(args + [str(partial)]), "ImageMagick")
        else:
            args = [which("ffmpeg"), "-y", "-i", str(source), "-frames:v", "1"]
            if resize_filter:
                args += ["-vf", resize_filter]
            if target in JPEG_SUFFIXES:
                # ffmpeg's image quality scale is inverted: 2 is best and 31 is worst.
                qv = max(2, min(31, round(31 - (int(quality) - 1) * 29 / 99)))
                args += ["-q:v", str(qv)]
            elif target == ".webp":
                args += ["-c:v", "libwebp"] + (["-lossless", "1"] if lossless else ["-quality", quality])
            run(args + [str(partial)], "ffmpeg")

        if not partial.is_file() or partial.stat().st_size == 0:
            raise ValueError("image converter produced no output")
        data = partial.read_bytes()
        if not _raster_output_signature(target, data):
            raise ValueError(f"image converter produced invalid {target.lstrip('.').upper()} output")
        os.replace(partial, out)
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    progress(1, 1)
    return 1


def svg_to_png_convert(source: Path, out: Path, opts: dict, progress) -> int:
    progress(0, 0)
    out.parent.mkdir(parents=True, exist_ok=True)
    scale = (opts.get("scale") or "2x").strip().casefold().rstrip("x") or "2"
    background = (opts.get("bg") or "transparent").strip() or "none"
    density = str(int(float(scale) * 96))
    run(
        magick_command(["-background", "none" if background == "transparent" else background,
                        "-density", density, str(source), str(out)]),
        "ImageMagick",
    )
    progress(1, 1)
    return 1


def mov_to_mp4_convert(source: Path, out: Path, opts: dict, progress) -> int:
    progress(0, 0)
    out.parent.mkdir(parents=True, exist_ok=True)
    codec = (opts.get("codec") or "copy").strip().casefold()
    ffmpeg = which("ffmpeg")
    if codec == "copy":
        try:
            run([ffmpeg, "-y", "-i", str(source), "-c", "copy", "-movflags", "+faststart", str(out)], "ffmpeg")
            progress(1, 1)
            return 1
        except ValueError:
            pass  # codecs the MP4 container will not hold — fall through to a re-encode
    crf = (opts.get("crf") or "20").strip()
    run([ffmpeg, "-y", "-i", str(source), "-c:v", "libx264", "-crf", crf,
         "-c:a", "aac", "-movflags", "+faststart", str(out)], "ffmpeg")
    progress(1, 1)
    return 1


# --------------------------------------------------------------------------- #
# The registry
# --------------------------------------------------------------------------- #

TITLE_OPTS = (Option("title", "Title", "from filename"), Option("creator", "Creator", "Unknown"))
PDF_IMAGE_OPTS = (Option("dpi", "DPI", "150"), Option("quality", "JPEG quality", "90"))
RASTER_IMAGE_OPTS = (Option("quality", "Quality", "90"), Option("resize", "Max edge (px)", "original"))
PDF_PAGE_IMAGE_OPTS = (Option("page", "Page", "1"), Option("dpi", "DPI", "150"))

CONVERTERS = [
    Converter(
        id="cbz-epub", src="CBZ", dst="EPUB", category="Comics", kind="comic", glyph="CB", ext=".epub",
        title="Comic archive → EPUB", sub="one reading page per image, sorted naturally",
        drop_title="Drop .cbz files here",
        drop_sub="jpg, png, gif, webp and avif pages are read; anything else is ignored",
        blurb="One EPUB page per image, cover from page 1.",
        options=TITLE_OPTS, extensions=(".cbz", ".zip"), dependencies=("Python standard library",),
        convert=cbz_to_epub_convert, probe=cbz_probe,
    ),
    Converter(
        id="cbr-epub", src="CBR", dst="EPUB", category="Comics", kind="comic", glyph="CB", ext=".epub",
        title="Comic archive → EPUB", sub="RAR-packed comics",
        drop_title="Drop .cbr files here", drop_sub="unpacked with 7-Zip, then converted page by page",
        blurb="Same as CBZ, for RAR-packed comics.",
        options=TITLE_OPTS, extensions=(".cbr", ".rar"), helper=SEVEN_ZIP, dependencies=("7-Zip", "Python standard library"),
        convert=cbr_to_epub_convert,
    ),
    Converter(
        id="cbz-pdf", src="CBZ", dst="PDF", category="Comics", kind="comic", glyph="CB", ext=".pdf",
        title="Comic archive â†’ PDF", sub="direct JPEG/PNG path; fallback for other images",
        drop_title="Drop .cbz files here", drop_sub="JPEG pages are embedded without recompression",
        blurb="Turn a comic archive into a shareable PDF without rerasterising JPEG pages.", options=PDF_IMAGE_OPTS,
        extensions=(".cbz", ".zip"), helper=IMAGEMAGICK, dependencies=("ImageMagick", "Python standard library"),
        convert=cbz_to_pdf_convert,
    ),
    Converter(
        id="cbr-pdf", src="CBR", dst="PDF", category="Comics", kind="comic", glyph="CB", ext=".pdf",
        title="Comic archive â†’ PDF", sub="RAR-packed; direct JPEG/PNG path",
        drop_title="Drop .cbr files here", drop_sub="unpacked with 7-Zip, then embedded without JPEG recompression",
        blurb="Make a PDF from a RAR comic archive using the fastest compatible path.", options=PDF_IMAGE_OPTS,
        extensions=(".cbr", ".rar"), helper=SEVEN_ZIP, requirements=(SEVEN_ZIP, IMAGEMAGICK),
        dependencies=("7-Zip", "ImageMagick", "Python standard library"), convert=cbr_to_pdf_convert,
    ),
    Converter(
        id="cbr-cbz", src="CBR", dst="CBZ", category="Comics", kind="comic", glyph="CB", ext=".cbz",
        title="CBR -> CBZ", sub="repacked without changing comic pages",
        blurb="Convert a RAR comic archive into the ZIP-based CBZ format.",
        extensions=(".cbr",), helper=SEVEN_ZIP, dependencies=("7-Zip", "Python standard library"), convert=repack_convert,
    ),
    Converter(
        id="pdf-cbz", src="PDF", dst="CBZ", category="Comics", kind="doc", glyph="PD", ext=".cbz",
        title="PDF → comic archive", sub="each page rendered as an image",
        drop_title="Drop .pdf files here", drop_sub="one image per page, packed into a .cbz",
        blurb="Rasterise a PDF into a comic archive.",
        options=(Option("dpi", "DPI", "300"), Option("format", "Page format", "jpg")),
        extensions=(".pdf",), helper=POPPLER_RENDER, dependencies=("Poppler pdftoppm", "Python standard library"), convert=pdf_to_cbz_convert,
    ),
    Converter(
        id="heic-jpg", src="HEIC", dst="JPG", category="Images", kind="image", glyph="IM", ext=".jpg",
        title="HEIC → JPG", sub="batch photo conversion",
        drop_title="Drop .heic photos here", drop_sub="drop a whole folder — they convert one after another",
        blurb="iPhone photos into something everything opens.",
        options=(Option("quality", "Quality", "85"), Option("resize", "Max edge (px)", "original")),
        extensions=(".heic", ".heif"), helper=FFMPEG, helper_alternatives=(IMAGEMAGICK,),
        dependencies=("ffmpeg or ImageMagick",), convert=heic_to_jpg_convert,
    ),
    Converter(
        id="heic-png", src="HEIC", dst="PNG", category="Images", kind="image", glyph="IM", ext=".png",
        title="HEIC -> PNG", sub="lossless-compatible raster output",
        blurb="Convert HEIC photos into PNG files.", options=RASTER_IMAGE_OPTS,
        extensions=(".heic", ".heif"), helper=FFMPEG, helper_alternatives=(IMAGEMAGICK,),
        dependencies=("ffmpeg or ImageMagick",), convert=raster_image_convert,
    ),
    Converter(
        id="heic-webp", src="HEIC", dst="WebP", category="Images", kind="image", glyph="IM", ext=".webp",
        title="HEIC -> WebP", sub="smaller web images",
        blurb="Convert HEIC photos into compact WebP files.", options=RASTER_IMAGE_OPTS,
        extensions=(".heic", ".heif"), helper=FFMPEG, helper_alternatives=(IMAGEMAGICK,),
        dependencies=("ffmpeg or ImageMagick",), convert=raster_image_convert,
    ),
    Converter(
        id="heic-pdf", src="HEIC", dst="PDF", category="Images", kind="image", glyph="IM", ext=".pdf",
        title="HEIC -> PDF", sub="one photo, one PDF page",
        blurb="Put an HEIC photo into a portable PDF.", options=PDF_IMAGE_OPTS,
        extensions=(".heic", ".heif"), helper=FFMPEG, helper_alternatives=(IMAGEMAGICK,),
        dependencies=("ffmpeg or ImageMagick",), convert=raster_image_to_pdf_convert,
    ),
    Converter(
        id="png-webp", src="PNG", dst="WebP", category="Images", kind="image", glyph="IM", ext=".webp",
        title="PNG → WebP", sub="smaller files, same pixels",
        drop_title="Drop .png files here", drop_sub="lossless by default",
        blurb="Shrink PNGs without visible loss.",
        options=(Option("quality", "Quality", "lossless"), Option("resize", "Max edge (px)", "original")),
        extensions=(".png",), helper=FFMPEG, helper_alternatives=(IMAGEMAGICK,),
        dependencies=("ffmpeg or ImageMagick",), convert=png_to_webp_convert,
    ),
    Converter(
        id="png-jpg", src="PNG", dst="JPG", category="Images", kind="image", glyph="IM", ext=".jpg",
        title="PNG -> JPG", sub="flattened against white",
        drop_title="Drop .png files here", drop_sub="transparent pixels become white",
        blurb="Convert a PNG into a widely compatible JPEG photo.", options=RASTER_IMAGE_OPTS,
        extensions=(".png",), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_convert,
    ),
    Converter(
        id="jpg-png", src="JPG", dst="PNG", category="Images", kind="image", glyph="IM", ext=".png",
        title="JPG -> PNG", sub="lossless raster output",
        drop_title="Drop .jpg or .jpeg files here", drop_sub="one image per output file",
        blurb="Turn a JPEG into a lossless PNG.", options=(Option("resize", "Max edge (px)", "original"),),
        extensions=(".jpg", ".jpeg"), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_convert,
    ),
    Converter(
        id="jpg-webp", src="JPG", dst="WebP", category="Images", kind="image", glyph="IM", ext=".webp",
        title="JPG -> WebP", sub="smaller web images",
        drop_title="Drop .jpg or .jpeg files here", drop_sub="quality is adjustable",
        blurb="Make a compact WebP from a JPEG.", options=RASTER_IMAGE_OPTS,
        extensions=(".jpg", ".jpeg"), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_convert,
    ),
    Converter(
        id="webp-jpg", src="WebP", dst="JPG", category="Images", kind="image", glyph="IM", ext=".jpg",
        title="WebP -> JPG", sub="compatible photo output",
        drop_title="Drop .webp files here", drop_sub="transparent pixels become white",
        blurb="Convert WebP images into JPEGs.", options=RASTER_IMAGE_OPTS,
        extensions=(".webp",), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_convert,
    ),
    Converter(
        id="webp-png", src="WebP", dst="PNG", category="Images", kind="image", glyph="IM", ext=".png",
        title="WebP -> PNG", sub="lossless raster output",
        drop_title="Drop .webp files here", drop_sub="one image per output file",
        blurb="Turn a WebP into a lossless PNG.", options=(Option("resize", "Max edge (px)", "original"),),
        extensions=(".webp",), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_convert,
    ),
    Converter(
        id="webp-pdf", src="WebP", dst="PDF", category="Images", kind="image", glyph="IM", ext=".pdf",
        title="WebP -> PDF", sub="one image, one PDF page",
        blurb="Put a WebP image into a portable PDF.", options=PDF_IMAGE_OPTS,
        extensions=(".webp",), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_to_pdf_convert,
    ),
    Converter(
        id="png-pdf", src="PNG", dst="PDF", category="Images", kind="image", glyph="IM", ext=".pdf",
        title="PNG â†’ PDF", sub="one image, one PDF page",
        blurb="Wrap an image in a clean PDF.", options=PDF_IMAGE_OPTS, extensions=(".png",),
        dependencies=("Python standard library; ImageMagick for incompatible PNGs",), convert=image_to_pdf_convert,
    ),
    Converter(
        id="jpg-pdf", src="JPG", dst="PDF", category="Images", kind="image", glyph="IM", ext=".pdf",
        title="JPG â†’ PDF", sub="one image, one PDF page",
        blurb="Turn a photograph into a PDF.", options=PDF_IMAGE_OPTS, extensions=(".jpg", ".jpeg"),
        dependencies=("Python standard library",), convert=image_to_pdf_convert,
    ),
    Converter(
        id="pdf-jpg", src="PDF", dst="JPG", category="Images", kind="doc", glyph="PD", ext=".jpg",
        title="PDF → JPG", sub="one page rendered as a photo",
        drop_title="Drop .pdf files here", drop_sub="page 1 unless you choose another",
        blurb="Render a single PDF page as a JPEG. For every page at once, use PDF → comic archive.",
        options=PDF_PAGE_IMAGE_OPTS, extensions=(".pdf",), helper=POPPLER_RENDER,
        dependencies=("Poppler pdftoppm",), convert=pdf_to_image_convert,
    ),
    Converter(
        id="pdf-png", src="PDF", dst="PNG", category="Images", kind="doc", glyph="PD", ext=".png",
        title="PDF → PNG", sub="one page rendered losslessly",
        drop_title="Drop .pdf files here", drop_sub="page 1 unless you choose another",
        blurb="Render a single PDF page as a lossless PNG. For every page at once, use PDF → comic archive.",
        options=PDF_PAGE_IMAGE_OPTS, extensions=(".pdf",), helper=POPPLER_RENDER,
        dependencies=("Poppler pdftoppm",), convert=pdf_to_image_convert,
    ),
    Converter(
        id="gif-jpg", src="GIF", dst="JPG", category="Images", kind="image", glyph="IM", ext=".jpg",
        title="GIF → JPG", sub="first frame, flattened against white",
        drop_title="Drop .gif files here", drop_sub="animations keep their first frame only",
        blurb="Take the opening frame of a GIF as a JPEG.", options=RASTER_IMAGE_OPTS,
        extensions=(".gif",), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_convert,
    ),
    Converter(
        id="gif-png", src="GIF", dst="PNG", category="Images", kind="image", glyph="IM", ext=".png",
        title="GIF → PNG", sub="first frame, transparency kept",
        drop_title="Drop .gif files here", drop_sub="animations keep their first frame only",
        blurb="Take the opening frame of a GIF as a lossless PNG.",
        options=(Option("resize", "Max edge (px)", "original"),),
        extensions=(".gif",), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_convert,
    ),
    Converter(
        id="gif-pdf", src="GIF", dst="PDF", category="Images", kind="image", glyph="IM", ext=".pdf",
        title="GIF → PDF", sub="first frame, one PDF page",
        blurb="Put the opening frame of a GIF into a PDF.", options=PDF_IMAGE_OPTS,
        extensions=(".gif",), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_to_pdf_convert,
    ),
    Converter(
        id="avif-jpg", src="AVIF", dst="JPG", category="Images", kind="image", glyph="IM", ext=".jpg",
        title="AVIF → JPG", sub="compatible photo output",
        drop_title="Drop .avif files here", drop_sub="transparent pixels become white",
        blurb="Convert AVIF images into JPEGs everything opens.", options=RASTER_IMAGE_OPTS,
        extensions=(".avif",), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_convert,
    ),
    Converter(
        id="avif-png", src="AVIF", dst="PNG", category="Images", kind="image", glyph="IM", ext=".png",
        title="AVIF → PNG", sub="lossless raster output",
        drop_title="Drop .avif files here", drop_sub="one image per output file",
        blurb="Turn an AVIF into a lossless PNG.",
        options=(Option("resize", "Max edge (px)", "original"),),
        extensions=(".avif",), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_convert,
    ),
    Converter(
        id="avif-pdf", src="AVIF", dst="PDF", category="Images", kind="image", glyph="IM", ext=".pdf",
        title="AVIF → PDF", sub="one image, one PDF page",
        blurb="Put an AVIF image into a portable PDF.", options=PDF_IMAGE_OPTS,
        extensions=(".avif",), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_to_pdf_convert,
    ),
    Converter(
        id="bmp-jpg", src="BMP", dst="JPG", category="Images", kind="image", glyph="IM", ext=".jpg",
        title="BMP → JPG", sub="much smaller, same picture",
        drop_title="Drop .bmp files here", drop_sub="uncompressed bitmaps shrink a lot",
        blurb="Compress an uncompressed bitmap into a JPEG.", options=RASTER_IMAGE_OPTS,
        extensions=(".bmp",), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_convert,
    ),
    Converter(
        id="bmp-png", src="BMP", dst="PNG", category="Images", kind="image", glyph="IM", ext=".png",
        title="BMP → PNG", sub="smaller with nothing lost",
        drop_title="Drop .bmp files here", drop_sub="lossless, just packed properly",
        blurb="Pack a bitmap into a lossless PNG.",
        options=(Option("resize", "Max edge (px)", "original"),),
        extensions=(".bmp",), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_convert,
    ),
    Converter(
        id="bmp-pdf", src="BMP", dst="PDF", category="Images", kind="image", glyph="IM", ext=".pdf",
        title="BMP → PDF", sub="one image, one PDF page",
        blurb="Put a bitmap into a portable PDF.", options=PDF_IMAGE_OPTS,
        extensions=(".bmp",), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_to_pdf_convert,
    ),
    Converter(
        id="tiff-jpg", src="TIFF", dst="JPG", category="Images", kind="image", glyph="IM", ext=".jpg",
        title="TIFF → JPG", sub="first page, flattened against white",
        drop_title="Drop .tif or .tiff files here", drop_sub="multi-page scans keep their first page",
        blurb="Turn a scan into a JPEG that opens anywhere.", options=RASTER_IMAGE_OPTS,
        extensions=(".tiff", ".tif"), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_convert,
    ),
    Converter(
        id="tiff-png", src="TIFF", dst="PNG", category="Images", kind="image", glyph="IM", ext=".png",
        title="TIFF → PNG", sub="first page, nothing lost",
        drop_title="Drop .tif or .tiff files here", drop_sub="multi-page scans keep their first page",
        blurb="Convert a scan into a lossless PNG.",
        options=(Option("resize", "Max edge (px)", "original"),),
        extensions=(".tiff", ".tif"), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_convert,
    ),
    Converter(
        id="tiff-pdf", src="TIFF", dst="PDF", category="Images", kind="image", glyph="IM", ext=".pdf",
        title="TIFF → PDF", sub="first page, one PDF page",
        blurb="Put a scanned page into a portable PDF.", options=PDF_IMAGE_OPTS,
        extensions=(".tiff", ".tif"), helper=IMAGEMAGICK, helper_alternatives=(FFMPEG,),
        dependencies=("ImageMagick or ffmpeg",), convert=raster_image_to_pdf_convert,
    ),
    Converter(
        id="svg-png", src="SVG", dst="PNG", category="Images", kind="image", glyph="IM", ext=".png",
        title="SVG → PNG", sub="rendered at any scale",
        drop_title="Drop .svg files here", drop_sub="vector rendered to raster",
        blurb="Render vectors at 1x, 2x or 3x.",
        options=(Option("scale", "Scale", "2x"), Option("bg", "Background", "transparent")),
        extensions=(".svg",), helper=IMAGEMAGICK, dependencies=("ImageMagick",), convert=svg_to_png_convert,
    ),
    Converter(
        id="svg-jpg", src="SVG", dst="JPG", category="Images", kind="image", glyph="IM", ext=".jpg",
        title="SVG -> JPG", sub="rasterised photo output",
        blurb="Render a vector image into a compatible JPEG.", options=RASTER_IMAGE_OPTS,
        extensions=(".svg",), helper=IMAGEMAGICK, dependencies=("ImageMagick",), convert=raster_image_convert,
    ),
    Converter(
        id="svg-pdf", src="SVG", dst="PDF", category="Images", kind="image", glyph="IM", ext=".pdf",
        title="SVG -> PDF", sub="rendered vector page",
        blurb="Put a vector image into a portable PDF.", options=PDF_IMAGE_OPTS,
        extensions=(".svg",), helper=IMAGEMAGICK, dependencies=("ImageMagick",), convert=svg_to_pdf_convert,
    ),
    Converter(
        id="raw-dng", src="RAW", dst="DNG", category="Images", kind="image", glyph="IM", ext=".dng",
        blurb="Camera RAW into a standard negative.", extensions=(".cr2", ".nef", ".arw"), helper=RAW_TOOLS,
        dependencies=("Future: LibRaw or Exiv2",),
    ),
    Converter(
        id="docx-pdf", src="DOCX", dst="PDF", category="Documents", kind="doc", glyph="DO", ext=".pdf",
        title="DOCX → PDF", sub="layout preserved, fonts embedded",
        drop_title="Drop .docx files here", drop_sub="large files are fine — they convert one at a time",
        blurb="Word files into a fixed page.",
        extensions=(".docx", ".doc", ".odt"), helper=LIBREOFFICE, dependencies=("LibreOffice",), convert=docx_to_pdf_convert,
    ),
    Converter(
        id="docx-epub", src="DOCX", dst="EPUB", category="Documents", kind="doc", glyph="DO", ext=".epub",
        title="Document â†’ EPUB", sub="reflowable e-book export",
        drop_title="Drop .docx files here", drop_sub="DOC, DOCX and ODT are exported by LibreOffice",
        blurb="Make a reflowable EPUB from a document.", extensions=(".docx", ".doc", ".odt"),
        helper=LIBREOFFICE, dependencies=("LibreOffice",), convert=docx_to_epub_convert,
    ),
    Converter(
        id="docx-txt", src="DOCX", dst="TXT", category="Documents", kind="doc", glyph="DO", ext=".txt",
        title="Document â†’ text", sub="plain text export",
        blurb="Pull readable text out of a document.", extensions=(".docx", ".doc", ".odt"),
        helper=LIBREOFFICE, dependencies=("LibreOffice",), convert=docx_to_txt_convert,
    ),
    Converter(
        id="md-pdf", src="MD", dst="PDF", category="Documents", kind="doc", glyph="DO", ext=".pdf",
        blurb="Notes into a printable page.", extensions=(".md",), helper=PANDOC,
        requirements=(PANDOC, PDF_RENDERER),
        dependencies=("Future: Pandoc + a PDF renderer",),
    ),
    Converter(
        id="pdf-txt", src="PDF", dst="TXT", category="Documents", kind="doc", glyph="DO", ext=".txt",
        title="PDF → text", sub="plain text extraction",
        drop_title="Drop .pdf files here", drop_sub="text layer only — scans need OCR",
        blurb="Pull plain text out of a PDF.",
        extensions=(".pdf",), helper=POPPLER_TEXT, dependencies=("Poppler pdftotext", "Python standard library"), convert=pdf_to_txt_convert,
    ),
    Converter(
        id="pdf-md", src="PDF", dst="MD", category="Documents", kind="doc", glyph="DO", ext=".md",
        title="PDF → Markdown", sub="layout-aware local extraction",
        drop_title="Drop .pdf files here", drop_sub="native-text PDFs become structured Markdown; scans need OCR",
        blurb="Extract headings, lists, links, tables and reading order locally.",
        extensions=(".pdf",), dependencies=("Node.js + Firecrawl pdf-inspector (optional)",), convert=pdf_to_md_convert,
    ),
    Converter(
        id="pdf-epub", src="PDF", dst="EPUB", category="Documents", kind="doc", glyph="DO", ext=".epub",
        title="PDF -> EPUB", sub="reflowable ebook export",
        blurb="Convert a PDF into an EPUB using Calibre.", extensions=(".pdf",), helper=CALIBRE,
        dependencies=("Calibre ebook-convert",), convert=calibre_convert,
    ),
    Converter(
        id="epub-cbz", src="EPUB", dst="CBZ", category="Ebooks", kind="doc", glyph="EB", ext=".cbz",
        title="EPUB → comic archive", sub="images pulled back out in reading order",
        drop_title="Drop .epub files here", drop_sub="only the image resources are packed",
        blurb="Go back the other way.",
        extensions=(".epub",), convert=epub_to_cbz_convert,
    ),
    Converter(
        id="epub-mobi", src="EPUB", dst="MOBI", category="Ebooks", kind="doc", glyph="EB", ext=".mobi",
        title="EPUB â†’ MOBI", sub="for older Kindles",
        blurb="Convert an EPUB for older Kindle devices.", extensions=(".epub",), helper=CALIBRE,
        dependencies=("Calibre ebook-convert",), convert=calibre_convert,
    ),
    Converter(
        id="epub-txt", src="EPUB", dst="TXT", category="Ebooks", kind="doc", glyph="EB", ext=".txt",
        title="EPUB -> TXT", sub="plain text extraction",
        blurb="Extract readable text from an EPUB.", extensions=(".epub",),
        dependencies=("Python standard library",), convert=epub_to_txt_convert,
    ),
    Converter(
        id="azw3-epub", src="AZW3", dst="EPUB", category="Ebooks", kind="doc", glyph="EB", ext=".epub",
        title="AZW3 â†’ EPUB", sub="open Kindle books",
        blurb="Turn a Kindle book into open EPUB.", extensions=(".azw3",), helper=CALIBRE,
        dependencies=("Calibre ebook-convert",), convert=calibre_convert,
    ),
    Converter(
        id="azw3-pdf", src="AZW3", dst="PDF", category="Ebooks", kind="doc", glyph="EB", ext=".pdf",
        title="AZW3 -> PDF", sub="printable Kindle export",
        blurb="Make a PDF from a Kindle AZW3 book.", extensions=(".azw3",), helper=CALIBRE,
        dependencies=("Calibre ebook-convert",), convert=calibre_convert,
    ),
    Converter(
        id="epub-pdf", src="EPUB", dst="PDF", category="Ebooks", kind="doc", glyph="EB", ext=".pdf",
        title="EPUB â†’ PDF", sub="fixed-layout copy",
        blurb="Make a printable PDF from an image-only EPUB.", extensions=(".epub",),
        dependencies=("Python standard library; Calibre fallback",), convert=epub_to_pdf_convert,
    ),
    Converter(
        id="rar-zip", src="RAR", dst="ZIP", category="Archives", kind="doc", glyph="AR", ext=".zip",
        title="RAR → ZIP", sub="repacked, contents untouched",
        drop_title="Drop .rar files here", drop_sub="unpacked with 7-Zip and re-zipped",
        blurb="Repack RAR as plain ZIP.",
        extensions=(".rar",), helper=SEVEN_ZIP, dependencies=("7-Zip", "Python standard library"), convert=repack_convert,
    ),
    Converter(
        id="rar-cbz", src="RAR", dst="CBZ", category="Comics", kind="comic", glyph="CB", ext=".cbz",
        title="RAR -> CBZ", sub="repacked as a comic archive",
        blurb="Turn a RAR-packed comic into a CBZ archive.",
        extensions=(".rar",), helper=SEVEN_ZIP, dependencies=("7-Zip", "Python standard library"), convert=repack_convert,
    ),
    Converter(
        id="7z-zip", src="7Z", dst="ZIP", category="Archives", kind="doc", glyph="AR", ext=".zip",
        title="7z → ZIP", sub="repacked for wider compatibility",
        drop_title="Drop .7z files here", drop_sub="unpacked with 7-Zip and re-zipped",
        blurb="Wider compatibility.",
        extensions=(".7z",), helper=SEVEN_ZIP, dependencies=("7-Zip", "Python standard library"), convert=repack_convert,
    ),
    Converter(
        id="7z-cbz", src="7Z", dst="CBZ", category="Comics", kind="comic", glyph="CB", ext=".cbz",
        title="7Z -> CBZ", sub="repacked as a comic archive",
        blurb="Turn a 7Z-packed comic into a CBZ archive.",
        extensions=(".7z",), helper=SEVEN_ZIP, dependencies=("7-Zip", "Python standard library"), convert=repack_convert,
    ),
    Converter(
        id="mov-mp4", src="MOV", dst="MP4", category="Video", kind="doc", glyph="VI", ext=".mp4",
        title="MOV → MP4", sub="stream copy when possible",
        drop_title="Drop .mov files here", drop_sub="copied without re-encoding where the codecs allow",
        blurb="Re-wrap or re-encode video.",
        options=(Option("codec", "Codec", "copy"), Option("crf", "Quality (CRF)", "20")),
        extensions=(".mov",), helper=FFMPEG, dependencies=("ffmpeg",), convert=mov_to_mp4_convert,
    ),

    # Creator — many items into one container. These claim no extensions, so a
    # dropped file can never route to them; the Creator asks for them by id.
    Converter(
        id="items-zip", src="Items", dst="ZIP", category="Create", kind="doc", glyph="ZI", ext=".zip",
        title="Items → ZIP", sub="one archive from everything on the list",
        blurb="Pack the chosen files and folders into a ZIP archive.",
        dependencies=("Python standard library",), multi=True, convert=items_to_zip_convert,
    ),
    Converter(
        id="items-cbz", src="Items", dst="CBZ", category="Create", kind="comic", glyph="CB", ext=".cbz",
        title="Items → CBZ", sub="a comic archive in reading order",
        blurb="Pack images into a CBZ comic archive.",
        dependencies=("Python standard library",), multi=True, convert=items_to_zip_convert,
    ),
    Converter(
        id="items-tgz", src="Items", dst="TGZ", category="Create", kind="doc", glyph="TG", ext=".tar.gz",
        title="Items → TAR.GZ", sub="gzip-compressed tar",
        blurb="Pack the chosen files and folders into a gzipped tar archive.",
        dependencies=("Python standard library",), multi=True, convert=items_to_tgz_convert,
    ),
    Converter(
        id="items-7z", src="Items", dst="7Z", category="Create", kind="doc", glyph="7Z", ext=".7z",
        title="Items → 7Z", sub="7-Zip's own format",
        blurb="Pack the chosen files and folders into a 7z archive.",
        options=(Option("password", "Password", "none"),),
        helper=SEVEN_ZIP, dependencies=("7-Zip",), multi=True, convert=items_to_7z_convert,
    ),
    Converter(
        id="items-cb7", src="Items", dst="CB7", category="Create", kind="comic", glyph="CB", ext=".cb7",
        title="Items → CB7", sub="a 7z-packed comic archive",
        blurb="Pack images into a CB7 comic archive.",
        helper=SEVEN_ZIP, dependencies=("7-Zip",), multi=True, convert=items_to_7z_convert,
    ),
    Converter(
        id="items-epub", src="Items", dst="EPUB", category="Create", kind="comic", glyph="EP", ext=".epub",
        title="Items → EPUB", sub="fixed-layout, one page per image",
        blurb="Build a fixed-layout EPUB from images.",
        options=TITLE_OPTS, dependencies=("Python standard library",),
        multi=True, convert=items_to_epub_convert,
    ),
    Converter(
        id="items-pdf", src="Items", dst="PDF", category="Create", kind="doc", glyph="PD", ext=".pdf",
        title="Items → PDF", sub="JPEG and PNG pages embedded without re-encoding",
        blurb="Build a PDF from images.",
        options=PDF_IMAGE_OPTS, helper=IMAGEMAGICK, dependencies=("ImageMagick",),
        multi=True, convert=items_to_pdf_convert,
    ),
    Converter(
        id="items-tiff", src="Items", dst="TIFF", category="Create", kind="image", glyph="TI", ext=".tiff",
        title="Items → multi-page TIFF", sub="one frame per image",
        blurb="Build a single multi-page TIFF from images.",
        options=(Option("compression", "Compression", "lzw"),),
        helper=IMAGEMAGICK, dependencies=("ImageMagick",), multi=True, convert=items_to_tiff_convert,
    ),
]

REGISTRY = Registry(CONVERTERS)
