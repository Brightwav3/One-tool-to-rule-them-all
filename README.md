<div align="center">

# One tool to rule them all

**Files in. The format you actually wanted out. Nothing leaves your machine.**

[Download the Windows installer](https://github.com/Brightwav3/One-tool-to-rule-them-all/releases/download/v2.0.1/OneTool-Web-Setup-2.0.1.exe)

One Tool is a local-first Electron app and conversion backend. The desktop UI, queue, history, JSON API,
conversion engines, and agent-facing command-line tools all run on your machine. No cloud service is
required and files are never uploaded.

</div>

---

## Install

The app needs **Python 3.10 or newer**, **Node.js 18 or newer**, and **npm**. Python dependencies are
standard-library only.

Install the Electron dependencies:

```bash
cd app
npm install
cd ..
```

PDF → Markdown additionally needs **Node 18+** and the optional worker dependency:

```bash
cd converter
npm install
cd ..
```

---

## Why

Every file conversion sends you somewhere different: a sketchy upload site for HEIC photos, a 200 MB
Java app for comics, a command-line incantation for PDFs that you look up every single time. All of
them want your files on their server.

This is one window that does all of it, on your machine, and tells you the truth about what it can do.

## What it converts

Twenty-four conversions are declared. **Twenty-two are implemented**; two are named for later so you can
see where it is going.

| | Conversion | Needs |
| --- | --- | --- |
| **Comics** | CBZ → EPUB | *nothing* |
| | CBR → EPUB | 7-Zip |
| | CBZ → PDF | Python standard library; ImageMagick fallback |
| | CBR → PDF | 7-Zip + Python standard library; ImageMagick fallback |
| | PDF → CBZ | Python standard library for safe JPEG extraction; Poppler fallback |
| **Images** | HEIC → JPG | ffmpeg |
| | PNG → WebP | ffmpeg |
| | PNG → PDF | Python standard library; ImageMagick fallback |
| | JPG → PDF | Python standard library; ImageMagick fallback |
| | SVG → PNG | ImageMagick |
| | RAW → DNG | *not built yet* |
| **Documents** | DOCX → PDF | LibreOffice |
| | DOCX/ODT → EPUB | LibreOffice |
| | DOCX/ODT → TXT | LibreOffice |
| | PDF → TXT | Poppler |
| | PDF -> Markdown | Firecrawl pdf-inspector, optional Node.js worker |
| | MD → PDF | *not built yet* |
| **Ebooks** | EPUB → CBZ | *nothing* |
| | EPUB → MOBI | Calibre |
| | EPUB → PDF | Python standard library for image-only EPUBs; Calibre fallback |
| | AZW3 → EPUB | Calibre |
| **Archives** | RAR → ZIP | 7-Zip |
| | 7z → ZIP | 7-Zip |
| **Video** | MOV → MP4 | ffmpeg |

### Dependency matrix

This detailed matrix is the authoritative dependency list; it also includes the local PDF -> Markdown converter.

For PDF -> Markdown, the bundled Firecrawl `pdf-inspector` was selected from its published 200-PDF benchmark:
0.875 overall quality, 0.915 reading-order accuracy, 0.814 table accuracy and 0.470 seconds per document
with OCR disabled. These are the project's own benchmark results, so scanned PDFs still need OCR.

See the [pdf-inspector benchmark](https://github.com/firecrawl/pdf-inspector#benchmark) for the corpus and methodology.

| Conversion | Runtime dependency |
| --- | --- |
| CBZ -> EPUB | Python standard library |
| CBR -> EPUB | 7-Zip + Python standard library |
| CBZ -> PDF | Python standard library; ImageMagick for PNG/other raster pages |
| CBR -> PDF | 7-Zip + Python standard library; ImageMagick for PNG/other raster pages |
| PDF -> CBZ | Python standard library for safe JPEG extraction; Poppler fallback |
| HEIC -> JPG | ffmpeg or ImageMagick |
| PNG -> WebP | ffmpeg or ImageMagick |
| PNG -> PDF | Python standard library; ImageMagick fallback |
| JPG -> PDF | Python standard library; ImageMagick fallback |
| SVG -> PNG | ImageMagick |
| RAW -> DNG | Future: LibRaw or Exiv2 |
| DOCX -> PDF | LibreOffice |
| DOCX/ODT -> EPUB | LibreOffice Writer EPUB export |
| DOCX/ODT -> TXT | LibreOffice |
| PDF -> TXT | Poppler + Python standard library |
| PDF -> MD | Node.js + Firecrawl pdf-inspector |
| MD -> PDF | Future: Pandoc + a PDF renderer |
| EPUB -> CBZ | Python standard library |
| EPUB -> MOBI | Calibre ebook-convert |
| EPUB -> PDF | Python standard library for image-only EPUBs; Calibre fallback |
| AZW3 -> EPUB | Calibre ebook-convert |
| RAR -> ZIP | 7-Zip + Python standard library |
| 7Z -> ZIP | 7-Zip + Python standard library |
| MOV -> MP4 | ffmpeg |

The backend never downloads or executes helper installers. Install missing helpers separately, set the
documented `ONETOOL_<HELPER>` override when needed, and call the `recheck` API or agent command.

On Windows, every helper uses the same resolver: PATH, standard `Program Files` and per-user folders,
WinGet/Scoop/Chocolatey locations, and its explicit `ONETOOL_<HELPER>` override. If an installer changed
PATH, restart the backend before checking again. Overrides include `ONETOOL_7Z`,
`ONETOOL_POPPLER`, `ONETOOL_FFMPEG`, `ONETOOL_IMAGEMAGICK`, `ONETOOL_LIBREOFFICE`,
`ONETOOL_CALIBRE`, `ONETOOL_RAW_TOOL`, `ONETOOL_PANDOC`, and `ONETOOL_PDF_RENDERER`.
The override may point to the executable or to the folder containing it; downloading an installer alone
does not count as an installed helper until it has been installed or extracted.

### The app never lies about what it can do

Most converters let you queue a job and *then* fail. This one computes each conversion's state from
what's actually installed on your machine, every time you look:

- **Ready** — works right now.
- **Needs a helper** — the conversion is built, but an external program is missing. The app names it,
  gives you the exact install command **for your platform**, and re-checks on request.
- **Soon** — declared but not implemented, and clearly marked as such.

A conversion you can't run is never offered as though you can. Helpers are free, standard tools you may
well already have; they stay on your machine and are only launched for that conversion.

## What you get

| | |
| --- | --- |
| **Mixed queue** | Queue a CBZ, three HEICs and a PDF in one request. Each is routed by extension and labelled with where it went. |
| **Live progress** | Page-by-page where the format allows it, not a spinner that lies to you. |
| **Per-file options** | Title and creator for comics, quality and max edge for photos, DPI for PDFs — whatever that converter declares. |
| **Honest errors** | A bad file gets its own message on its own card. The queue keeps going. |
| **Streaming** | A 400 MB archive never sits in RAM. Pages are copied one at a time. |
| **Session history** | Every run, with an API operation to put its files back in the queue. |
| **Truly offline** | The backend binds to `127.0.0.1`. Nothing is uploaded to a remote service, tracked, or phoned home. |

Comic pages sort naturally, so `page2.jpg` lands before `page10.jpg` — the way you'd expect and the way
most tools get wrong. Unsafe archive paths are rejected outright.

## Quick start

### Desktop app

```bash
cd app
npm start
```

The Electron shell starts the local backend automatically. The app stores conversion history and
settings locally.

### The backend API

```bash
python converter/server.py
```

The server listens on `http://127.0.0.1:8756` and exposes JSON endpoints only. It never opens a browser.

### The command line

The comics converter is also a standalone script with no dependencies at all:

```bash
python converter/cbz_to_epub.py "My Comic v01.cbz"
```

```bash
python converter/cbz_to_epub.py "My Comic v01.cbz" out.epub --title "My Comic, Vol. 1" --creator "A. N. Author"
```

Exit code `0` on success, `1` on failure — so it drops straight into a script.

### Agent tools

Agents can use the same local queue through `converter/agent_tools.py`. It returns one JSON document
per command and never uploads files. Use `--start` when the backend is not already running; it starts
a private localhost backend for that command and shuts it down afterward.

```bash
# Machine-readable converter capabilities and readiness
python converter/agent_tools.py --start tools

# Convert one or more files and wait for final results
python converter/agent_tools.py --start convert input.pdf --converter pdf-md --output-dir out

# Set converter options declared by the selected converter
python converter/agent_tools.py --start convert comic.cbz --converter cbz-epub \
  --option title="My Comic" --option creator="A. N. Author"

# For multiple commands, keep the local backend running in another terminal
python converter/server.py --port 8756
python converter/agent_tools.py convert input.png --converter png-webp --no-wait
python converter/agent_tools.py wait 1
```

To use an already-running backend, pass its URL or set `ONETOOL_URL`:

```bash
python converter/agent_tools.py --url http://127.0.0.1:8756 status
```

The available operations are `tools`, `status`, `convert`, `wait`, `recheck`, and `specs`.
`specs` prints JSON tool definitions suitable for an agent runtime. Converter IDs and option keys
come from the live registry, so agents can inspect readiness before starting work.

Agent conversions use the same fast comic PDF path as the backend: JPEG pages are embedded
directly from the archive, compatible PNG pages use FlateDecode embedding, and WebP, GIF, AVIF or
unsupported PNG pages use the ImageMagick fallback one page at a time.

## How it's put together

```
converter/
  registry.py          the converter model — state is computed, never asserted
  formats.py           every conversion the backend knows about
  cbz_to_epub.py       the comics converter — pure stdlib, importable, scriptable
  server.py            local JSON HTTP API, job queue
  agent_tools.py       structured JSON command-line tools for local agents
  pdf_to_md.cjs        optional Node worker for PDF → Markdown
  package.json         optional Node runtime dependency manifest
app/
  main.js              Electron main process and window shell
  preload.js           restricted renderer bridge
  package.json         Electron and packaging configuration
```

**Adding a format is one entry in `formats.py`.** The registry, queue, API, and agent tools consume the
same converter model. Every backend layer works without a UI.

## Under the hood

- **Conversions stream.** Pages are copied archive-to-archive a megabyte at a time with a
  `progress(done, total)` callback. Memory stays flat regardless of file size.
- **Comic PDFs have a fast path.** JPEG pages are read one at a time and embedded into the PDF without
  decoding or recompression. Compatible non-interlaced PNG pages use PDF FlateDecode embedding with
  alpha masks where needed. WebP, GIF, AVIF and incompatible PNG pages fall back to ImageMagick one
  page at a time, keeping the command line bounded and the backend responsive.
- **Scan PDFs have a safe extraction path.** Classic-xref PDFs with one validated DCTDecode JPEG per
  image-only page copy those JPEG streams directly into a CBZ in page-tree order. Malformed offsets,
  unsupported filters, mixed-content pages and invalid JPEGs fall back to bounded Poppler rasterization.
- **PDF Markdown uses one persistent worker.** Batch jobs reuse a serialized Node/pdf-inspector process;
  a crashed worker is restarted once and each output is committed atomically.
- **Inputs are explicit.** Clients pass local paths through `/api/add-path` or stream bytes through
  `/api/upload`; the backend never needs a graphical picker.

## Requirements

- **Python 3.10 or newer** — the backend itself has no third-party Python packages, ever
- **Node 18+** — Electron and the optional PDF → Markdown worker
- Optional helpers, only for the conversions that name them: 7-Zip, Poppler, ffmpeg, ImageMagick,
  LibreOffice, and Calibre

## Roadmap

- [x] A converter registry — formats declare themselves, the API follows
- [x] Mixed queues with automatic routing
- [x] Helper detection with per-platform install instructions
- [ ] The two remaining declared conversions (RAW → DNG and MD → PDF)

## License

MIT — see [LICENSE](LICENSE).
