#!/usr/bin/env python3
"""Shared helpers and imports for the focused conversion modules."""

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
    MissingHelperError,
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


@dataclass(frozen=True)
class PdfPageSource:
    """A lazily-read page used by the direct PDF writer."""

    name: str
    suffix: str
    read: Callable[[], bytes]


PageSource = PdfPageSource


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

__all__ = [name for name in globals() if not name.startswith("__")]
