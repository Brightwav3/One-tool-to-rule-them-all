#!/usr/bin/env python3
"""Local server behind the One Tool Electron interface.

Holds the job queue, drives the registry's converters on worker threads, serves
the dependency-free renderer, and exposes the JSON API used by the renderer and
agent tools.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import queue
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
import zipfile
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
import formats  # noqa: E402
from formats import REGISTRY  # noqa: E402

UI_DIR = Path(__file__).resolve().parent / "ui"
DEFAULT_OUT = Path.home() / "Converted"
MAX_UPLOAD = 8 * 1024 * 1024 * 1024
HISTORY_LIMIT = 500
FOLDER_HISTORY_LIMIT = 12
RECIPE_LIMIT = 40
DEFAULT_HISTORY = Path(os.environ.get("ONETOOL_HISTORY_PATH", str(Path.home() / ".one-tool-history.json")))
DEFAULT_SETTINGS = Path(os.environ.get("ONETOOL_SETTINGS_PATH", str(Path.home() / ".one-tool-settings.json")))


def clean_output_stem(name: str, suffix: str) -> str:
    """Validate a user-typed output name and return it without its extension.

    The extension belongs to the converter, not the user: letting it be edited
    would let a route silently write the wrong kind of file. A typed extension
    that already matches is accepted and trimmed, so pasting a full filename
    does the obvious thing.
    """
    cleaned = str(name).strip().rstrip(". ")
    if not cleaned:
        raise ValueError("the name cannot be empty")
    if cleaned != Path(cleaned).name or cleaned in {".", ".."}:
        raise ValueError("the name cannot contain a folder path")
    if set(cleaned) & set('<>:"/\\|?*') or any(ord(character) < 32 for character in cleaned):
        raise ValueError('a name cannot contain any of < > : " / \\ | ? *')

    stem = cleaned
    if suffix and stem.casefold().endswith(suffix.casefold()):
        stem = stem[: -len(suffix)].rstrip(". ") or stem
    if not stem:
        raise ValueError("the name cannot be empty")
    if stem.split(".")[0].upper() in WINDOWS_RESERVED_NAMES:
        raise ValueError(f"{stem} is a name Windows reserves for devices")
    if len(stem) > 180:
        raise ValueError("the name is too long")
    return stem


class HistoryStore:
    """Small atomic JSON store for individual conversion outputs."""

    def __init__(self, path: Path):
        self.path = Path(path).expanduser()
        self.lock = threading.Lock()
        self._records = self._load()

    def _load(self) -> list[dict]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return []
        return data if isinstance(data, list) else []

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(self._records[:HISTORY_LIMIT], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.replace(self.path)

    def append(self, record: dict) -> None:
        with self.lock:
            self._records.insert(0, dict(record))
            self._records = self._records[:HISTORY_LIMIT]
            self._save()

    def records(self, refresh: bool = False) -> list[dict]:
        with self.lock:
            result = [dict(record) for record in self._records]
        if refresh:
            for record in result:
                output = Path(str(record.get("outputPath", ""))).expanduser()
                record["presence"] = "present" if output.is_file() else "missing"
        return result

    def rename(self, record_id: str, name: str) -> dict:
        """Rename a written file on disk and keep the record pointing at it.

        The folder and the extension stay put, exactly as they do for a queued
        job. A file that has moved or gone is not renamed blindly — the record
        is the only thing that would change, and it would then be wrong.
        """
        with self.lock:
            record = next((r for r in self._records if str(r.get("id")) == str(record_id)), None)
            if record is None:
                raise ValueError("that file is no longer in the history")
            current = Path(str(record.get("outputPath", ""))).expanduser()
            if not current.is_file():
                raise ValueError("that file is no longer where it was saved")
            stem = clean_output_stem(name, current.suffix)
            target = current.with_name(f"{stem}{current.suffix}")
            if target == current:
                return dict(record)
            if target.exists():
                raise ValueError(f"{target.name} already exists in that folder")
            current.rename(target)
            record["outputPath"] = str(target)
            record["name"] = target.name
            self._save()
            return dict(record)

    def delete(self, ids: list[str]) -> None:
        wanted = {str(item) for item in ids}
        with self.lock:
            self._records = [record for record in self._records if str(record.get("id")) not in wanted]
            self._save()


class SettingsStore:
    """Small atomic store for the current output folder and recent folders."""

    def __init__(self, path: Path):
        self.path = Path(path).expanduser()
        self.lock = threading.Lock()
        self._data = self._load()

    def _load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, OSError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.path)

    @staticmethod
    def _normalise(folder: str | Path) -> str:
        return str(Path(folder).expanduser().resolve())

    def recipes(self) -> list[dict]:
        """The Creator's saved recipes. A recipe is a container plus its options,
        name and destination — small, self-contained, and stored right here next
        to the output-folder preference."""
        with self.lock:
            values = self._data.get("creatorRecipes", [])
        return [r for r in values if isinstance(r, dict) and r.get("id")] if isinstance(values, list) else []

    def set_recipes(self, recipes: list[dict]) -> list[dict]:
        kept = [
            {
                "id": str(recipe.get("id")),
                "name": str(recipe.get("name") or "Untitled recipe"),
                "ext": str(recipe.get("ext") or ""),
                "dest": str(recipe.get("dest") or ""),
                "opts": recipe.get("opts") if isinstance(recipe.get("opts"), dict) else {},
                "saved": True,
            }
            for recipe in recipes
            if isinstance(recipe, dict) and recipe.get("id")
        ][:RECIPE_LIMIT]
        with self.lock:
            self._data["creatorRecipes"] = kept
            self._save()
        return kept

    def current_folder(self) -> Path:
        with self.lock:
            raw = self._data.get("currentFolder")
        return Path(raw).expanduser().resolve() if raw else DEFAULT_OUT.resolve()

    def recent_folders(self) -> list[str]:
        with self.lock:
            values = self._data.get("recentFolders", [])
        if not isinstance(values, list):
            return []
        result = []
        seen = set()
        for value in values:
            try:
                normalised = self._normalise(str(value))
            except (OSError, RuntimeError, ValueError):
                continue
            if normalised not in seen:
                seen.add(normalised)
                result.append(normalised)
        return result[:FOLDER_HISTORY_LIMIT]

    def set_folder(self, folder: Path) -> Path:
        normalised = self._normalise(folder)
        recent = self.recent_folders()
        with self.lock:
            recent = [normalised, *recent]
            self._data["currentFolder"] = normalised
            self._data["recentFolders"] = list(dict.fromkeys(recent))[:FOLDER_HISTORY_LIMIT]
            self._save()
        return Path(normalised)

    def forget_folder(self, folder: Path) -> None:
        normalised = self._normalise(folder)
        recent = self.recent_folders()
        with self.lock:
            self._data["recentFolders"] = [item for item in recent if item != normalised]
            self._save()

# Native dialogs are kept behind the backend API so the same renderer works in
# Electron and in a local browser during development. Tk is only touched by
# this server's main thread.
_dialog_requests: "queue.Queue[tuple[str, dict, queue.Queue]]" = queue.Queue()


def public_options(options: dict[str, str]) -> dict[str, str]:
    """Keep one-time secrets out of renderer snapshots and history files."""
    return {key: value for key, value in options.items() if key != "password"}


def ask_main_thread(kind: str, **kwargs):
    reply: "queue.Queue" = queue.Queue(maxsize=1)
    _dialog_requests.put((kind, kwargs, reply))
    return reply.get()


def pump_dialogs(stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            kind, kwargs, reply = _dialog_requests.get(timeout=0.25)
        except queue.Empty:
            continue
        try:
            reply.put(_show_dialog(kind, **kwargs))
        except Exception:
            traceback.print_exc()
            reply.put(None)


def _show_dialog(kind: str, **kwargs):
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        if kind == "files":
            patterns = kwargs.get("patterns") or ["*.*"]
            return list(filedialog.askopenfilenames(
                parent=root,
                title="Choose files to convert",
                filetypes=[("Supported files", " ".join(patterns)), ("All files", "*.*")],
            ) or [])
        if kind == "folder":
            return filedialog.askdirectory(parent=root, title="Choose output folder") or None
        raise ValueError(f"unknown dialog: {kind}")
    finally:
        root.destroy()


# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# Jobs
# --------------------------------------------------------------------------- #


WINDOWS_RESERVED_NAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{digit}" for digit in range(1, 10)}
    | {f"LPT{digit}" for digit in range(1, 10)}
)


class Job:
    def __init__(
        self,
        job_id: str,
        source: Path | list[Path],
        converter,
        temporary: bool = False,
        output_folder: Path | None = None,
        name: str = "",
    ):
        self.id = job_id
        # One source or many. `source` stays the first of them, so every
        # single-file call site — the whole Convert view included — is unchanged.
        self.sources = [source] if isinstance(source, Path) else list(source)
        if not self.sources:
            raise ValueError("a job needs at least one source file")
        self.temporary = temporary
        self.output_folder = Path(output_folder or DEFAULT_OUT).expanduser().resolve()
        self.name = name or self.source.name
        self.base = Path(name).stem if name else self.source.stem
        self.source_size = sum(p.stat().st_size for p in self.sources if p.is_file())
        self.opts: dict[str, str] = {}
        self.status = "idle"
        self.units = 0
        self.done_units = 0
        self.phase = "working"
        self.size = 0
        self.error_title = ""
        self.error = ""
        self.set_converter(converter)

    @property
    def source(self) -> Path:
        return self.sources[0]

    def set_output_name(self, name: str) -> None:
        """Rename what this job will write, keeping the folder and extension."""
        suffix = self.converter.ext if self.converter else self.source.suffix
        stem = clean_output_stem(name, suffix)
        self.base = stem
        self.out = str(Path(self.out).parent / f"{stem}{suffix}")

    def set_converter(self, converter) -> None:
        previous_opts = dict(getattr(self, "opts", {}))
        self.converter = converter
        self.opts = previous_opts
        self.status = "idle"
        self.units = 0
        self.done_units = 0
        self.phase = "working"
        self.size = 0
        self.error_title = ""
        self.error = ""
        if converter is None:
            self.out = str(self.output_folder / f"{self.base}{self.source.suffix}")
            self.fail(
                "No converter handles this file",
                f"Nothing in the registry claims {self.source.suffix or 'files without an extension'}. "
                "Pick a conversion on the left and add it there instead.",
            )
            return

        # Named from `base` rather than the source stem, so a rename survives a
        # later change of route.
        self.out = str(self.output_folder / f"{self.base}{converter.ext}")
        if converter.options and "title" in {o.key for o in converter.options}:
            self.opts.setdefault("title", self.source.stem)

        state = converter.state()
        if state == "soon":
            self.fail("Not built yet", f"{converter.label} is declared but not implemented.")
        elif state == "helper":
            self.fail(
                f"{converter.helper.name} isn't installed",
                f"{converter.label} is ready to run — it just needs {converter.helper.name} on this machine first.",
            )
        elif converter.multi:
            # A container's unit is an item, and they are all already known.
            self.units = len(self.sources)
        elif converter.probe:
            try:
                self.units = converter.probe(self.source)
            except ValueError as exc:
                self.fail("This file can't be converted", str(exc))
            except (OSError, zipfile.BadZipFile) as exc:
                self.fail("This file could not be opened", str(exc))

    def fail(self, title: str, message: str) -> None:
        self.status = "error"
        self.error_title = title
        self.error = message

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "conv": self.converter.id if self.converter else None,
            "from": self.converter.src if self.converter else self.source.suffix.lstrip(".").upper(),
            "to": self.converter.dst if self.converter else "",
            "convLabel": self.converter.label if self.converter else "—",
            "kind": self.converter.kind if self.converter else "doc",
            "name": self.name,
            "sourcePath": str(self.source),
            "sourcePaths": [str(p) for p in self.sources],
            "items": len(self.sources),
            "base": self.base,
            "sourceSize": self.source_size,
            "sourceExt": self.source.suffix.casefold(),
            "opts": public_options(self.opts),
            "out": self.out,
            "status": self.status,
            "units": self.units,
            "doneUnits": self.done_units,
            "phase": self.phase,
            "size": self.size,
            "errorTitle": self.error_title,
            "error": self.error,
        }


class Converter:
    """The job queue. One worker, one job at a time, in the order they were added."""

    def __init__(self, history_path: Path | None = None, settings_path: Path | None = None) -> None:
        self.lock = threading.Lock()
        self.jobs: dict[str, Job] = {}
        self.order: list[str] = []
        self.history: list[dict] = []
        self.history_path = history_path
        self.history_store = HistoryStore(history_path or DEFAULT_HISTORY)
        self.settings_store = SettingsStore(settings_path or DEFAULT_SETTINGS)
        self.output_folder = self.settings_store.current_folder()
        self.seq = 0
        self.selected: str | None = "cbz-epub"
        self.worker: threading.Thread | None = None

    # -- queue ------------------------------------------------------------- #

    def add(
        self,
        source: Path | list[Path],
        converter=None,
        temporary: bool = False,
        name: str = "",
    ) -> Job:
        if converter is None and isinstance(source, Path):
            converter = REGISTRY.route(source)
        with self.lock:
            self.seq += 1
            job = Job(str(self.seq), source, converter, temporary, self.output_folder, name)
            self.jobs[job.id] = job
            self.order.append(job.id)
            return job

    def snapshot(self) -> list[dict]:
        with self.lock:
            return [self.jobs[i].as_dict() for i in self.order if i in self.jobs]

    def update(self, job_id: str, key: str, value: str) -> None:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job or job.status in ("queued", "running"):
                return
            if key == "__out":
                job.out = value
            else:
                job.opts[key] = value
                if key == "password":
                    job.status = "idle"
                    job.error_title = ""
                    job.error = ""

    def rename(self, job_id: str, name: str) -> None:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError("file is no longer in the queue")
            if job.status in ("queued", "running"):
                raise ValueError("cannot rename a file while it is converting")
            job.set_output_name(name)

    def route(self, job_id: str, converter_id: str) -> None:
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError("file is no longer in the queue")
            if job.status in ("queued", "running"):
                raise ValueError("cannot change a route while it is running")
            converter = REGISTRY.get(converter_id)
            if not converter:
                raise ValueError(f"unknown converter: {converter_id}")
            if job.converter and job.converter.multi:
                raise ValueError("a created file keeps the container it was built for")
            if converter.multi:
                raise ValueError(f"{converter.id} builds new files rather than converting one")
            if job.source.suffix.casefold() not in converter.extensions:
                raise ValueError(
                    f"{converter.id} does not accept {job.source.suffix or 'files without an extension'}"
                )
            job.set_converter(converter)

    def set_output_folder(self, folder: Path) -> None:
        folder = folder.expanduser().resolve()
        with self.lock:
            jobs = list(self.jobs.values())
            if any(job.status in ("queued", "running") for job in jobs):
                raise ValueError("cannot change the output folder while conversion is running")
            for job in jobs:
                job.output_folder = folder
                suffix = job.converter.ext if job.converter else Path(job.out).suffix
                job.out = str(folder / f"{job.base}{suffix}")
            self.output_folder = folder
        self.settings_store.set_folder(folder)

    def output_folders(self) -> list[str]:
        return self.settings_store.recent_folders()

    def forget_output_folder(self, folder: Path) -> None:
        self.settings_store.forget_folder(folder)

    def refresh_states(self) -> None:
        with self.lock:
            jobs = [job for job in self.jobs.values() if job.status in ("idle", "error") and job.converter]
        for job in jobs:
            previous_out = job.out
            job.set_converter(job.converter)
            if job.converter:
                job.out = str(Path(previous_out).with_suffix(job.converter.ext))

    def history_records(self, refresh: bool = False) -> list[dict]:
        return self.history_store.records(refresh=refresh)

    def delete_history(self, ids: list[str]) -> None:
        self.history_store.delete(ids)

    def rename_history(self, record_id: str, name: str) -> dict:
        return self.history_store.rename(record_id, name)

    def requeue_history(self, ids: list[str]) -> list[Job]:
        wanted = {str(item) for item in ids}
        added: list[Job] = []
        for record in self.history_store.records():
            if str(record.get("id")) not in wanted:
                continue
            source = Path(str(record.get("sourcePath", ""))).expanduser()
            converter = REGISTRY.get(str(record.get("conv", "")))
            if not source.is_file() or not converter:
                continue
            if source.suffix.casefold() not in converter.extensions:
                continue
            added.append(self.add(source, converter))
        if len(added) > 1:
            self.selected = "mixed"
        elif added:
            self.selected = added[0].converter.id
        return added

    def remove(self, job_id: str) -> None:
        with self.lock:
            job = self.jobs.pop(job_id, None)
            if job_id in self.order:
                self.order.remove(job_id)
        if job and job.temporary:
            for staged in job.sources:
                staged.unlink(missing_ok=True)

    def remove_many(self, job_ids: list[str]) -> None:
        for job_id in job_ids:
            self.remove(str(job_id))

    def clear(self) -> None:
        for job_id in list(self.order):
            with self.lock:
                job = self.jobs.get(job_id)
            if job and job.status in ("queued", "running"):
                continue
            self.remove(job_id)

    def select(self, converter_id: str | None) -> None:
        """Switching conversions keeps only the jobs that belong to it."""
        with self.lock:
            self.selected = converter_id
            if converter_id in (None, "mixed"):
                return
            keep = [i for i in self.order if self.jobs[i].converter and self.jobs[i].converter.id == converter_id]
            dropped = [i for i in self.order if i not in keep]
        for job_id in dropped:
            with self.lock:
                job = self.jobs.get(job_id)
            if job and job.status in ("queued", "running"):
                continue
            self.remove(job_id)

    # -- running ----------------------------------------------------------- #

    def start(self, job_ids: list[str] | None = None) -> None:
        with self.lock:
            allowed = set(job_ids) if job_ids is not None else None
            pending = [
                self.jobs[i]
                for i in self.order
                if self.jobs[i].status == "idle" and (allowed is None or i in allowed)
            ]
            for job in pending:
                job.status = "queued"
                job.done_units = 0
            running = self.worker is not None and self.worker.is_alive()
            if pending and not running:
                self.worker = threading.Thread(target=self._run, daemon=True)
                self.worker.start()

    def busy(self) -> bool:
        with self.lock:
            return any(self.jobs[i].status in ("queued", "running") for i in self.order if i in self.jobs)

    def _next_queued(self) -> Job | None:
        with self.lock:
            for job_id in self.order:
                job = self.jobs.get(job_id)
                if job and job.status == "queued":
                    return job
        return None

    def _run(self) -> None:
        started = len(self.history)
        while True:
            job = self._next_queued()
            if job is None:
                self._record(started)
                return
            job.status = "running"
            try:
                out = Path(job.out).expanduser()
                if not out.suffix:
                    out = out / f"{job.base}{job.converter.ext}"
                job.converter.convert(
                    job.sources if job.converter.multi else job.source, out, job.opts,
                    lambda done, total, phase="working", j=job: self._tick(j, done, total, phase),
                )
                job.out = str(out)
                job.size = out.stat().st_size if out.exists() else 0
                job.status = "done"
            except ValueError as exc:
                job.fail("Conversion failed", str(exc))
            except (OSError, zipfile.BadZipFile) as exc:
                job.fail("Conversion failed", str(exc))
            except Exception as exc:  # one bad file must never kill the queue
                traceback.print_exc()
                job.fail("Conversion failed", f"{type(exc).__name__}: {exc}")
            finally:
                if job.temporary and job.status == "done":
                    for staged in job.sources:
                        staged.unlink(missing_ok=True)

    @staticmethod
    def _tick(job: Job, done: int, total: int, phase: str = "working") -> None:
        job.done_units = done
        job.phase = phase
        if total:
            job.units = total

    def _record(self, marker: int) -> None:
        jobs = self.snapshot()
        if not jobs:
            return
        finished_at = datetime.now().isoformat(timespec="seconds")
        for job in jobs:
            if job["status"] not in ("done", "error"):
                continue
            self.history_store.append({
                "id": f"file-{int(time.time() * 1000)}-{job['id']}",
                "name": Path(job["out"]).name,
                "sourceName": job["name"],
                "sourcePath": str(self.jobs[job["id"]].source),
                "conv": job["conv"],
                "from": job["from"],
                "to": job["to"],
                "outputPath": job["out"],
                "size": job["size"],
                "finishedAt": finished_at,
                "state": "completed" if job["status"] == "done" else "uncompleted",
                "options": public_options(job["opts"]),
                "error": job["error"],
            })
        done = sum(1 for j in jobs if j["status"] == "done")
        failed = sum(1 for j in jobs if j["status"] == "error")
        first = jobs[0]["name"]
        label = first if len(jobs) == 1 else f"{first} + {len(jobs) - 1} more"
        convs = {j["convLabel"] for j in jobs}
        detail = f"{done} written" + (f", {failed} failed" if failed else "")
        detail += " — " + (", ".join(sorted(convs)) if len(convs) < 4 else f"{len(convs)} converters")
        self.history.insert(0, {
            "id": f"h{marker}-{len(self.history)}",
            "label": label,
            "detail": detail,
            "when": datetime.now().strftime("%H:%M"),
            "kind": "err" if failed and not done else ("warn" if failed else "ok"),
            "files": [{"path": str(self.jobs[j["id"]].source), "conv": j["conv"]}
                      for j in jobs if j["id"] in self.jobs],
        })
        del self.history[24:]


QUEUE = Converter()


def reveal(path: Path) -> None:
    try:
        if sys.platform == "win32":
            subprocess.run(["explorer", "/select,", str(path)], check=False)
        elif sys.platform == "darwin":
            subprocess.run(["open", "-R", str(path)], check=False)
        else:
            subprocess.run(["xdg-open", str(path.parent)], check=False)
    except OSError:
        traceback.print_exc()


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #


class Handler(BaseHTTPRequestHandler):
    server_version = "OneTool/2.0"

    def log_message(self, fmt, *args):
        pass

    def send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        # Clients may provide X-File-Size when streaming a request body.
        length = int(self.headers.get("Content-Length") or self.headers.get("X-File-Size") or 0)
        return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}

    def serve_file(self, path: Path) -> None:
        if not path.is_file():
            self.send_error(404)
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def state(self) -> dict:
        counts = REGISTRY.counts()
        return {
            "files": QUEUE.snapshot(),
            "selected": QUEUE.selected,
            "history": [{k: v for k, v in h.items() if k != "files"} for h in QUEUE.history],
            "historyCount": len(QUEUE.history_records()),
            "counts": counts,
            "busy": QUEUE.busy(),
            "outputFolder": str(QUEUE.output_folder),
            "outputFolders": QUEUE.output_folders(),
            "recipes": QUEUE.settings_store.recipes(),
        }

    def do_GET(self) -> None:
        route = urlparse(self.path).path
        if route in ("/", "/index.html"):
            self.serve_file(UI_DIR / "index.html")
        elif route == "/api/tools":
            self.send_json({"tools": REGISTRY.as_list(), "counts": REGISTRY.counts()})
        elif route == "/api/state":
            self.send_json(self.state())
        elif route == "/api/history":
            self.send_json({"history": QUEUE.history_records(refresh=True)})
        else:
            candidate = (UI_DIR / unquote(route).lstrip("/")).resolve()
            if UI_DIR.resolve() in candidate.parents:
                self.serve_file(candidate)
            else:
                self.send_error(404)

    def do_POST(self) -> None:
        route = urlparse(self.path).path
        try:
            if route == "/api/upload":
                self.handle_upload()
                return
            body = self.read_json()

            if route == "/api/add-path":
                self.enqueue_source(
                    Path(str(body.get("path", ""))),
                    temporary=False,
                    converter_id=body.get("converter"),
                )
            elif route == "/api/probe":
                # What the Creator can say about its items before it builds.
                raw = body.get("paths") if isinstance(body.get("paths"), list) else []
                probed = []
                for entry in raw:
                    try:
                        probed.append(formats.probe_item(Path(str(entry))))
                    except ValueError as exc:
                        probed.append({"path": str(entry), "name": Path(str(entry)).name, "error": str(exc)})
                self.send_json({"items": probed})
                return
            elif route == "/api/recipes":
                raw = body.get("recipes") if isinstance(body.get("recipes"), list) else []
                QUEUE.settings_store.set_recipes(raw)
            elif route == "/api/create":
                self.send_json({"id": self.create(body), **self.state()})
                return
            elif route == "/api/select":
                QUEUE.select(body.get("id"))
            elif route == "/api/pick-files":
                for name in ask_main_thread("files", patterns=["*.*"]) or []:
                    QUEUE.add(Path(name))
            elif route == "/api/pick-folder":
                folder = ask_main_thread("folder")
                if folder:
                    job_id = str(body.get("id", ""))
                    if job_id:
                        with QUEUE.lock:
                            job = QUEUE.jobs.get(job_id)
                        if job:
                            QUEUE.update(job_id, "__out", str(Path(folder) / Path(job.out).name))
                    else:
                        QUEUE.set_output_folder(Path(folder))
            elif route == "/api/set-folder":
                folder = str(body.get("folder", "")).strip()
                if not folder:
                    raise ValueError("output folder is required")
                QUEUE.set_output_folder(Path(folder))
            elif route == "/api/forget-folder":
                folder = str(body.get("folder", "")).strip()
                if not folder:
                    raise ValueError("output folder is required")
                QUEUE.forget_output_folder(Path(folder))
            elif route == "/api/route":
                QUEUE.route(str(body.get("id", "")), str(body.get("converter", "")))
            elif route == "/api/history/delete":
                ids = body.get("ids") if isinstance(body.get("ids"), list) else []
                QUEUE.delete_history(ids)
            elif route == "/api/history/requeue":
                ids = body.get("ids") if isinstance(body.get("ids"), list) else []
                QUEUE.requeue_history(ids)
            elif route == "/api/history/rename":
                QUEUE.rename_history(str(body.get("id")), str(body.get("name", "")))
            elif route == "/api/history/reveal":
                target = Path(str(body.get("path", ""))).expanduser()
                if target.exists():
                    reveal(target)
            elif route == "/api/rename":
                QUEUE.rename(str(body.get("id")), str(body.get("name", "")))
            elif route == "/api/update":
                QUEUE.update(str(body.get("id")), str(body.get("key")), str(body.get("value", "")))
            elif route == "/api/remove":
                QUEUE.remove(str(body.get("id")))
            elif route == "/api/remove-many":
                ids = body.get("ids") if isinstance(body.get("ids"), list) else []
                QUEUE.remove_many(ids)
            elif route == "/api/clear":
                QUEUE.clear()
            elif route == "/api/convert":
                ids = body.get("ids")
                QUEUE.start(ids if isinstance(ids, list) else None)
            elif route == "/api/recheck":
                REGISTRY.recheck()
                QUEUE.refresh_states()
            elif route == "/api/reveal":
                # Silence here reads as a dead button. Say what went wrong so the
                # renderer can surface it rather than appearing to do nothing.
                target = Path(str(body.get("path", "")))
                if not str(target).strip() or str(target) == ".":
                    self.send_json({"error": "there is no path to open for this file"}, status=400)
                    return
                if not target.exists():
                    self.send_json({"error": f"{target.name} is no longer at its saved path"}, status=404)
                    return
                reveal(target)
            elif route == "/api/open-url":
                url = str(body.get("url", ""))
                if url.startswith("https://"):
                    webbrowser.open(url)
            elif route == "/api/restore":
                self.restore(str(body.get("id", "")))
            else:
                self.send_error(404)
                return
        except ValueError as exc:
            # A rejected name or route is the caller's mistake, not a crash, and
            # its message is already written to be read by a person.
            self.send_json({"error": str(exc)}, status=400)
            return
        except Exception as exc:
            traceback.print_exc()
            self.send_json({"error": f"{type(exc).__name__}: {exc}"}, status=500)
            return
        payload = self.state()
        if route in ("/api/recheck", "/api/select", "/api/route"):
            payload["tools"] = REGISTRY.as_list()
        self.send_json(payload)

    def create(self, body: dict) -> str:
        """Build one container from many items.

        Everything after this — progress, cancel, errors, the toast and the
        history entry — is the queue's existing machinery, unchanged.
        """
        converter = REGISTRY.get(str(body.get("format", "")))
        if converter is None or not converter.multi:
            raise ValueError(f"unknown container: {body.get('format')}")

        raw_items = body.get("items") if isinstance(body.get("items"), list) else []
        items: list[Path] = []
        for entry in raw_items:
            path = Path(str(entry)).expanduser().resolve()
            if not path.exists():
                raise ValueError(f"{path.name} is no longer at its saved path")
            items.append(path)
        if not items:
            raise ValueError("pick at least one item to build from")

        name = str(body.get("name", "")).strip() or "Untitled"
        job = QUEUE.add(items, converter, name=name)
        job.set_output_name(name)

        dest = str(body.get("dest", "")).strip()
        if dest:
            folder = Path(dest).expanduser().resolve()
            if not folder.is_dir():
                raise ValueError(f"{folder} is not a folder")
            QUEUE.update(job.id, "__out", str(folder / Path(job.out).name))

        options = body.get("options") if isinstance(body.get("options"), dict) else {}
        known = {option.key for option in converter.options}
        for key, value in options.items():
            if str(key) in known:
                QUEUE.update(job.id, str(key), str(value))

        QUEUE.start([job.id])
        return job.id

    def restore(self, entry_id: str) -> None:
        """Put a past run's files back in the queue."""
        entry = next((h for h in QUEUE.history if h["id"] == entry_id), None)
        if not entry:
            return
        convs = {f["conv"] for f in entry["files"]}
        QUEUE.select(convs.pop() if len(convs) == 1 else "mixed")
        for item in entry["files"]:
            source = Path(item["path"])
            if source.exists():
                QUEUE.add(source, REGISTRY.get(item["conv"] or ""))

    def handle_upload(self) -> None:
        """Accept a raw file body and stage it for a queued conversion."""
        name = unquote(self.headers.get("X-Filename") or "dropped.bin")
        # Clients may provide X-File-Size when streaming a request body.
        length = int(self.headers.get("Content-Length") or self.headers.get("X-File-Size") or 0)
        if length <= 0 or length > MAX_UPLOAD:
            self.send_json({"error": "unsupported upload size"}, status=400)
            return

        staging = Path(self.server.staging_dir)
        staging.mkdir(parents=True, exist_ok=True)
        target = staging / Path(name).name
        stem, suffix, n = target.stem, target.suffix, 1
        while target.exists():
            target = staging / f"{stem} ({n}){suffix}"
            n += 1

        with target.open("wb") as fh:
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                total = 0
                while True:
                    size_line = self.rfile.readline(128)
                    if not size_line:
                        raise ValueError("upload ended before the final chunk")
                    size = int(size_line.split(b";", 1)[0].strip(), 16)
                    if size == 0:
                        while self.rfile.readline().strip():
                            pass
                        break
                    total += size
                    if total > length:
                        raise ValueError("upload exceeded its declared size")
                    remaining = size
                    while remaining > 0:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError("upload ended before the final chunk")
                        fh.write(chunk)
                        remaining -= len(chunk)
                    if self.rfile.read(2) != b"\r\n":
                        raise ValueError("invalid chunk terminator")
                if total != length:
                    raise ValueError("upload size did not match its declaration")
            else:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    fh.write(chunk)
                    remaining -= len(chunk)
                if remaining:
                    raise ValueError("upload ended before its declared size")

        self.enqueue_source(target, temporary=True)
        self.send_json(self.state())

    def enqueue_source(
        self,
        source: Path,
        temporary: bool = False,
        converter_id: str | None = None,
    ) -> None:
        source = source.expanduser().resolve()
        if not source.is_file():
            raise ValueError("the dropped file is no longer available")
        selected = REGISTRY.get(QUEUE.selected or "")
        routed = REGISTRY.route(source)
        requested = REGISTRY.get(str(converter_id)) if converter_id else None
        if converter_id and requested is None:
            raise ValueError(f"unknown converter: {converter_id}")
        if requested and source.suffix.casefold() not in requested.extensions:
            raise ValueError(
                f"{requested.id} does not accept {source.suffix or 'files without an extension'}"
            )
        # An explicit converter is used by the agent API. Otherwise a drop onto
        # a chosen conversion uses it; a mixed drop routes by extension.
        converter = requested or (
            selected if (selected and source.suffix.casefold() in selected.extensions) else routed
        )
        if not converter_id and selected and converter is not selected:
            QUEUE.select("mixed")
        QUEUE.add(source, converter, temporary=temporary)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Local server for the One Tool converter UI.")
    parser.add_argument("--port", type=int, default=8756, help="port to listen on (default: 8756)")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    args = parser.parse_args(argv)

    if not (UI_DIR / "index.html").is_file():
        print(f"error: missing UI files at {UI_DIR}", file=sys.stderr)
        return 1

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.staging_dir = Path(__file__).resolve().parent / ".dropped"
    url = f"http://127.0.0.1:{server.server_address[1]}/"

    counts = REGISTRY.counts()
    print(f"One Tool running at {url}  ({counts['ready']} ready, {counts['helper']} need a helper)")
    if not args.no_browser:
        threading.Timer(0.4, webbrowser.open, args=(url,)).start()
    stop = threading.Event()
    try:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        pump_dialogs(stop)
    except KeyboardInterrupt:
        print("\nstopping…")
    finally:
        stop.set()
        server.shutdown()
        server.server_close()
        time.sleep(0.1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
