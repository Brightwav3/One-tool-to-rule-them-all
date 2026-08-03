#!/usr/bin/env python3
"""Structured command-line tools for agents using One Tool.

This module is intentionally standard-library-only. It talks to the same
localhost HTTP backend, so agents get the real registry,
queue, progress and error behaviour instead of a second conversion path.

Examples:

    python converter/agent_tools.py specs --pretty
    python converter/agent_tools.py tools
    python converter/agent_tools.py --start convert input.pdf --converter pdf-md
    python converter/agent_tools.py convert *.png --converter png-webp --output-dir out

Every command writes one JSON document to stdout. Errors are JSON on stderr
and use a non-zero exit code.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


DEFAULT_URL = "http://127.0.0.1:8756/"
SERVER_LINE = re.compile(r"(http://127\.0\.0\.1:\d+/)")


TOOL_SPECS = [
    {
        "name": "list_converters",
        "description": "List available conversions, readiness, dependencies and options.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "get_state",
        "description": "Read the current queue, job progress, history and readiness counts.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "convert_files",
        "description": "Queue and convert one or more local files, optionally selecting a converter and output directory.",
        "parameters": {
            "type": "object",
            "required": ["paths"],
            "properties": {
                "paths": {"type": "array", "items": {"type": "string"}},
                "converter": {"type": "string", "description": "Converter ID from list_converters."},
                "output_dir": {"type": "string"},
                "options": {"type": "object", "additionalProperties": {"type": "string"}},
                "wait": {"type": "boolean", "default": True},
                "timeout": {"type": "number", "default": 3600},
            },
        },
    },
    {
        "name": "wait_for_jobs",
        "description": "Wait until selected job IDs finish and return their final status.",
        "parameters": {
            "type": "object",
            "properties": {
                "ids": {"type": "array", "items": {"type": "string"}},
                "timeout": {"type": "number", "default": 3600},
            },
        },
    },
    {
        "name": "recheck_helpers",
        "description": "Re-probe installed external helpers and return the refreshed converter registry.",
        "parameters": {"type": "object", "properties": {}},
    },
]


class AgentError(RuntimeError):
    """An expected, user-actionable agent API failure."""


class AppClient:
    def __init__(self, url: str | None = None, start_backend: bool = False, timeout: float = 30) -> None:
        self.requested_url = (url or os.environ.get("ONETOOL_URL") or DEFAULT_URL).rstrip("/") + "/"
        self.start_backend = start_backend
        self.timeout = timeout
        self.base_url: str | None = None
        self.backend: subprocess.Popen[str] | None = None

    def close(self) -> None:
        if not self.backend:
            return
        self.backend.terminate()
        try:
            self.backend.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.backend.kill()
            self.backend.wait(timeout=3)
        self.backend = None

    def _start_local_backend(self) -> str:
        server = Path(__file__).resolve().with_name("server.py")
        if not server.is_file():
            raise AgentError(f"backend not found: {server}")

        self.backend = subprocess.Popen(
            [sys.executable, "-u", str(server), "--port", "0"],
            cwd=str(server.parent.parent),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        lines: queue.Queue[str] = queue.Queue()

        def read_stdout() -> None:
            assert self.backend and self.backend.stdout
            for line in self.backend.stdout:
                lines.put(line)

        threading.Thread(target=read_stdout, daemon=True).start()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                line = lines.get(timeout=0.2)
            except queue.Empty:
                if self.backend.poll() is not None:
                    break
                continue
            match = SERVER_LINE.search(line)
            if match:
                return match.group(1)

        stderr = ""
        if self.backend and self.backend.stderr:
            try:
                stderr = self.backend.stderr.read(4000)
            except OSError:
                pass
        self.close()
        raise AgentError(f"could not start the local backend{': ' + stderr.strip() if stderr.strip() else ''}")

    def _request_url(self, base_url: str, method: str, route: str, payload: Any = None) -> dict:
        body = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(urljoin(base_url, route.lstrip("/")), data=body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
        except HTTPError as exc:
            try:
                detail = json.loads(exc.read().decode("utf-8"))
            except (OSError, ValueError):
                detail = {"error": str(exc)}
            raise AgentError(detail.get("error", str(exc))) from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise AgentError(f"could not reach One Tool at {base_url}: {exc}") from exc
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise AgentError("One Tool returned invalid JSON") from exc
        if isinstance(data, dict) and data.get("error"):
            raise AgentError(str(data["error"]))
        return data

    def _ensure_connection(self) -> str:
        if self.base_url:
            return self.base_url
        try:
            self._request_url(self.requested_url, "GET", "/api/state")
            self.base_url = self.requested_url
            return self.base_url
        except AgentError:
            if not self.start_backend:
                raise
        self.base_url = self._start_local_backend()
        return self.base_url

    def request(self, method: str, route: str, payload: Any = None) -> dict:
        return self._request_url(self._ensure_connection(), method, route, payload)

    def tools(self) -> dict:
        return self.request("GET", "/api/tools")

    def state(self) -> dict:
        return self.request("GET", "/api/state")

    def wait(self, ids: list[str] | None = None, timeout: float = 3600) -> dict:
        wanted = set(ids or [])
        deadline = time.monotonic() + timeout
        while True:
            state = self.state()
            jobs = state.get("files", [])
            relevant = [job for job in jobs if not wanted or job.get("id") in wanted]
            if wanted and len(relevant) < len(wanted):
                missing = sorted(wanted - {str(job.get("id")) for job in relevant})
                raise AgentError(f"job IDs no longer exist: {', '.join(missing)}")
            terminal = ("done", "error") if wanted else ("idle", "done", "error")
            if relevant and all(job.get("status") in terminal for job in relevant):
                return state
            if not relevant and not state.get("busy"):
                return state
            if time.monotonic() >= deadline:
                raise AgentError(f"timed out waiting for {', '.join(sorted(wanted)) or 'the queue'}")
            time.sleep(0.25)

    def convert(
        self,
        paths: list[str],
        converter: str | None = None,
        output_dir: str | None = None,
        options: dict[str, str] | None = None,
        wait: bool = True,
        timeout: float = 3600,
    ) -> dict:
        if not paths:
            raise AgentError("at least one input path is required")

        manifest = self.tools()
        converter_info = None
        if converter:
            converter_info = next((item for item in manifest.get("tools", []) if item.get("id") == converter), None)
            if converter_info is None:
                raise AgentError(f"unknown converter: {converter}")
            if converter_info.get("state") != "ready":
                raise AgentError(
                    f"converter {converter} is {converter_info.get('state')}; install its helper or choose a ready converter"
                )
            allowed = {item["key"] for item in converter_info.get("options", [])}
            unknown = sorted(set(options or {}) - allowed)
            if unknown:
                raise AgentError(f"unsupported option(s) for {converter}: {', '.join(unknown)}")

        before = {str(job.get("id")) for job in self.state().get("files", [])}
        job_ids: list[str] = []
        default_outputs: dict[str, str] = {}
        for raw_path in paths:
            path = Path(raw_path).expanduser().resolve()
            response = self.request(
                "POST",
                "/api/add-path",
                {"path": str(path), **({"converter": converter} if converter else {})},
            )
            current = {str(job.get("id")) for job in response.get("files", [])}
            for job in response.get("files", []):
                if job.get("id") is not None and job.get("out"):
                    default_outputs[str(job["id"])] = str(job["out"])
            new_ids = [job_id for job_id in current - before if job_id not in job_ids]
            job_ids.extend(sorted(new_ids, key=int))
            before = current

        if not job_ids:
            raise AgentError("the app did not add any jobs")

        for job_id in job_ids:
            for key, value in (options or {}).items():
                self.request("POST", "/api/update", {"id": job_id, "key": key, "value": str(value)})
            if output_dir:
                output_name = Path(default_outputs.get(job_id, job_id)).name
                self.request(
                    "POST",
                    "/api/update",
                    {
                        "id": job_id,
                        "key": "__out",
                        "value": str(Path(output_dir).expanduser().resolve() / output_name),
                    },
                )

        state = self.request("POST", "/api/convert", {"ids": job_ids})
        if wait:
            state = self.wait(job_ids, timeout)
        jobs = [job for job in state.get("files", []) if str(job.get("id")) in job_ids]
        return {
            "ok": all(job.get("status") == "done" for job in jobs) if wait else True,
            "jobIds": job_ids,
            "jobs": jobs,
            "outputs": [job.get("out") for job in jobs if job.get("status") == "done"],
            "errors": [
                {"id": job.get("id"), "title": job.get("errorTitle"), "error": job.get("error")}
                for job in jobs if job.get("status") == "error"
            ],
            "state": state,
        }


def parse_options(values: list[str]) -> dict[str, str]:
    options: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise AgentError(f"option must use KEY=VALUE: {value}")
        key, option_value = value.split("=", 1)
        if not key:
            raise AgentError(f"option key is empty: {value}")
        options[key] = option_value
    return options


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="JSON agent tools for One Tool to Rule Them All")
    parser.add_argument("--url", help="running backend URL; defaults to ONETOOL_URL or localhost:8756")
    parser.add_argument("--start", action="store_true", help="start a private backend if the configured URL is unavailable")
    parser.add_argument("--timeout", type=float, default=30, help="HTTP request timeout in seconds")
    parser.add_argument("--pretty", action="store_true", help="indent JSON output")
    sub = parser.add_subparsers(dest="command", required=True)
    command_parsers = []
    command_parsers.append(sub.add_parser("specs", help="print machine-readable agent tool definitions"))
    command_parsers.append(sub.add_parser("tools", help="list converter capabilities"))
    command_parsers.append(sub.add_parser("status", help="show queue state"))
    command_parsers.append(sub.add_parser("recheck", help="re-probe external helpers"))
    convert = sub.add_parser("convert", help="queue and convert local files")
    convert.add_argument("paths", nargs="+", help="input files")
    convert.add_argument("--converter", help="converter ID from the tools command")
    convert.add_argument("--output-dir", help="directory for generated files")
    convert.add_argument("--option", action="append", default=[], metavar="KEY=VALUE")
    convert.add_argument("--no-wait", action="store_true", help="return after queueing instead of waiting")
    convert.add_argument("--wait-timeout", type=float, default=3600)
    command_parsers.append(convert)
    wait = sub.add_parser("wait", help="wait for jobs to finish")
    wait.add_argument("ids", nargs="*", help="job IDs; omit to wait for the whole queue")
    wait.add_argument("--wait-timeout", type=float, default=3600)
    command_parsers.append(wait)
    for command_parser in command_parsers:
        command_parser.add_argument("--pretty", action="store_true", default=argparse.SUPPRESS,
                                    help="indent JSON output")
    return parser


def run(args: argparse.Namespace, client: AppClient) -> dict:
    if args.command == "specs":
        return {"tools": TOOL_SPECS}
    if args.command == "tools":
        return client.tools()
    if args.command == "status":
        return client.state()
    if args.command == "recheck":
        return client.request("POST", "/api/recheck")
    if args.command == "wait":
        return client.wait(args.ids or None, args.wait_timeout)
    if args.command == "convert":
        return client.convert(
            args.paths,
            converter=args.converter,
            output_dir=args.output_dir,
            options=parse_options(args.option),
            wait=not args.no_wait,
            timeout=args.wait_timeout,
        )
    raise AgentError(f"unknown command: {args.command}")


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)
    client = AppClient(args.url, args.start, args.timeout)
    try:
        payload = run(args, client)
        print(json.dumps(payload, ensure_ascii=False, indent=2 if args.pretty else None))
        return 0 if payload.get("ok", True) else 1
    except AgentError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
