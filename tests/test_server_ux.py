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

    def test_inspector_renders_format_aware_facts_and_controls(self):
        source = (ROOT / "converter" / "ui" / "index.html").read_text(encoding="utf-8")

        self.assertIn("inspector-facts", source)
        self.assertIn("optionControl", source)
        self.assertIn("data-act=\"update-field\"", source)
        self.assertIn("document.addEventListener('change'", source)

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

    def test_rename_changes_the_output_and_keeps_the_route_extension(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            queue = server.Converter(history_path=root / "history.json")
            job = queue.add(self.make_cbz(root), server.REGISTRY.get("cbz-epub"))

            queue.rename(job.id, "Saga volume one")

            self.assertTrue(queue.jobs[job.id].out.endswith("Saga volume one.epub"))
            # the source on disk is the user's file and is never touched
            self.assertTrue(self.make_cbz(root).is_file())

    def test_rename_survives_a_later_change_of_route(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            queue = server.Converter(history_path=root / "history.json")
            job = queue.add(self.make_cbz(root), server.REGISTRY.get("cbz-epub"))

            queue.rename(job.id, "Saga volume one")
            queue.route(job.id, "cbz-pdf")

            self.assertTrue(queue.jobs[job.id].out.endswith("Saga volume one.pdf"))

    def test_rename_trims_an_extension_the_user_typed(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            queue = server.Converter(history_path=root / "history.json")
            job = queue.add(self.make_cbz(root), server.REGISTRY.get("cbz-epub"))

            queue.rename(job.id, "Saga.epub")

            self.assertTrue(queue.jobs[job.id].out.endswith("Saga.epub"))
            self.assertNotIn("Saga.epub.epub", queue.jobs[job.id].out)

    def test_rename_rejects_names_that_would_escape_or_break_the_folder(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            queue = server.Converter(history_path=root / "history.json")
            job = queue.add(self.make_cbz(root), server.REGISTRY.get("cbz-epub"))

            for name, expected in (
                ("", "cannot be empty"),
                ("   ", "cannot be empty"),
                ("../escape", "folder path"),
                ("nested/name", "folder path"),
                ("bad:name", "cannot contain"),
                ("CON", "reserves"),
            ):
                with self.subTest(name=name):
                    with self.assertRaisesRegex(ValueError, expected):
                        queue.rename(job.id, name)

            self.assertTrue(queue.jobs[job.id].out.endswith("book.epub"))

    def test_rename_rejects_busy_jobs(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            queue = server.Converter(history_path=root / "history.json")
            job = queue.add(self.make_cbz(root), server.REGISTRY.get("cbz-epub"))
            job.status = "running"

            with self.assertRaisesRegex(ValueError, "while it is converting"):
                queue.rename(job.id, "anything")

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

    def test_history_rename_moves_the_file_and_keeps_the_record_pointing_at_it(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            output = root / "book.epub"
            output.write_bytes(b"epub")
            store = server.HistoryStore(root / "history.json")
            store.append({"id": "h1", "name": output.name, "outputPath": str(output), "state": "completed"})

            store.rename("h1", "Ultimates v01")

            renamed = root / "Ultimates v01.epub"
            self.assertTrue(renamed.exists())
            self.assertFalse(output.exists())
            record = store.records()[0]
            self.assertEqual(record["name"], "Ultimates v01.epub")
            self.assertEqual(record["outputPath"], str(renamed))
            # the extension belongs to the conversion, so typing it changes nothing
            store.rename("h1", "Ultimates v01.epub")
            self.assertEqual(store.records()[0]["name"], "Ultimates v01.epub")

    def test_history_rename_refuses_bad_names_a_collision_and_a_missing_file(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            output, neighbour = root / "book.epub", root / "taken.epub"
            output.write_bytes(b"epub")
            neighbour.write_bytes(b"epub")
            store = server.HistoryStore(root / "history.json")
            store.append({"id": "h1", "name": output.name, "outputPath": str(output), "state": "completed"})

            for bad in ("", "   ", "sub/book", "..", "con", "b" * 200, 'a"b'):
                with self.assertRaises(ValueError):
                    store.rename("h1", bad)
            with self.assertRaises(ValueError):
                store.rename("h1", "taken")
            with self.assertRaises(ValueError):
                store.rename("nope", "book")
            # nothing was renamed on the way through
            self.assertTrue(output.exists())
            self.assertEqual(store.records()[0]["outputPath"], str(output))

            output.unlink()
            with self.assertRaises(ValueError):
                store.rename("h1", "anything")

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
