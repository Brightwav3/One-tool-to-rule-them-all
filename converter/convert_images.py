#!/usr/bin/env python3
"""Raster, vector, video, and image-to-PDF convert bodies."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from convert_io import (
    DIRECT_PDF_SUFFIXES,
    JPEG_SUFFIXES,
    MULTI_FRAME_SUFFIXES,
    _atomic_output,
    find_magick,
    guarded,
    magick_command,
    run,
    run_magick_pdf,
    shorten_page_arguments,
    which,
)
from direct_pdf import _direct_pdf_from_paths as _direct_pdf_from_paths_impl

_direct_pdf_from_paths = guarded(_direct_pdf_from_paths_impl)



@guarded
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


@guarded
def image_to_pdf_convert(source: Path, out: Path, opts: dict, progress) -> int:
    if source.suffix.casefold() in DIRECT_PDF_SUFFIXES:
        return _direct_pdf_from_paths([source], out, opts, progress, geometry="dpi")
    return images_to_pdf_convert([source], out, opts, progress)


@guarded
def raster_image_to_pdf_convert(source: Path, out: Path, opts: dict, progress) -> int:
    """Rasterise a non-PNG/JPEG image, then use the safe direct PDF writer."""
    with tempfile.TemporaryDirectory(prefix="onetool-image-pdf-") as tmp:
        jpeg = Path(tmp) / "page.jpg"
        raster_image_convert(source, jpeg, {"quality": opts.get("quality") or "90"}, progress)
        return image_to_pdf_convert(jpeg, out, opts, progress)


@guarded
def svg_to_pdf_convert(source: Path, out: Path, opts: dict, progress) -> int:
    """Render SVG to PNG first so PDF output does not depend on ImageMagick PDF policy."""
    with tempfile.TemporaryDirectory(prefix="onetool-svg-pdf-") as tmp:
        png = Path(tmp) / "page.png"
        svg_to_png_convert(source, png, opts, progress)
        return image_to_pdf_convert(png, out, opts, progress)


@guarded
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


@guarded
def png_to_webp_convert(source: Path, out: Path, opts: dict, progress) -> int:
    return raster_image_convert(source, out, opts, progress)


@guarded
def _raster_output_signature(target: str, data: bytes) -> bool:
    if target in JPEG_SUFFIXES:
        return data.startswith(b"\xff\xd8\xff")
    if target == ".png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if target == ".webp":
        return data.startswith(b"RIFF") and data[8:12] == b"WEBP"
    return False


@guarded
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


@guarded
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


@guarded
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

