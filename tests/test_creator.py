"""The Creator: many items into one container."""

import struct
import sys
import tarfile
import tempfile
import time
import unittest
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "converter"))

import formats  # noqa: E402
import server  # noqa: E402


def write_png(path: Path, width: int = 8, height: int = 8) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))

    raw = b"".join(b"\x00" + b"\xff\x00\x00" * width for _ in range(height))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def silent(done: int, total: int, phase: str = "working") -> None:
    pass


class CreatorItemsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.room = Path(tempfile.mkdtemp(prefix="onetool-creator-"))
        self.a = self.room / "a.png"
        self.b = self.room / "b.png"
        write_png(self.a)
        write_png(self.b)
        self.folder = self.room / "folder"
        self.folder.mkdir()
        write_png(self.folder / "c.png")
        self.items = [self.a, self.b, self.folder]

    def test_a_picked_folder_contributes_its_whole_tree(self):
        staged = formats._staged_items(self.items)
        self.assertEqual([name for name, _ in staged], ["a.png", "b.png", "folder/c.png"])

    def test_two_items_with_the_same_name_stay_distinct(self):
        twin = self.room / "twin"
        twin.mkdir()
        write_png(twin / "a.png")
        staged = formats._staged_items([self.a, twin / "a.png"])
        self.assertEqual([name for name, _ in staged], ["a.png", "a (1).png"])

    def test_a_missing_item_is_named_rather_than_silently_skipped(self):
        with self.assertRaises(ValueError) as caught:
            formats._staged_items([self.room / "gone.png"])
        self.assertIn("gone.png", str(caught.exception))

    def test_zip_keeps_the_listed_layout(self):
        out = self.room / "built.zip"
        self.assertEqual(formats.items_to_zip_convert(self.items, out, {}, silent), 3)
        with zipfile.ZipFile(out) as archive:
            self.assertEqual(sorted(archive.namelist()), ["a.png", "b.png", "folder/c.png"])

    def test_tgz_keeps_the_listed_layout(self):
        out = self.room / "built.tar.gz"
        self.assertEqual(formats.items_to_tgz_convert(self.items, out, {}, silent), 3)
        with tarfile.open(out) as archive:
            self.assertEqual(sorted(archive.getnames()), ["a.png", "b.png", "folder/c.png"])

    def test_epub_is_built_from_the_images(self):
        out = self.room / "built.epub"
        self.assertEqual(formats.items_to_epub_convert(self.items, out, {"title": "T"}, silent), 3)
        self.assertTrue(out.stat().st_size > 0)

    def test_a_container_with_no_images_says_so(self):
        note = self.room / "note.txt"
        note.write_text("no pictures here", encoding="utf-8")
        with self.assertRaises(ValueError):
            formats.items_to_epub_convert([note], self.room / "x.epub", {}, silent)

    def test_every_creator_converter_is_multi_and_claims_no_extensions(self):
        creators = [c for c in formats.REGISTRY if c.multi]
        self.assertTrue(creators)
        for converter in creators:
            self.assertEqual(converter.extensions, (), converter.id)
            self.assertIsNotNone(converter.convert, converter.id)


class CreatorJobTests(unittest.TestCase):
    def setUp(self) -> None:
        self.room = Path(tempfile.mkdtemp(prefix="onetool-creator-job-"))
        self.a = self.room / "a.png"
        self.b = self.room / "b.png"
        write_png(self.a)
        write_png(self.b)

    def test_a_single_source_job_still_reads_as_one_source(self):
        job = server.Job("1", self.a, formats.REGISTRY.get("items-zip"))
        self.assertEqual(job.sources, [self.a])
        self.assertEqual(job.source, self.a)

    def test_a_many_source_job_counts_every_item(self):
        job = server.Job("1", [self.a, self.b], formats.REGISTRY.get("items-zip"), name="Bundle")
        self.assertEqual(job.units, 2)
        self.assertEqual(job.base, "Bundle")
        self.assertEqual(job.as_dict()["items"], 2)
        self.assertEqual(job.as_dict()["sourcePaths"], [str(self.a), str(self.b)])
        self.assertEqual(job.source_size, self.a.stat().st_size + self.b.stat().st_size)

    def test_a_job_needs_at_least_one_source(self):
        with self.assertRaises(ValueError):
            server.Job("1", [], formats.REGISTRY.get("items-zip"))


class CreateRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.room = Path(tempfile.mkdtemp(prefix="onetool-create-route-"))
        self.a = self.room / "a.png"
        write_png(self.a)
        self.handler = server.Handler.__new__(server.Handler)

    def build(self, **overrides) -> str:
        body = {
            "format": "items-zip",
            "items": [str(self.a)],
            "name": "Bundle",
            "dest": str(self.room),
        }
        body.update(overrides)
        return self.handler.create(body)

    def wait(self, job_id: str) -> server.Job:
        for _ in range(200):
            job = server.QUEUE.jobs[job_id]
            if job.status in ("done", "error"):
                return job
            time.sleep(0.05)
        raise AssertionError("the job never finished")

    def test_create_writes_the_container_and_records_it(self):
        job = self.wait(self.build())
        self.assertEqual(job.status, "done", job.error)
        self.assertEqual(Path(job.out), self.room / "Bundle.zip")
        self.assertTrue(Path(job.out).is_file())

    def test_an_unknown_container_is_rejected(self):
        with self.assertRaises(ValueError):
            self.build(format="items-nonsense")

    def test_a_single_file_converter_cannot_be_asked_to_create(self):
        with self.assertRaises(ValueError):
            self.build(format="cbz-epub")

    def test_creating_from_nothing_is_rejected(self):
        with self.assertRaises(ValueError):
            self.build(items=[])

    def test_a_container_job_cannot_be_rerouted(self):
        job_id = self.build()
        self.wait(job_id)
        with self.assertRaises(ValueError):
            server.QUEUE.route(job_id, "cbz-epub")


if __name__ == "__main__":
    unittest.main()
