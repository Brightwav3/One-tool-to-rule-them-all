from __future__ import annotations

from formats_common import *

def pdf_to_txt_convert(source: Path, out: Path, opts: dict, progress) -> int:
    progress(0, 0)
    out.parent.mkdir(parents=True, exist_ok=True)
    run([which("pdftotext"), "-layout", str(source), str(out)], "Poppler")
    if not out.exists() or out.stat().st_size == 0:
        raise ValueError("no text layer found — this looks like a scan, which needs OCR")
    progress(1, 1)
    return 1

class PdfMarkdownWorker:
    """One serialized Node process for a batch of PDF Inspector requests."""

    def __init__(self, runtime: str, runner: Path) -> None:
        self.runtime = runtime
        self.runner = Path(runner)
        self.lock = threading.Lock()
        self.process: subprocess.Popen[str] | None = None

    def _start_locked(self) -> None:
        if self.process is not None and self.process.poll() is None:
            return
        try:
            env = os.environ.copy()
            if os.environ.get("ONETOOL_ELECTRON_RUN_AS_NODE") == "1":
                env["ELECTRON_RUN_AS_NODE"] = "1"
            self.process = subprocess.Popen(
                [self.runtime, str(self.runner), "--worker"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                env=env,
                **NO_WINDOW,
            )
        except OSError as exc:
            self.process = None
            raise ValueError(f"PDF Inspector worker could not be started: {exc}") from exc

    def _stop_locked(self) -> None:
        process, self.process = self.process, None
        if process is None:
            return
        try:
            if process.stdin:
                process.stdin.close()
        except OSError:
            pass
        try:
            if process.stdout:
                process.stdout.close()
        except OSError:
            pass
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)

    def close(self) -> None:
        with self.lock:
            self._stop_locked()

    def convert(self, source: Path, out: Path, progress) -> dict:
        progress(0, 1, "processing")
        request = json.dumps({"inputPath": str(source), "outputPath": str(out)}) + "\n"
        result: dict | None = None
        with self.lock:
            for attempt in range(2):
                try:
                    self._start_locked()
                    assert self.process is not None
                    assert self.process.stdin is not None and self.process.stdout is not None
                    self.process.stdin.write(request)
                    self.process.stdin.flush()
                    line = self.process.stdout.readline()
                    if not line:
                        raise OSError("the worker exited before returning a result")
                    result = json.loads(line)
                    if not isinstance(result, dict):
                        raise OSError("the worker returned an invalid result")
                    break
                except (OSError, ValueError, json.JSONDecodeError) as exc:
                    self._stop_locked()
                    if attempt:
                        raise ValueError(f"PDF Inspector worker failed: {exc}") from exc
            if result is None:
                raise ValueError("PDF Inspector worker returned no result")
            if not result.get("ok", False):
                raise ValueError(str(result.get("error") or "PDF Inspector failed"))
            partial = Path(f"{out}.partial")
            try:
                if partial.is_file():
                    os.replace(partial, out)
                elif not out.is_file():
                    raise ValueError("PDF Inspector produced no Markdown output")
            except OSError as exc:
                _discard_partial(partial)
                raise ValueError(f"PDF Inspector could not commit Markdown output: {exc}") from exc
        progress(1, 1, "writing")
        return result

_PDF_MD_WORKER: PdfMarkdownWorker | None = None

_PDF_MD_WORKER_CONFIG: tuple[str, str] | None = None

def _get_pdf_md_worker() -> PdfMarkdownWorker:
    global _PDF_MD_WORKER, _PDF_MD_WORKER_CONFIG
    runtime = os.environ.get("ONETOOL_NODE_RUNTIME") or shutil.which("node")
    runner = os.environ.get("ONETOOL_PDF_MD_RUNNER")
    if not runner:
        runner = str(Path(__file__).resolve().parent / "pdf_to_md.cjs")
    if not runtime:
        raise ValueError("PDF Inspector needs the Node.js runtime")
    config = (runtime, runner)
    if _PDF_MD_WORKER is None or _PDF_MD_WORKER_CONFIG != config:
        if _PDF_MD_WORKER is not None:
            _PDF_MD_WORKER.close()
        _PDF_MD_WORKER = PdfMarkdownWorker(runtime, Path(runner))
        _PDF_MD_WORKER_CONFIG = config
    return _PDF_MD_WORKER

def _close_pdf_md_worker() -> None:
    if _PDF_MD_WORKER is not None:
        _PDF_MD_WORKER.close()

atexit.register(_close_pdf_md_worker)

def pdf_to_md_convert(source: Path, out: Path, opts: dict, progress) -> int:
    _get_pdf_md_worker().convert(source, out, progress)
    return 1

def docx_to_pdf_convert(source: Path, out: Path, opts: dict, progress) -> int:
    return libreoffice_convert(source, out, "pdf", progress)

def libreoffice_convert(source: Path, out: Path, target_format: str, progress) -> int:
    progress(0, 0)
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="onetool-doc-") as tmp:
        run(
            [
                which("soffice", "libreoffice"), "--headless",
                f"-env:UserInstallation={(Path(tmp) / 'profile').resolve().as_uri()}",
                "--convert-to", target_format, "--outdir", tmp, str(source),
            ],
            "LibreOffice",
        )
        produced = Path(tmp) / f"{source.stem}{out.suffix}"
        if not produced.is_file():
            produced = next(Path(tmp).glob(f"*{out.suffix}"), None)
        if produced is None:
            raise ValueError(f"LibreOffice produced no {out.suffix.lstrip('.').upper()} file")
        shutil.move(str(produced), out)
    progress(1, 1)
    return 1

def docx_to_epub_convert(source: Path, out: Path, opts: dict, progress) -> int:
    # `EPUB` is LibreOffice Writer's explicit export filter.  Naming it avoids
    # LibreOffice selecting a module-specific default for non-DOCX Writer files.
    return libreoffice_convert(source, out, "epub:EPUB", progress)

def docx_to_txt_convert(source: Path, out: Path, opts: dict, progress) -> int:
    return libreoffice_convert(source, out, "txt:Text", progress)

def calibre_convert(source: Path, out: Path, opts: dict, progress) -> int:
    progress(0, 0)
    out.parent.mkdir(parents=True, exist_ok=True)
    run([which("ebook-convert"), str(source), str(out)], "Calibre")
    if not out.is_file() or out.stat().st_size == 0:
        raise ValueError("Calibre produced no output file")
    progress(1, 1)
    return 1

__all__ = ['pdf_to_txt_convert', 'PdfMarkdownWorker', '_PDF_MD_WORKER', '_PDF_MD_WORKER_CONFIG', '_get_pdf_md_worker', '_close_pdf_md_worker', 'pdf_to_md_convert', 'docx_to_pdf_convert', 'libreoffice_convert', 'docx_to_epub_convert', 'docx_to_txt_convert', 'calibre_convert']

atexit.register(_close_pdf_md_worker)
