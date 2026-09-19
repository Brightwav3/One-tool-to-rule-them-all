from __future__ import annotations

from formats_common import *
from formats_pdf_writer import *
from formats_pdf_convert import *
from formats_documents import calibre_convert

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


def cbz_pdf_probe(source: Path) -> int:
    """Check whether a CBZ needs ImageMagick before queuing PDF output."""
    with zipfile.ZipFile(source, "r") as archive:
        images = cbz_to_epub.list_images(archive)
    if any(Path(image.name).suffix.casefold() not in DIRECT_PDF_SUFFIXES for image in images):
        if not find_magick():
            raise MissingHelperError(
                IMAGEMAGICK,
                "GIF, WebP, and AVIF pages need ImageMagick to convert this CBZ to PDF.",
            )
    return len(images)


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
            return _direct_pdf_from_archive(archive, names, out, opts, progress, geometry="dpi")

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
        return _direct_pdf_from_paths(pages, out, opts, progress, geometry="dpi")

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

__all__ = ['cbz_to_epub_convert', 'cbz_probe', 'cbz_pdf_probe', 'cbz_to_pdf_convert', 'cbr_to_epub_convert', 'cbr_to_pdf_convert', 'epub_to_cbz_convert', '_epub_local_name', '_epub_member_path', '_read_epub_member', '_epub_image_pdf_sources', 'epub_to_pdf_convert', 'epub_to_txt_convert']
