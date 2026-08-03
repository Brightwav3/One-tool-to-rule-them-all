#!/usr/bin/env python3
"""Generate build/icon.ico — a 256px app mark, drawn with the standard library.

An open book on the accent blue, matching the accent used throughout the UI.
Run this after changing the mark: python app/build/make_icon.py
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

SIZE = 256
BG = (74, 99, 200, 255)        # the UI accent, oklch(0.52 0.13 255)
PAGE = (250, 249, 247, 255)    # the app surface
SHADE = (222, 226, 240, 255)
CLEAR = (0, 0, 0, 0)


def rounded_square(x: int, y: int, radius: int) -> bool:
    margin, r = 10, radius
    lo, hi = margin, SIZE - 1 - margin
    if not (lo <= x <= hi and lo <= y <= hi):
        return False
    cx = min(max(x, lo + r), hi - r)
    cy = min(max(y, lo + r), hi - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def book(x: int, y: int):
    """Two facing pages with a gutter down the middle."""
    top, bottom = 78, 190
    left, right = 52, 204
    spine, gutter = SIZE // 2, 5
    if not (top <= y <= bottom and left <= x <= right):
        return None
    # Each page sags toward the spine, the way an open book actually sits.
    near_spine = 1.0 - abs(x - spine) / ((right - left) / 2)
    sag = int(near_spine ** 1.6 * 26)
    if y < top + sag or y > bottom + sag // 3:
        return None
    if abs(x - spine) <= gutter:
        return SHADE
    return PAGE


def pixels() -> bytes:
    rows = []
    for y in range(SIZE):
        row = bytearray(b"\x00")  # PNG filter byte: none
        for x in range(SIZE):
            if not rounded_square(x, y, 56):
                row += bytes(CLEAR)
                continue
            row += bytes(book(x, y) or BG)
        rows.append(bytes(row))
    return b"".join(rows)


def chunk(kind: bytes, data: bytes) -> bytes:
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


def png() -> bytes:
    header = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(pixels(), 9))
        + chunk(b"IEND", b"")
    )


def ico(image: bytes) -> bytes:
    # A 256px ICO entry stores the PNG verbatim; 0 in the size field means 256.
    directory = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(image), 22)
    return struct.pack("<HHH", 0, 1, 1) + directory + image


if __name__ == "__main__":
    out = Path(__file__).with_name("icon.ico")
    image = png()
    out.write_bytes(ico(image))
    out.with_name("icon.png").write_bytes(image)
    print(f"wrote {out} ({out.stat().st_size} bytes)")
