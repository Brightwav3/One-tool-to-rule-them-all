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


class CreatorOptionTests(unittest.TestCase):
    """Every option a container declares has to change what it writes."""

    def setUp(self) -> None:
        self.room = Path(tempfile.mkdtemp(prefix="onetool-creator-opts-"))
        self.folder = self.room / "chapter"
        self.folder.mkdir()
        for n in (1, 2):
            write_png(self.folder / f"p{n}.png")
        self.loose = self.room / "cover.png"
        write_png(self.loose)

    def test_flatten_drops_the_folders(self):
        staged = formats._staged_items([self.folder], {"flatten": "true"})
        self.assertEqual(sorted(name for name, _ in staged), ["p1.png", "p2.png"])

    def test_without_flatten_the_folder_is_kept(self):
        staged = formats._staged_items([self.folder], {"flatten": "false"})
        self.assertEqual(sorted(name for name, _ in staged), ["chapter/p1.png", "chapter/p2.png"])

    def test_renumbering_rewrites_page_names_in_order(self):
        staged = formats._staged_items([self.loose, self.folder], {"rename": "true", "flatten": "true"})
        self.assertEqual([name for name, _ in staged], ["001.png", "002.png", "003.png"])

    def test_renumbering_leaves_a_mixed_list_alone(self):
        note = self.room / "notes.txt"
        note.write_text("not a page", encoding="utf-8")
        staged = formats._staged_items([self.loose, note], {"rename": "true"})
        self.assertEqual([name for name, _ in staged], ["cover.png", "notes.txt"])

    def test_store_writes_an_uncompressed_zip(self):
        out = self.room / "stored.zip"
        formats.items_to_zip_convert([self.folder], out, {"compress": "Store"}, silent)
        with zipfile.ZipFile(out) as archive:
            self.assertTrue(all(i.compress_type == zipfile.ZIP_STORED for i in archive.infolist()))

    def test_comicinfo_is_written_only_when_asked(self):
        with_meta = self.room / "with.cbz"
        without = self.room / "without.cbz"
        formats.items_to_zip_convert([self.folder], with_meta, {"meta": "true", "title": "Book"}, silent)
        formats.items_to_zip_convert([self.folder], without, {"meta": "false"}, silent)
        self.assertIn("ComicInfo.xml", zipfile.ZipFile(with_meta).namelist())
        self.assertNotIn("ComicInfo.xml", zipfile.ZipFile(without).namelist())
        self.assertIn(b"<Title>Book</Title>", zipfile.ZipFile(with_meta).read("ComicInfo.xml"))

    def test_comicinfo_escapes_what_it_is_given(self):
        self.assertIn(b"&amp;", formats.comic_info("Tom & Jerry", 2))

    def test_a_toggle_reads_the_strings_the_ui_sends(self):
        self.assertTrue(formats.creator_flag({"flatten": "true"}, "flatten"))
        self.assertFalse(formats.creator_flag({"flatten": "false"}, "flatten"))
        self.assertTrue(formats.creator_flag({}, "meta", default=True))
        self.assertFalse(formats.creator_flag({"meta": ""}, "meta"))

    def test_an_unknown_compression_falls_back_rather_than_failing(self):
        self.assertEqual(formats.creator_level({"compress": "Nonsense"}), "normal")
        self.assertEqual(formats.creator_level({"compress": "Max"}), "max")

    def test_every_declared_option_is_one_a_builder_reads(self):
        known = {"compress", "flatten", "rename", "meta", "password", "title", "creator", "dpi", "quality"}
        for converter in formats.REGISTRY:
            if not converter.multi:
                continue
            for option in converter.options:
                self.assertIn(option.key, known, f"{converter.id} declares {option.key}")


class ProbeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.room = Path(tempfile.mkdtemp(prefix="onetool-probe-"))

    def test_an_image_is_one_page(self):
        page = self.room / "a.png"
        write_png(page)
        probed = formats.probe_item(page)
        self.assertEqual((probed["kind"], probed["pages"], probed["ext"]), ("Image", 1, "PNG"))

    def test_an_archive_reports_the_pages_inside_it(self):
        book = self.room / "b.cbz"
        with zipfile.ZipFile(book, "w") as archive:
            archive.writestr("001.jpg", b"x")
            archive.writestr("002.jpg", b"x")
            archive.writestr("ComicInfo.xml", b"<x/>")
        self.assertEqual(formats.probe_item(book)["pages"], 2)

    def test_a_folder_reports_what_is_in_it(self):
        write_png(self.room / "a.png")
        (self.room / "notes.txt").write_text("x", encoding="utf-8")
        probed = formats.probe_item(self.room)
        self.assertEqual((probed["kind"], probed["pages"], probed["files"]), ("Folder", 1, 2))

    def test_an_unreadable_archive_is_blank_rather_than_wrong(self):
        broken = self.room / "broken.cbz"
        broken.write_bytes(b"not a zip")
        self.assertIsNone(formats.probe_item(broken)["pages"])

    def test_a_missing_item_is_an_error_not_a_guess(self):
        with self.assertRaises(ValueError):
            formats.probe_item(self.room / "gone.png")


class RecipeStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.path = Path(tempfile.mkdtemp(prefix="onetool-recipes-")) / "settings.json"
        self.store = server.SettingsStore(self.path)

    def test_recipes_survive_a_restart(self):
        self.store.set_recipes([{"id": "r1", "name": "Mine", "ext": "CBZ", "dest": "D:/out", "opts": {"compress": "Max"}}])
        again = server.SettingsStore(self.path)
        self.assertEqual([r["name"] for r in again.recipes()], ["Mine"])
        self.assertEqual(again.recipes()[0]["opts"], {"compress": "Max"})

    def test_a_recipe_without_an_id_is_dropped(self):
        self.store.set_recipes([{"name": "No id"}, {"id": "r2", "name": "Kept"}])
        self.assertEqual([r["id"] for r in self.store.recipes()], ["r2"])

    def test_recipes_do_not_disturb_the_output_folder(self):
        folder = self.path.parent
        self.store.set_folder(folder)
        self.store.set_recipes([{"id": "r1", "name": "Mine"}])
        self.assertEqual(server.SettingsStore(self.path).current_folder(), folder.resolve())


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
