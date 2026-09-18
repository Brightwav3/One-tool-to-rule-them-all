#!/usr/bin/env python3
"""PDF raster convert bodies (Poppler, pdfimages, bounded workers)."""

from __future__ import annotations

import ctypes
import os
import re
import shutil
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from convert_io import (
    JPEG_SUFFIXES,
    _atomic_output,
    guarded,
    images_in,
    run,
    which,
    zip_files,
)
from direct_pdf import _try_direct_pdf_to_cbz as _try_direct_pdf_to_cbz_impl

_try_direct_pdf_to_cbz = guarded(_try_direct_pdf_to_cbz_impl)

PDF_MAX_WORKERS = 4
PDF_MEMORY_PER_WORKER = 256 * 1024 * 1024



@guarded
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


@guarded
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


@guarded
def _pdf_worker_count(page_count: int) -> int:
    cpu_count = max(1, min(PDF_MAX_WORKERS, os.cpu_count() or 1))
    available = _available_memory_bytes()
    if available is not None:
        memory_count = max(1, available // PDF_MEMORY_PER_WORKER)
        cpu_count = min(cpu_count, memory_count)
    return max(1, min(page_count, cpu_count))


@guarded
def _pdf_page_ranges(page_count: int, worker_count: int) -> list[tuple[int, int]]:
    if page_count < 1:
        return []
    worker_count = max(1, min(page_count, worker_count))
    chunk_size = (page_count + worker_count - 1) // worker_count
    return [
        (first, min(first + chunk_size - 1, page_count))
        for first in range(1, page_count + 1, chunk_size)
    ]


@guarded
def _pdf_page_count(source: Path) -> int:
    result = run([which("pdfinfo"), str(source)], "Poppler")
    match = re.search(r"^Pages:\s*(\d+)\s*$", result.stdout or "", re.MULTILINE)
    if not match:
        raise ValueError("Poppler did not report a PDF page count")
    return int(match.group(1))


@guarded
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


@guarded
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


@guarded
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

