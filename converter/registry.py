#!/usr/bin/env python3
"""The converter registry.

Every conversion the app can perform declares itself here. The UI is rendered
entirely from this list, so adding a format means adding a `Converter` — no
changes to the queue, the progress plumbing or the interface.

A converter's state is *computed*, never asserted:

    ready   the code exists and every helper it needs was found
    helper  the code exists but an external tool is missing
    soon    not implemented yet

That means the interface can never promise a conversion that would fail.
"""

from __future__ import annotations

import glob
import os
import re
import shutil
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

# progress(done, total); total of 0 means "no known unit count, just working"
Progress = Callable[[int, int], None]
ConvertFn = Callable[[Path, Path, dict, Progress], int]
# A `multi` converter takes every source at once instead of one at a time.
MultiConvertFn = Callable[[list[Path], Path, dict, Progress], int]
ProbeFn = Callable[[Path], int]

# Registry state is requested often. Cache helper hits and misses until the
# user explicitly asks the app to check again after an installation.
_HELPER_CACHE: dict[tuple[str, str], str | None] = {}

_COMMAND_SHIM_SUFFIXES = {".bat", ".cmd"}
_COMMAND_SHIM_TARGET = re.compile(
    r'"(?P<quoted>[^"\r\n]+\.(?:bat|cmd|exe))"|(?P<bare>[^\s"\r\n]+\.(?:bat|cmd|exe))',
    re.IGNORECASE,
)


def _resolve_command_shim(path: Path, seen: set[Path] | None = None) -> str | None:
    """Follow simple Windows command shims until their real executable is found."""
    if path.suffix.casefold() not in _COMMAND_SHIM_SUFFIXES:
        return None
    seen = seen or set()
    path = path.resolve()
    if path in seen:
        return None
    seen.add(path)
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    substitutions = {
        "%~dp0": str(path.parent) + os.sep,
        "%SCRIPT_DIR%": str(path.parent) + os.sep,
    }
    for match in _COMMAND_SHIM_TARGET.finditer(text):
        raw = match.group("quoted") or match.group("bare")
        for source, replacement in substitutions.items():
            raw = raw.replace(source, replacement)
        candidate = Path(os.path.expandvars(raw))
        if not candidate.is_absolute():
            candidate = path.parent / candidate
        candidate = candidate.resolve()
        if not candidate.is_file():
            continue
        if candidate.suffix.casefold() in _COMMAND_SHIM_SUFFIXES:
            resolved = _resolve_command_shim(candidate, seen)
            if resolved:
                return resolved
        elif candidate.suffix.casefold() == ".exe":
            return str(candidate)
    return None

@dataclass(frozen=True)
class Option:
    """One per-file field rendered on the queue card."""
    key: str
    label: str
    placeholder: str = ""


@dataclass(frozen=True)
class Helper:
    """An external program a converter shells out to."""
    name: str
    why: str
    binaries: tuple[str, ...]
    url: str
    commands: dict[str, str]  # platform -> install command
    download: str = ""
    paths: tuple[str, ...] = ()
    globs: tuple[str, ...] = ()
    required: tuple[str, ...] = ()

    def locate_binary(self, binary: str) -> str | None:
        cache_key = (self.name, binary.casefold())
        if cache_key in _HELPER_CACHE:
            return _HELPER_CACHE[cache_key]

        def remember(path: str | None) -> str | None:
            _HELPER_CACHE[cache_key] = path
            return path

        names = {binary.casefold(), binary.casefold().removesuffix(".exe")}
        found = shutil.which(binary)
        if found:
            return remember(_resolve_command_shim(Path(found)) or found)
        for raw_path in self.paths:
            if not raw_path:
                continue
            candidate = Path(os.path.expandvars(raw_path)).expanduser()
            if candidate.is_dir():
                candidate = candidate / Path(binary).name
            if candidate.is_file() and (candidate.name.casefold() in names or candidate.stem.casefold() in names):
                return remember(_resolve_command_shim(candidate) or str(candidate))
        for raw_pattern in self.globs:
            pattern = os.path.expandvars(raw_pattern)
            for match in glob.glob(pattern, recursive=True):
                candidate = Path(match)
                if candidate.is_file() and (candidate.name.casefold() in names or candidate.stem.casefold() in names):
                    return remember(_resolve_command_shim(candidate) or str(candidate))
        return remember(None)

    def locate(self) -> str | None:
        if self.required:
            found = [self.locate_binary(binary) for binary in self.required]
            return found[0] if found and all(found) else None
        for binary in self.binaries:
            found = self.locate_binary(binary)
            if found:
                return found
        return None

    @property
    def command(self) -> str:
        key = {"win32": "win32", "darwin": "darwin"}.get(sys.platform, "linux")
        return self.commands.get(key, self.commands.get("linux", ""))

    def as_dict(self) -> dict:
        found_path = self.locate() or ""
        return {
            "name": self.name,
            "why": self.why,
            "cmd": self.command,
            "url": self.url,
            "download": self.download,
            "found": bool(found_path),
            "foundPath": found_path,
            "alternatives": [],
        }


@dataclass(frozen=True)
class Converter:
    id: str
    src: str
    dst: str
    category: str
    kind: str            # comic | image | doc — decides the card's thumbnail
    glyph: str
    ext: str
    blurb: str
    title: str = ""
    sub: str = ""
    drop_title: str = ""
    drop_sub: str = ""
    options: tuple[Option, ...] = ()
    helper: Helper | None = None
    dependencies: tuple[str, ...] = ()
    helper_alternatives: tuple[Helper, ...] = ()
    requirements: tuple[Helper, ...] = ()
    convert: ConvertFn | MultiConvertFn | None = None
    probe: ProbeFn | None = None
    extensions: tuple[str, ...] = ()   # inputs this converter claims when routing
    # Many sources into one output — the Creator's containers. A multi converter
    # is handed the whole source list, and claims no extensions, so a dropped
    # file can never route to it.
    multi: bool = False

    @property
    def label(self) -> str:
        return f"{self.src} → {self.dst}"

    def state(self) -> str:
        if self.convert is None:
            return "soon"
        if self.requirements and any(not helper.locate() for helper in self.requirements):
            return "helper"
        if self.helper:
            candidates = (self.helper, *self.helper_alternatives)
            if not any(helper.locate() for helper in candidates):
                return "helper"
        return "ready"

    def as_dict(self) -> dict:
        state = self.state()
        return {
            "id": self.id,
            "from": self.src,
            "to": self.dst,
            "label": self.label,
            "cat": self.category,
            "kind": self.kind,
            "glyph": self.glyph,
            "ext": self.ext,
            "state": state,
            "blurb": self.blurb,
            "title": self.title or self.label,
            "sub": self.sub,
            "dropTitle": self.drop_title or f"Drop {self.src.lower()} files here",
            "dropSub": self.drop_sub,
            "options": [{"key": o.key, "label": o.label, "placeholder": o.placeholder} for o in self.options],
            "multi": self.multi,
            "dependencies": list(self.dependencies),
            "helper": None if not self.helper else {
                **self.helper.as_dict(),
                "alternatives": [
                    {"name": helper.name, "found": bool(helper.locate()), "foundPath": helper.locate() or ""}
                    for helper in self.helper_alternatives
                ],
            },
            "requirements": [helper.as_dict() for helper in self.requirements],
        }


class Registry:
    """The set of converters, plus extension-based routing for mixed drops."""

    def __init__(self, converters: list[Converter]):
        self._converters = converters
        self._by_id = {c.id: c for c in converters}

    def __iter__(self):
        return iter(self._converters)

    def get(self, converter_id: str) -> Converter | None:
        return self._by_id.get(converter_id)

    def as_list(self) -> list[dict]:
        return [c.as_dict() for c in self._converters]

    def counts(self) -> dict[str, int]:
        tally = {"ready": 0, "helper": 0, "soon": 0}
        for converter in self._converters:
            tally[converter.state()] += 1
        return tally

    def route(self, path: Path) -> Converter | None:
        """Pick the converter for a dropped file. Ready beats helper beats soon."""
        suffix = path.suffix.casefold()
        candidates = [c for c in self._converters if suffix in c.extensions]
        if not candidates:
            return None
        rank = {"ready": 0, "helper": 1, "soon": 2}
        candidates.sort(key=lambda c: rank[c.state()])
        return candidates[0]

    def recheck(self) -> None:
        """Helper lookups go through shutil.which, which caches nothing —
        so a re-check is simply asking again. Present for intent and symmetry."""
        _HELPER_CACHE.clear()


# Helpers shared by several converters. -------------------------------------


def _windows_program_paths(*parts: str) -> tuple[str, ...]:
    if sys.platform != "win32":
        return ()
    roots = (
        os.environ.get("ProgramW6432"),
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
        os.environ.get("LOCALAPPDATA"),
    )
    paths = [str(Path(root, *parts)) for root in roots if root]
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        paths.append(str(Path(local_app_data, "Programs", *parts)))
    return tuple(paths)


def _windows_program_globs(*parts: str) -> tuple[str, ...]:
    if sys.platform != "win32":
        return ()
    roots = (
        os.environ.get("ProgramW6432"),
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
        os.environ.get("LOCALAPPDATA"),
        os.environ.get("ProgramData"),
    )
    return tuple(str(Path(root, *parts)) for root in roots if root)


def _windows_winget_globs(package: str, *parts: str) -> tuple[str, ...]:
    roots = (
        os.environ.get("LOCALAPPDATA"),
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramData"),
    )
    return tuple(
        str(Path(root, "Microsoft", "WinGet", "Packages", package, "**", *parts))
        for root in roots if root
    )


SEVEN_ZIP = Helper(
    name="7-Zip",
    why="RAR is a proprietary format with no unpacker built into Python, so the "
        "converter shells out to 7-Zip to read the contents.",
    binaries=("7z", "7za", "7zz", "7z.exe"),
    url="https://www.7-zip.org/download.html",
    download="https://github.com/ip7z/7zip/releases/download/26.02/7z2602-x64.exe",
    paths=_windows_program_paths("7-Zip", "7z.exe") + ((os.environ.get("ONETOOL_7Z") or ""),),
    commands={
        "win32": "winget install --id 7zip.7zip --exact",
        "darwin": "brew install sevenzip",
        "linux": "sudo apt install p7zip-full",
    },
)

POPPLER = Helper(
    name="Poppler",
    why="PDF pages have to be rendered before they can be packed as images. "
        "Poppler's pdftoppm and pdftotext do that work.",
    binaries=("pdftoppm", "pdftotext", "pdfimages", "pdftoppm.exe", "pdftotext.exe", "pdfimages.exe"),
    url="https://poppler.freedesktop.org/",
    download="https://github.com/oschwartz10612/poppler-windows/releases/download/v26.02.0-0/Release-26.02.0-0.zip",
    paths=(
        *_windows_program_paths("poppler", "Library", "bin", "pdftoppm.exe"),
        *_windows_program_paths("poppler", "Library", "bin", "pdftotext.exe"),
        *_windows_program_paths("poppler", "Library", "bin", "pdfimages.exe"),
        *(os.environ.get("ONETOOL_POPPLER") or "",),
    ),
    globs=(
        *_windows_program_globs("poppler*", "Library", "bin", "pdftoppm.exe"),
        *_windows_program_globs("poppler*", "Library", "bin", "pdftotext.exe"),
        *_windows_program_globs("poppler*", "Library", "bin", "pdfimages.exe"),
        *_windows_winget_globs("oschwartz10612.Poppler_*", "Library", "bin", "pdftoppm.exe"),
        *_windows_winget_globs("oschwartz10612.Poppler_*", "Library", "bin", "pdftotext.exe"),
        *_windows_winget_globs("oschwartz10612.Poppler_*", "Library", "bin", "pdfimages.exe"),
    ),
    required=("pdftoppm", "pdftotext"),
    commands={
        "win32": "winget install --id oschwartz10612.Poppler --exact",
        "darwin": "brew install poppler",
        "linux": "sudo apt install poppler-utils",
    },
)

POPPLER_RENDER = Helper(
    name="Poppler (pdftoppm)",
    why="PDF pages have to be rendered before they can be packed as images.",
    binaries=("pdftoppm", "pdftoppm.exe", "pdfinfo", "pdfinfo.exe", "pdfimages", "pdfimages.exe"),
    url=POPPLER.url,
    download=POPPLER.download,
    paths=POPPLER.paths,
    globs=POPPLER.globs,
    commands=POPPLER.commands,
    required=("pdftoppm", "pdfinfo"),
)

POPPLER_TEXT = Helper(
    name="Poppler (pdftotext)",
    why="The PDF text layer is extracted with Poppler's pdftotext command.",
    binaries=("pdftotext", "pdftotext.exe"),
    url=POPPLER.url,
    download=POPPLER.download,
    paths=POPPLER.paths,
    globs=POPPLER.globs,
    commands=POPPLER.commands,
)

FFMPEG = Helper(
    name="ffmpeg",
    why="Every video and photo re-encode is an ffmpeg pipeline. Without it there "
        "is no decoder or encoder to work with.",
    binaries=("ffmpeg", "ffmpeg.exe"),
    url="https://ffmpeg.org/download.html",
    download="https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    paths=(_windows_program_paths("ffmpeg", "bin", "ffmpeg.exe") + ((os.environ.get("ONETOOL_FFMPEG") or ""),)),
    globs=(
        *_windows_program_globs("ffmpeg*", "bin", "ffmpeg.exe"),
        *_windows_winget_globs("Gyan.FFmpeg_*", "bin", "ffmpeg.exe"),
    ),
    commands={
        "win32": "winget install --id Gyan.FFmpeg --exact",
        "darwin": "brew install ffmpeg",
        "linux": "sudo apt install ffmpeg",
    },
)

IMAGEMAGICK = Helper(
    name="ImageMagick",
    why="Vector rendering needs a rasteriser. ImageMagick's convert handles SVG "
        "at any scale.",
    # Never probe bare "convert" on Windows — that name belongs to the built-in
    # NTFS conversion utility, and matching it would claim ImageMagick is here.
    binaries=("magick", "magick.exe") if sys.platform == "win32" else ("magick", "convert"),
    url="https://imagemagick.org/script/download.php",
    download="https://download.imagemagick.org/archive/binaries/ImageMagick-7.1.2-28-portable-Q16-HDRI-x64.7z",
    paths=((os.environ.get("ONETOOL_IMAGEMAGICK") or ""),),
    globs=(
        *_windows_program_globs("ImageMagick*", "magick.exe"),
        *_windows_winget_globs("ImageMagick.ImageMagick_*", "magick.exe"),
    ),
    commands={
        "win32": "winget install --id ImageMagick.ImageMagick --exact",
        "darwin": "brew install imagemagick",
        "linux": "sudo apt install imagemagick",
    },
)

LIBREOFFICE = Helper(
    name="LibreOffice",
    why="Word layout is reproduced by LibreOffice's own renderer — nothing else "
        "gets the pagination right.",
    binaries=("soffice", "soffice.exe", "libreoffice"),
    url="https://www.libreoffice.org/download/",
    download="https://download.documentfoundation.org/libreoffice/stable/26.2.4/win/x86_64/LibreOffice_26.2.4_Win_x86-64.msi",
    paths=(
        *_windows_program_paths("LibreOffice", "program", "soffice.exe"),
        *(os.environ.get("ONETOOL_LIBREOFFICE") or "",),
    ),
    globs=(
        *_windows_program_globs("LibreOffice*", "program", "soffice.exe"),
        *_windows_winget_globs("TheDocumentFoundation.LibreOffice_*", "LibreOffice", "program", "soffice.exe"),
    ),
    commands={
        "win32": "winget install --id TheDocumentFoundation.LibreOffice --exact",
        "darwin": "brew install --cask libreoffice",
        "linux": "sudo apt install libreoffice",
    },
)

CALIBRE = Helper(
    name="Calibre",
    why="Calibre's ebook-convert handles Kindle ebook formats.",
    binaries=("ebook-convert", "ebook-convert.exe"),
    url="https://calibre-ebook.com/download",
    # This stable endpoint redirects to Calibre's current 64-bit Windows installer.
    download="https://calibre-ebook.com/dist/win64",
    paths=(
        *_windows_program_paths("Calibre2", "ebook-convert.exe"),
        *(os.environ.get("ONETOOL_CALIBRE") or "",),
    ),
    globs=_windows_program_globs("Calibre*", "ebook-convert.exe"),
    commands={
        "win32": "winget install --id calibre.calibre --exact",
        "darwin": "brew install --cask calibre",
        "linux": "sudo apt install calibre",
    },
)

RAW_TOOLS = Helper(
    name="LibRaw or Exiv2",
    why="RAW support needs a command-line RAW reader/converter.",
    binaries=("dcraw_emu", "dcraw_emu.exe", "exiv2", "exiv2.exe"),
    url="https://www.libraw.org/download",
    paths=((os.environ.get("ONETOOL_RAW_TOOL") or ""),),
    globs=(
        *_windows_program_globs("LibRaw*", "bin", "dcraw_emu.exe"),
        *_windows_program_globs("Exiv2*", "bin", "exiv2.exe"),
    ),
    commands={
        "win32": "winget install --id Exiv2.Exiv2 --exact",
        "darwin": "brew install libraw exiv2",
        "linux": "sudo apt install libraw-bin exiv2",
    },
)

PANDOC = Helper(
    name="Pandoc",
    why="Pandoc turns Markdown into a document model before PDF rendering.",
    binaries=("pandoc", "pandoc.exe"),
    url="https://pandoc.org/installing.html",
    paths=(
        *_windows_program_paths("Pandoc", "pandoc.exe"),
        *(os.environ.get("ONETOOL_PANDOC") or "",),
    ),
    globs=_windows_program_globs("Pandoc*", "pandoc.exe"),
    commands={
        "win32": "winget install --id JohnMacFarlane.Pandoc --exact",
        "darwin": "brew install pandoc",
        "linux": "sudo apt install pandoc",
    },
)

PDF_RENDERER = Helper(
    name="PDF renderer",
    why="Pandoc needs a local PDF engine such as LaTeX, wkhtmltopdf or WeasyPrint.",
    binaries=("pdflatex", "xelatex", "lualatex", "wkhtmltopdf", "weasyprint"),
    url="https://pandoc.org/installing.html",
    paths=(
        *_windows_program_paths("MiKTeX", "miktex", "bin", "x64", "pdflatex.exe"),
        *_windows_program_paths("MiKTeX", "miktex", "bin", "x64", "xelatex.exe"),
        *_windows_program_paths("wkhtmltopdf", "bin", "wkhtmltopdf.exe"),
        *(os.environ.get("ONETOOL_PDF_RENDERER") or "",),
    ),
    globs=(
        *_windows_program_globs("MiKTeX*", "**", "pdflatex.exe"),
        *_windows_program_globs("MiKTeX*", "**", "xelatex.exe"),
        *_windows_program_globs("wkhtmltopdf*", "bin", "wkhtmltopdf.exe"),
    ),
    commands={
        "win32": "winget install --id MiKTeX.MiKTeX --exact",
        "darwin": "brew install --cask mactex",
        "linux": "sudo apt install texlive-latex-base",
    },
)
