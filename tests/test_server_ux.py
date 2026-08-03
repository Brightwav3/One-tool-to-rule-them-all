import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "converter"))

import server  # noqa: E402


class ServerUxTests(unittest.TestCase):
    def make_cbz(self, root: Path, name: str = "book.cbz") -> Path:
        source = root / name
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("page-1.jpg", b"not-an-image")
        return source

    def test_route_changes_only_the_selected_job_and_updates_output_extension(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            queue = server.Converter(history_path=root / "history.json")
            first = queue.add(self.make_cbz(root, "one.cbz"), server.REGISTRY.get("cbz-epub"))
            second = queue.add(self.make_cbz(root, "two.cbz"), server.REGISTRY.get("cbz-epub"))
            first.opts["creator"] = "Millar & Hitch"

            queue.route(first.id, "cbz-pdf")

            self.assertEqual(queue.jobs[first.id].converter.id, "cbz-pdf")
            self.assertTrue(queue.jobs[first.id].out.endswith("one.pdf"))
            self.assertEqual(queue.jobs[first.id].opts["creator"], "Millar & Hitch")
            self.assertEqual(queue.jobs[second.id].converter.id, "cbz-epub")
            self.assertTrue(queue.jobs[second.id].out.endswith("two.epub"))
            self.assertGreater(queue.snapshot()[0]["sourceSize"], 0)

    def test_route_rejects_a_converter_for_the_wrong_source_extension(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            queue = server.Converter(history_path=root / "history.json")
            job = queue.add(self.make_cbz(root), server.REGISTRY.get("cbz-epub"))

            with self.assertRaisesRegex(ValueError, "does not accept"):
                queue.route(job.id, "pdf-cbz")

    def test_route_rejects_busy_jobs(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            queue = server.Converter(history_path=root / "history.json")
            job = queue.add(self.make_cbz(root), server.REGISTRY.get("cbz-epub"))
            job.status = "running"

            with self.assertRaisesRegex(ValueError, "while it is running"):
                queue.route(job.id, "cbz-pdf")

    def test_pdf_to_cbz_declares_every_poppler_binary_used_by_the_fallback(self):
        converter = server.REGISTRY.get("pdf-cbz")

        self.assertIsNotNone(converter)
        self.assertEqual(converter.helper.name, "Poppler (pdftoppm)")
        self.assertEqual(set(converter.helper.required), {"pdftoppm", "pdfinfo"})

    def test_requirement_helpers_expose_install_metadata(self):
        tool = server.REGISTRY.get("md-pdf").as_dict()
        renderer = next(item for item in tool["requirements"] if item["name"] == "PDF renderer")

        self.assertEqual(renderer["cmd"], "winget install --id MiKTeX.MiKTeX --exact")
        self.assertEqual(renderer["url"], "https://pandoc.org/installing.html")
        self.assertTrue(renderer["download"] == "")

    def test_history_store_survives_reload_and_marks_missing_outputs(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            output = root / "book.epub"
            output.write_bytes(b"epub")
            store = server.HistoryStore(root / "history.json")
            store.append({
                "id": "h1",
                "name": output.name,
                "sourceName": "book.cbz",
                "outputPath": str(output),
                "state": "completed",
            })

            reloaded = server.HistoryStore(root / "history.json")
            self.assertEqual(reloaded.records(refresh=True)[0]["presence"], "present")
            output.unlink()
            self.assertEqual(reloaded.records(refresh=True)[0]["presence"], "missing")

    def test_history_delete_removes_records_without_touching_outputs(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            output = root / "book.epub"
            output.write_bytes(b"epub")
            store = server.HistoryStore(root / "history.json")
            store.append({"id": "h1", "outputPath": str(output), "state": "completed"})

            store.delete(["h1"])

            self.assertEqual(store.records(), [])
            self.assertTrue(output.exists())

    def test_finished_jobs_are_persisted_as_individual_history_records(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            queue = server.Converter(history_path=root / "history.json")
            job = queue.add(self.make_cbz(root), server.REGISTRY.get("cbz-epub"))
            job.status = "done"
            job.out = str(root / "book.epub")
            job.size = 12
            Path(job.out).write_bytes(b"epub output")

            queue._record(0)

            records = queue.history_records()
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["sourceName"], "book.cbz")
            self.assertEqual(records[0]["conv"], "cbz-epub")
            self.assertEqual(records[0]["state"], "completed")

    def test_history_requeue_adds_existing_sources_with_the_recorded_route(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self.make_cbz(root)
            queue = server.Converter(history_path=root / "history.json")
            queue.history_store.append({
                "id": "h1",
                "sourcePath": str(source),
                "sourceName": source.name,
                "conv": "cbz-pdf",
                "outputPath": str(root / "book.pdf"),
                "state": "completed",
            })

            queue.requeue_history(["h1"])

            self.assertEqual(len(queue.snapshot()), 1)
            self.assertEqual(queue.snapshot()[0]["conv"], "cbz-pdf")

    def test_refresh_states_unblocks_a_job_after_its_helper_is_found(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            queue = server.Converter(history_path=root / "history.json")
            converter = server.REGISTRY.get("cbz-epub")
            job = queue.add(self.make_cbz(root), converter)
            job.status = "error"
            job.error_title = "7-Zip isn't installed"

            with mock.patch.object(type(converter), "state", return_value="ready"):
                queue.refresh_states()

            self.assertEqual(job.status, "idle")
            self.assertEqual(job.error_title, "")

    def test_output_folder_persists_as_the_default_and_can_be_forgotten(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            settings = root / "settings.json"
            chosen = root / "Exports"

            queue = server.Converter(history_path=root / "history.json", settings_path=settings)
            queue.set_output_folder(chosen)
            self.assertEqual(queue.output_folder, chosen.resolve())

            reloaded = server.Converter(history_path=root / "history-2.json", settings_path=settings)
            job = reloaded.add(self.make_cbz(root), server.REGISTRY.get("cbz-epub"))
            self.assertEqual(Path(job.out).parent, chosen.resolve())
            self.assertIn(str(chosen.resolve()), reloaded.output_folders())

            reloaded.forget_output_folder(chosen)
            self.assertNotIn(str(chosen.resolve()), reloaded.output_folders())

    def test_remove_many_removes_selected_queue_jobs(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            queue = server.Converter(history_path=root / "history.json", settings_path=root / "settings.json")
            first = queue.add(self.make_cbz(root, "one.cbz"), server.REGISTRY.get("cbz-epub"))
            second = queue.add(self.make_cbz(root, "two.cbz"), server.REGISTRY.get("cbz-epub"))

            queue.remove_many([first.id, second.id])

            self.assertEqual(queue.snapshot(), [])


if __name__ == "__main__":
    unittest.main()
