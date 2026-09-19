from __future__ import annotations

from formats_common import *
from formats_pdf_writer import _jpeg_metadata

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

__all__ = ['_PdfStream', '_DirectPdfNotSafe', '_pdf_line', '_pdf_xref', '_pdf_object', '_pdf_ref', '_pdf_inline_dictionary', '_pdf_stream_filter', '_pdf_page_references', '_pdf_content_is_image_only', '_pdf_jpeg_ranges', '_valid_extracted_jpeg', '_try_direct_pdf_to_cbz']
