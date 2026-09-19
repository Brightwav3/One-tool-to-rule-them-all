from __future__ import annotations

from formats_common import *
from formats_pdf_convert import _pdf_page_count, images_to_pdf_convert

def creator_flag(opts: dict, key: str, default: bool = False) -> bool:
    """Read a Creator toggle. The UI sends JSON booleans as strings."""
    raw = opts.get(key)
    if raw is None or raw == "":
        return default
    return str(raw).strip().casefold() in {"1", "true", "on", "yes"}

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

__all__ = ['creator_flag', 'COMPRESSION_LEVELS', 'SEVEN_ZIP_LEVELS', 'TIFF_COMPRESSION', 'creator_level', '_staged_items', '_item_images', 'comic_info', 'ARCHIVE_SUFFIXES', 'probe_item', 'items_to_zip_convert', 'items_to_tgz_convert', 'items_to_7z_convert', 'items_to_epub_convert', 'items_to_pdf_convert', 'items_to_tiff_convert']
