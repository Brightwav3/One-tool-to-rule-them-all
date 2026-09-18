#!/usr/bin/env python3
"""Every conversion the app knows about.

The CONVERTERS catalogue and REGISTRY live here. Direct JPEG/PNG PDF embed and
JPEG-from-PDF extract live in direct_pdf.py and are re-exported so
`import formats` stays the public surface.
"""

from __future__ import annotations

import ctypes
import atexit
import json
import mmap  # tests patch formats.mmap.mmap; keep the module on this facade
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
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
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


# --------------------------------------------------------------------------- #
# Direct PDF kernel (implemented in direct_pdf.py, re-exported for the facade)
# --------------------------------------------------------------------------- #

from direct_pdf import (  # noqa: E402
    JPEG_SOF_MARKERS,
    PageSource,
    PdfPageSource,
    _DirectPdfNotSafe,
    _PdfImage,
    _PdfStream,
    _direct_pdf_from_archive,
    _direct_pdf_from_paths,
    _direct_pdf_page_bytes,
    _image_to_jpeg,
    _jpeg_exif_orientation,
    _jpeg_image,
    _jpeg_metadata,
    _jpeg_properties,
    _jpeg_quality,
    _jpeg_segments,
    _orientation_matrix,
    _page_dimensions,
    _page_image,
    _pdf_content_is_image_only,
    _pdf_inline_dictionary,
    _pdf_jpeg_ranges,
    _pdf_line,
    _pdf_literal,
    _pdf_number,
    _pdf_object,
    _pdf_page_references,
    _pdf_page_size,
    _pdf_ref,
    _pdf_stream_filter,
    _pdf_xref,
    _png_image,
    _png_paeth,
    _png_to_jpeg,
    _png_unfilter,
    _try_direct_pdf_to_cbz,
    _valid_extracted_jpeg,
    _write_direct_jpeg_pdf,
    _write_direct_jpeg_pdf_to_path,
    _write_direct_pdf_sources,
    write_direct_pdf,
)


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


def creator_flag(opts: dict, key: str, default: bool = False) -> bool:
    """Read a Creator toggle. The UI sends JSON booleans as strings."""
    raw = opts.get(key)
    if raw is None or raw == "":
        return default
    return str(raw).strip().casefold() in {"1", "true", "on", "yes"}


# Store means "packed but not compressed", which every container spells its own
# way. Anything unrecognised falls back to the middle setting rather than failing.
COMPRESSION_LEVELS = {"store": 0, "normal": 6, "max": 9}
SEVEN_ZIP_LEVELS = {"store": "0", "normal": "5", "max": "9"}
TIFF_COMPRESSION = {"store": "none", "normal": "lzw", "max": "zip"}


def creator_level(opts: dict) -> str:
    level = str(opts.get("compress") or "Normal").strip().casefold()
    return level if level in COMPRESSION_LEVELS else "normal"


def _staged_items(items: list[Path], opts: dict | None = None) -> list[tuple[str, Path]]:
    """Flatten the picked items into (archive name, file) pairs.

    A picked folder contributes its whole tree under its own name; a picked file
    contributes itself. Names are made unique so two files called `cover.jpg`
    from different folders cannot silently overwrite one another.

    `flatten` drops the folders and keeps the files; `rename` renumbers the pages
    of a comic so a reader keeps the order the Creator showed.
    """
    opts = opts or {}
    flatten = creator_flag(opts, "flatten")
    pairs: list[tuple[str, Path]] = []
    for item in items:
        item = item.expanduser()
        if item.is_dir():
            for member in sorted(item.rglob("*"), key=lambda p: natural(str(p))):
                if member.is_file():
                    relative = member.relative_to(item).as_posix()
                    pairs.append((member.name if flatten else f"{item.name}/{relative}", member))
        elif item.is_file():
            pairs.append((item.name, item))
        else:
            raise ValueError(f"{item.name} is no longer at its saved path")
    if not pairs:
        raise ValueError("there is nothing to pack — every item is empty or missing")

    if creator_flag(opts, "rename") and all(p.suffix.casefold() in IMAGE_SUFFIXES for _, p in pairs):
        width = max(3, len(str(len(pairs))))
        return [
            (f"{index:0{width}d}{path.suffix.casefold()}", path)
            for index, (_, path) in enumerate(pairs, start=1)
        ]

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


def _item_images(items: list[Path], opts: dict | None = None) -> list[Path]:
    """The images inside the picked items, in the order the user sees them."""
    pages = [path for _, path in _staged_items(items, opts) if path.suffix.casefold() in IMAGE_SUFFIXES]
    if not pages:
        raise ValueError("none of the chosen items are images this can pack")
    return pages


def comic_info(title: str, pages: int, creator: str = "") -> bytes:
    """The metadata file most comic readers look for. Deliberately minimal:
    only fields the Creator actually knows are written."""
    fields = [("Title", title), ("Series", title), ("Writer", creator), ("PageCount", str(pages))]
    body = "".join(
        f"  <{tag}>{value.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')}</{tag}>\n"
        for tag, value in fields if value
    )
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
        f"{body}</ComicInfo>\n"
    ).encode("utf-8")


ARCHIVE_SUFFIXES = {".zip", ".cbz", ".epub"}


def probe_item(path: Path) -> dict:
    """What the Creator can honestly say about one item before building.

    `pages` is None when nothing here can open the file, and the row is left
    blank rather than showing a guessed number.
    """
    path = Path(path).expanduser()
    kind, pages, size = "File", None, 0
    if path.is_dir():
        members = [p for p in path.rglob("*") if p.is_file()]
        return {
            "path": str(path), "name": path.name, "ext": "DIR", "kind": "Folder",
            "pages": len([p for p in members if p.suffix.casefold() in IMAGE_SUFFIXES]) or None,
            "files": len(members),
            "size": sum(p.stat().st_size for p in members),
        }
    if not path.is_file():
        raise ValueError(f"{path.name} is no longer at its saved path")

    suffix = path.suffix.casefold()
    size = path.stat().st_size
    if suffix in IMAGE_SUFFIXES:
        kind, pages = "Image", 1
    elif suffix in ARCHIVE_SUFFIXES:
        kind = "Archive"
        try:
            with zipfile.ZipFile(path) as archive:
                pages = len([n for n in archive.namelist() if Path(n).suffix.casefold() in IMAGE_SUFFIXES]) or None
        except (OSError, zipfile.BadZipFile):
            pages = None
    elif suffix == ".pdf":
        kind = "Document"
        try:
            pages = _pdf_page_count(path)
        except Exception:  # an unreadable PDF is blank, not an error on a list
            pages = None
    elif suffix in {".txt", ".md"}:
        kind = "Text"
    return {
        "path": str(path), "name": path.name, "ext": (suffix.lstrip(".") or "file").upper()[:4],
        "kind": kind, "pages": pages, "files": 1, "size": size,
    }


def items_to_zip_convert(items: list[Path], out: Path, opts: dict, progress) -> int:
    staged = _staged_items(items, opts)
    level = COMPRESSION_LEVELS[creator_level(opts)]
    out.parent.mkdir(parents=True, exist_ok=True)
    with _atomic_output(out) as partial:
        with zipfile.ZipFile(
            partial, "w",
            compression=zipfile.ZIP_STORED if level == 0 else zipfile.ZIP_DEFLATED,
            compresslevel=None if level == 0 else level,
        ) as archive:
            for index, (name, path) in enumerate(staged, start=1):
                # An already-compressed image gains nothing from a second pass.
                archive.write(
                    path, name,
                    compress_type=(
                        zipfile.ZIP_STORED
                        if level == 0 or path.suffix.casefold() in IMAGE_SUFFIXES
                        else zipfile.ZIP_DEFLATED
                    ),
                )
                progress(index, len(staged))
            if creator_flag(opts, "meta"):
                archive.writestr(
                    "ComicInfo.xml",
                    comic_info(opts.get("title") or out.stem, len(staged), opts.get("creator") or ""),
                )
    return len(staged)


def items_to_tgz_convert(items: list[Path], out: Path, opts: dict, progress) -> int:
    staged = _staged_items(items, opts)
    level = COMPRESSION_LEVELS[creator_level(opts)]
    out.parent.mkdir(parents=True, exist_ok=True)
    with _atomic_output(out) as partial:
        # gzip has no level 0, so Store writes a plain tar inside the same name.
        mode = "w" if level == 0 else "w:gz"
        opened = tarfile.open(partial, mode) if level == 0 else tarfile.open(partial, mode, compresslevel=level)
        with opened as archive:
            for index, (name, path) in enumerate(staged, start=1):
                archive.add(path, arcname=name)
                progress(index, len(staged))
    return len(staged)


def items_to_7z_convert(items: list[Path], out: Path, opts: dict, progress) -> int:
    """Pack with 7-Zip. Items are staged under their archive names first so the
    archive's layout matches what the Creator listed, not the disk's."""
    staged = _staged_items(items, opts)
    progress(0, len(staged))
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="onetool-create-7z-") as tmp:
        room = Path(tmp)
        for index, (name, path) in enumerate(staged, start=1):
            target = room / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
            progress(index, len(staged), "staging")
        if creator_flag(opts, "meta"):
            (room / "ComicInfo.xml").write_bytes(
                comic_info(opts.get("title") or out.stem, len(staged), opts.get("creator") or "")
            )
        with _atomic_output(out) as partial:
            # 7-Zip expands the wildcard itself and stores names relative to it,
            # so the archive's layout is the staged layout.
            command = [
                which("7z", "7za", "7zz"), "a", "-t7z", str(partial), str(room / "*"), "-y",
                f"-mx{SEVEN_ZIP_LEVELS[creator_level(opts)]}",
            ]
            if opts.get("password"):
                # -mhe hides the file names too, which is what "encrypted" implies.
                command += [f"-p{opts['password']}", "-mhe=on"]
            run(command, "7-Zip")
            if not partial.is_file() or partial.stat().st_size == 0:
                raise ValueError("7-Zip produced no archive")
    progress(len(staged), len(staged), "writing")
    return len(staged)


def items_to_epub_convert(items: list[Path], out: Path, opts: dict, progress) -> int:
    pages = _item_images(items, opts)
    return cbz_to_epub.convert_paths(
        pages,
        out,
        opts.get("title") or out.stem,
        opts.get("creator") or "Unknown",
        progress=progress,
    )


def items_to_pdf_convert(items: list[Path], out: Path, opts: dict, progress) -> int:
    return images_to_pdf_convert(_item_images(items, opts), out, opts, progress)


def items_to_tiff_convert(items: list[Path], out: Path, opts: dict, progress) -> int:
    pages = _item_images(items, opts)
    progress(0, len(pages), "writing")
    out.parent.mkdir(parents=True, exist_ok=True)
    compression = TIFF_COMPRESSION[creator_level(opts)]
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

# Creator option sets. Every key here is read by a builder — nothing is declared
# that the container would then ignore.
CREATE_COMPRESS = Option("compress", "Compression", "Normal")
CREATE_FLATTEN = Option("flatten", "Flatten folders", "off")
CREATE_RENUMBER = Option("rename", "Renumber pages", "on")
CREATE_COMICINFO = Option("meta", "Write ComicInfo.xml", "on")
CREATE_PASSWORD = Option("password", "Password", "none")
CREATE_ARCHIVE_OPTS = (CREATE_COMPRESS, CREATE_FLATTEN)
CREATE_COMIC_OPTS = (CREATE_COMPRESS, CREATE_RENUMBER, CREATE_COMICINFO)
CREATE_BOOK_OPTS = TITLE_OPTS + (CREATE_RENUMBER,)
CREATE_PAGE_OPTS = (CREATE_COMPRESS, CREATE_RENUMBER) + PDF_IMAGE_OPTS
CREATE_TIFF_OPTS = (CREATE_COMPRESS, CREATE_RENUMBER)

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
        id="items-zip", src="Items", dst="ZIP", category="Archives", kind="doc", glyph="ZI", ext=".zip",
        title="Items → ZIP", sub="one archive from everything on the list",
        blurb="Pack the chosen files and folders into a ZIP archive.",
        options=CREATE_ARCHIVE_OPTS,
        dependencies=("Python standard library",), multi=True, convert=items_to_zip_convert,
    ),
    Converter(
        id="items-cbz", src="Items", dst="CBZ", category="Comics", kind="comic", glyph="CB", ext=".cbz",
        title="Items → CBZ", sub="a comic archive in reading order",
        blurb="Pack images into a CBZ comic archive.",
        options=CREATE_COMIC_OPTS,
        dependencies=("Python standard library",), multi=True, convert=items_to_zip_convert,
    ),
    Converter(
        id="items-tgz", src="Items", dst="TGZ", category="Archives", kind="doc", glyph="TG", ext=".tar.gz",
        title="Items → TAR.GZ", sub="gzip-compressed tar",
        blurb="Pack the chosen files and folders into a gzipped tar archive.",
        options=CREATE_ARCHIVE_OPTS,
        dependencies=("Python standard library",), multi=True, convert=items_to_tgz_convert,
    ),
    Converter(
        id="items-7z", src="Items", dst="7Z", category="Archives", kind="doc", glyph="7Z", ext=".7z",
        title="Items → 7Z", sub="7-Zip's own format",
        blurb="Pack the chosen files and folders into a 7z archive.",
        options=CREATE_ARCHIVE_OPTS + (CREATE_PASSWORD,),
        helper=SEVEN_ZIP, dependencies=("7-Zip",), multi=True, convert=items_to_7z_convert,
    ),
    Converter(
        id="items-cb7", src="Items", dst="CB7", category="Comics", kind="comic", glyph="CB", ext=".cb7",
        title="Items → CB7", sub="a 7z-packed comic archive",
        blurb="Pack images into a CB7 comic archive.",
        options=CREATE_COMIC_OPTS + (CREATE_PASSWORD,),
        helper=SEVEN_ZIP, dependencies=("7-Zip",), multi=True, convert=items_to_7z_convert,
    ),
    Converter(
        id="items-epub", src="Items", dst="EPUB", category="Comics", kind="comic", glyph="EP", ext=".epub",
        title="Items → EPUB", sub="fixed-layout, one page per image",
        blurb="Build a fixed-layout EPUB from images.",
        options=CREATE_BOOK_OPTS,
        multi=True, convert=items_to_epub_convert,
    ),
    Converter(
        id="items-pdf", src="Items", dst="PDF", category="Documents", kind="doc", glyph="PD", ext=".pdf",
        title="Items → PDF", sub="JPEG and PNG pages embedded without re-encoding",
        blurb="Build a PDF from images.",
        options=CREATE_PAGE_OPTS,
        multi=True, convert=items_to_pdf_convert,
    ),
    Converter(
        id="items-tiff", src="Items", dst="TIFF", category="Documents", kind="image", glyph="TI", ext=".tiff",
        title="Items → multi-page TIFF", sub="one frame per image",
        blurb="Build a single multi-page TIFF from images.",
        options=CREATE_TIFF_OPTS,
        helper=IMAGEMAGICK, dependencies=("ImageMagick",), multi=True, convert=items_to_tiff_convert,
    ),
]

REGISTRY = Registry(CONVERTERS)
