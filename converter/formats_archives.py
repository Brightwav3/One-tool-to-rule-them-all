from __future__ import annotations

from formats_common import *

def repack_convert(source: Path, out: Path, opts: dict, progress) -> int:
    progress(0, 0)
    with tempfile.TemporaryDirectory(prefix="onetool-pack-") as tmp:
        room = Path(tmp)
        extract_with_7zip(source, room, opts["password"]) if opts.get("password") else extract_with_7zip(source, room)
        members = [p for p in room.rglob("*") if p.is_file()]
        if not members:
            raise ValueError("the archive is empty")
        return zip_files(members, room, out, progress)

__all__ = ['repack_convert']
