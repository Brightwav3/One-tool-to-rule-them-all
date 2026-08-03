#!/usr/bin/env python3
"""Convert a CBZ comic archive into an EPUB 3 comic book."""

from __future__ import annotations

import argparse
import html
import os
import posixpath
import re
import shutil
import sys
import zipfile
from collections.abc import Callable
from contextlib import contextmanager
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path


SUPPORTED_IMAGES = {
    ".jpg": ("image/jpeg", "jpeg"),
    ".jpeg": ("image/jpeg", "jpeg"),
    ".png": ("image/png", "png"),
    ".gif": ("image/gif", "gif"),
    ".webp": ("image/webp", "webp"),
    ".avif": ("image/avif", "avif"),
}


@dataclass(frozen=True)
class ComicImage:
    name: str
    media_type: str
    extension: str
    sort_name: str


def is_junk_entry(name: str) -> bool:
    """Return whether an archive member is common filesystem metadata junk."""
    parts = [part for part in name.replace("\\", "/").split("/") if part not in ("", ".")]
    if not parts:
        return True
    if any(part.casefold() == "__macosx" for part in parts):
        return True
    basename = parts[-1]
    return basename.startswith(".") or basename.casefold() in {"thumbs.db", "zwater.jpg"}


def natural_key(value: str) -> list[object]:
    """Sort names like page2.jpg before page10.jpg."""
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", value)]


def safe_archive_name(name: str) -> str:
    """Return a safe, portable name and reject ZIP path traversal."""
    normalized = posixpath.normpath(name.replace("\\", "/"))
    if normalized in ("", ".") or normalized.startswith("../") or normalized == ".." or normalized.startswith("/"):
        raise ValueError(f"unsafe archive path: {name!r}")
    return normalized


def list_images(archive: zipfile.ZipFile) -> list[ComicImage]:
    """List the comic pages in an open archive, in natural filename order."""
    images: list[ComicImage] = []
    for entry in archive.infolist():
        if entry.is_dir():
            continue
        name = safe_archive_name(entry.filename)
        if is_junk_entry(name):
            continue
        suffix = Path(name).suffix.casefold()
        if suffix not in SUPPORTED_IMAGES:
            continue
        media_type, extension = SUPPORTED_IMAGES[suffix]
        # Keep the archive's own name for reading; sort on the normalized one.
        images.append(ComicImage(entry.filename, media_type, extension, name))

    images.sort(key=lambda image: natural_key(image.sort_name))
    if not images:
        raise ValueError("the CBZ contains no supported image files (jpg, png, gif, webp, or avif)")
    return images


def read_images(cbz_path: Path) -> list[ComicImage]:
    with zipfile.ZipFile(cbz_path, "r") as archive:
        return list_images(archive)


@contextmanager
def _atomic_output(output: Path):
    partial = Path(f"{output}.partial")
    partial.unlink(missing_ok=True)
    try:
        yield partial
        os.replace(partial, output)
    except Exception:
        partial.unlink(missing_ok=True)
        raise


def xml_escape(value: str) -> str:
    return html.escape(value, quote=True)


def make_container() -> bytes:
    return b'''<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
'''


def make_nav(title: str, images: list[ComicImage]) -> bytes:
    items = "\n".join(
        f'        <li><a href="page-{index:04d}.xhtml">Page {index}</a></li>'
        for index, _ in enumerate(images, start=1)
    )
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
  <head><title>{xml_escape(title)}</title></head>
  <body>
    <nav epub:type="toc" id="toc"><h1>{xml_escape(title)}</h1><ol>
{items}
    </ol></nav>
  </body>
</html>
'''.encode("utf-8")


def make_page(title: str, image_href: str, page_number: int) -> bytes:
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
  <head>
    <title>{xml_escape(title)} — Page {page_number}</title>
    <meta name="viewport" content="width=device-width, height=device-height"/>
    <style>html, body {{ margin: 0; padding: 0; text-align: center; background: #000; }} img {{ display: block; width: 100%; height: auto; max-height: 100vh; object-fit: contain; }}</style>
  </head>
  <body><img src="{xml_escape(image_href)}" alt="Page {page_number}"/></body>
</html>
'''.encode("utf-8")


def make_opf(title: str, creator: str, images: list[ComicImage], identifier: str) -> bytes:
    manifest = [
        '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ]
    spine = []
    for index, image in enumerate(images, start=1):
        image_id = f"image-{index:04d}"
        page_id = f"page-{index:04d}"
        manifest.append(
            f'    <item id="{image_id}" href="images/{index:04d}.{image.extension}" media-type="{image.media_type}"'
            + (' properties="cover-image"' if index == 1 else '')
            + '/>'
        )
        manifest.append(f'    <item id="{page_id}" href="page-{index:04d}.xhtml" media-type="application/xhtml+xml"/>')
        spine.append(f'    <itemref idref="{page_id}"/>')

    modified = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">{xml_escape(identifier)}</dc:identifier>
    <dc:title>{xml_escape(title)}</dc:title>
    <dc:language>en</dc:language>
    <dc:creator>{xml_escape(creator)}</dc:creator>
    <meta property="dcterms:modified">{modified}</meta>
  </metadata>
  <manifest>
{chr(10).join(manifest)}
  </manifest>
  <spine page-progression-direction="ltr">
{chr(10).join(spine)}
  </spine>
</package>
'''.encode("utf-8")


def _write_epub(
    epub_path: Path,
    images: list[ComicImage],
    book_title: str,
    creator: str,
    identifier: str,
    open_page: Callable[[ComicImage], object],
    progress: "Callable[[int, int], None] | None" = None,
) -> int:
    epub_path.parent.mkdir(parents=True, exist_ok=True)
    with _atomic_output(epub_path) as partial:
        with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED) as epub:
            # EPUB readers require this entry to be first and uncompressed.
            epub.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
            epub.writestr("META-INF/container.xml", make_container())
            epub.writestr("EPUB/package.opf", make_opf(book_title, creator, images, identifier))
            epub.writestr("EPUB/nav.xhtml", make_nav(book_title, images))
            for index, image in enumerate(images, start=1):
                href = f"images/{index:04d}.{image.extension}"
                media_info = zipfile.ZipInfo(f"EPUB/{href}")
                media_info.compress_type = zipfile.ZIP_STORED
                with open_page(image) as source, epub.open(media_info, "w") as target:
                    shutil.copyfileobj(source, target, 1024 * 1024)
                epub.writestr(f"EPUB/page-{index:04d}.xhtml", make_page(book_title, href, index))
                if progress:
                    progress(index, len(images))
    return len(images)


def convert(
    cbz_path: Path,
    epub_path: Path,
    title: str | None = None,
    creator: str = "Unknown",
    progress: "Callable[[int, int], None] | None" = None,
) -> int:
    """Write an EPUB 3 from a CBZ. `progress(done, total)` is called per page."""
    with zipfile.ZipFile(cbz_path, "r") as archive:
        images = list_images(archive)
        book_title = title or cbz_path.stem
        identifier = f"urn:uuid:{cbz_path.stem}-{len(images)}"
        return _write_epub(
            epub_path,
            images,
            book_title,
            creator,
            identifier,
            lambda image: archive.open(image.name),
            progress,
        )


def convert_paths(
    page_paths: list[Path],
    epub_path: Path,
    title: str | None = None,
    creator: str = "Unknown",
    progress: "Callable[[int, int], None] | None" = None,
) -> int:
    """Write an EPUB directly from extracted page files without an intermediate CBZ."""
    paths = sorted(page_paths, key=lambda path: natural_key(str(path)))
    images: list[ComicImage] = []
    for path in paths:
        suffix = path.suffix.casefold()
        if suffix not in SUPPORTED_IMAGES:
            continue
        media_type, extension = SUPPORTED_IMAGES[suffix]
        images.append(ComicImage(str(path), media_type, extension, path.name))
    if not images:
        raise ValueError("the extracted archive contains no supported image files")
    book_title = title or epub_path.stem
    identifier = f"urn:uuid:{book_title}-{len(images)}"
    return _write_epub(
        epub_path,
        images,
        book_title,
        creator,
        identifier,
        lambda image: Path(image.name).open("rb"),
        progress,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Convert a CBZ comic archive to an EPUB 3 comic book.")
    parser.add_argument("input", type=Path, help="input .cbz file")
    parser.add_argument("output", type=Path, nargs="?", help="output .epub file (defaults to input name)")
    parser.add_argument("--title", help="book title (defaults to the CBZ filename)")
    parser.add_argument("--creator", default="Unknown", help="creator/author metadata (default: Unknown)")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.input.suffix.casefold() != ".cbz":
        print("warning: input does not have a .cbz extension; treating it as a ZIP archive", file=sys.stderr)
    output = args.output or args.input.with_suffix(".epub")
    try:
        count = convert(args.input, output, args.title, args.creator)
    except (OSError, zipfile.BadZipFile, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"Created {output} with {count} page(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
