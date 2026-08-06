# Making Creator and Editor real

Both screens are complete as interfaces and hold their state honestly. Neither
writes a file. This is what it takes to change that, grounded in what the repo
and this machine actually have.

## What already exists

| Piece | State |
| --- | --- |
| Job queue, worker threads, progress ticks, cancel | `converter/server.py` — works |
| Converter registry, helper detection, routing by extension | `converter/registry.py`, `formats.py` — works |
| History store, rename, requeue, reveal | works |
| Settings persistence on disk | `DEFAULT_SETTINGS` in `server.py` — works, currently unused by the UI |
| Helpers on this machine | 7-Zip, ImageMagick, Poppler, ffmpeg, LibreOffice, Pandoc, Calibre, LibRaw — all found |
| Python PDF libraries | **none installed**; only Pillow |

The gap is not infrastructure. It is that `Job` is one source → one output, and
that nothing in the codebase can open a PDF's page tree.

---

## Creator — the smaller job

Creator is a many-to-one conversion. The queue already does one-to-one with
progress, cancel, history and helper gating. Most of the work is widening the
job, not building a second engine.

### 1. Let a job take many sources

`Job` holds a single `source: Path`. Add `sources: list[Path]`, keep `source` as
`sources[0]` so every existing call site and the whole Convert view keep working
untouched. The worker signature grows one argument; the registry's existing
`convert(job, tick)` contract stays.

### 2. One new route

```
POST /api/create
  {format, items: [paths], name, dest, options}
  → {id}          # then the existing /api/state polling reports it
```

It builds a Job like `/api/convert` does, so progress, cancel, errors, the toast
and the history entry all come free.

### 3. Builders per container

Only three are real work; the rest are the standard library or a helper already
on disk.

| Container | How | New dependency |
| --- | --- | --- |
| ZIP, CBZ | `zipfile` | none |
| TGZ | `tarfile` | none |
| 7z, CB7, CBR | `7z` helper, already detected | none |
| EPUB | `converter/cbz_to_epub.py` already writes fixed-layout EPUB — feed it the staged image list | none |
| PDF | `magick` (present) or `img2pdf` | optional |
| Multi-TIFF | `magick` | none |
| DjVu, ISO | no route on this machine | drop them from the picker, or leave them badged `Unavailable`, which the UI already renders |

Each becomes a `Converter` record in `formats.py` with `src="items"`, so
`state()`, helper badges and the missing-helper block work with no new
mechanism. The Creator's `needs` field then comes from the registry instead of
being hard-coded in `creator-state.js`.

### 4. Item probing

Rows show `—` for page counts because nothing has opened the files. `Converter`
already has a `probe` hook. A probe pass on add fills page counts for archives
(`zipfile` entry count), images (1), and PDFs (needs the Editor's dependency, so
it can come later or stay blank).

### 5. Recipes on disk

Recipes live in memory. Write them to the existing settings JSON store next to
the output-folder preference. Small, self-contained, no new plumbing.

**Estimate:** 2–3 days. The widening of `Job` is the only invasive change, and it
is additive.

---

## Editor — the larger job

Nothing behind it exists, and the missing half is not page operations but
**rendering**. A page editor that cannot show a page is not an editor.

### The dependency decision, first

This is the decision that shapes everything after it. Three ways:

**A. PyMuPDF (`fitz`)** — one dependency covers rendering, rotate, delete,
insert, reorder, extract, merge, text extraction, and genuine redaction
(`add_redact_annot` then `apply_redactions`, which removes the content rather
than covering it).
*Caveat:* AGPL, or a paid commercial licence. For a local-only tool that is
usually fine, but it is a real decision and yours to make, not mine.

**B. pikepdf + Poppler** — `pikepdf` (qpdf, MPL-2.0) for the page tree,
`pdftoppm` (already installed) for rendering. Permissive licensing. Costs a
subprocess per thumbnail and gives no true redaction — you would be compositing
a black box and re-rasterising the page, which loses text everywhere.

**C. No new Python dependency** — qpdf and Poppler CLIs only. Every operation is
a subprocess and a temp file. Workable, slowest, and redaction is off the table.

**Recommendation: A**, unless the AGPL is a problem, in which case B and drop
redaction to "cover and flatten" with the UI saying exactly that.

### The rest, assuming A

**1. Open a document**

```
POST /api/editor/open  {path} → {id, name, pages:[{index, w, h, rot, hasText, size}]}
```

Held server-side by id. The Editor stops inventing `makePages()`.

**2. Render pages**

```
GET /api/editor/page?id&index&w   → PNG, cached on disk by (id, index, rot, w)
```

Thumbnails at grid width, one larger render for the reader. The renderer already
serves static files, so this is a content-type and a cache directory. The `.pg`
placeholder rules stay as the loading state — they become the skeleton rather
than the content.

**3. Apply edits**

The UI already holds unsaved operations locally and lists them in the Edits
panel. Formalise that list as the wire format:

```
POST /api/editor/save
  {id, ops:[{op:'rotate', pages:[…], deg}, {op:'delete', pages:[…]},
            {op:'insert', at, kind:'blank'}, {op:'reorder', order:[…]},
            {op:'redact', page, rects:[…]}],
   target:'inplace'|'copy', path}
```

Applied in order to a `fitz.Document`, written once. One route, one save, and
`Revert` becomes "drop the op list", which is what it already does client-side.

**4. Extract and pair mode**

`POST /api/editor/extract {id, pages, path}` writes a new PDF. Pair mode is two
open documents plus a `move`/`copy` op with a source id — no new concepts.

**5. Whole-document actions**

- OCR — `tesseract` is not installed; keep the existing `Needs Tesseract` badge
  and wire it to the helper installer that already works in Settings.
- Compress — Ghostscript is not installed either. Same treatment, or ImageMagick
  re-encoding at a chosen DPI.
- Page numbers — PyMuPDF can draw them directly.

The honest note: today the inspector shows `402 MB`, `168 × 258 mm` and `−38%`
as fixed strings. Every one of those must come from the opened document or be
removed. That is the last step, and it is the one that makes the screen true.

**Estimate:** 1 day for open + render, 2 days for the op pipeline, 1 day for
pair mode and extract, 1 day for whole-document actions and replacing the fixed
strings. Roughly a week, with the licence decision made first.

---

## Order I would do it in

1. **Decide the PDF dependency.** Everything in the Editor waits on it.
2. **Creator's `Job` widening + `/api/create` + ZIP/CBZ/TGZ/7z.** Ships a
   working Creator for the containers that need nothing new.
3. **Creator's PDF/EPUB/TIFF builders.** Uses helpers already on disk.
4. **Editor open + render.** The point where the Editor stops being a mock.
5. **Editor op pipeline + save.** The point where it becomes useful.
6. **Pair mode, extract, whole-document actions, real document facts.**

Steps 2 and 3 are independent of the licence decision and can start today.
