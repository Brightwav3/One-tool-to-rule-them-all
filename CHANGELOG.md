# Changelog

## 2.2.1 — 2026-09-19

### Added

- MOBI to EPUB and PDF conversions through the local Calibre helper.

### Fixed

- CBZ to PDF now honors the selected DPI and embeds compatible JPEG and PNG pages directly.
- CBZ to PDF requests ImageMagick only when the archive needs it for GIF, WebP, or AVIF pages.
- The Settings tooltip now opens inward from the left edge of the window instead of clipping its label.

### Changed

- Split conversion implementations into focused modules while keeping `formats.py` as a compatibility facade.
- Temporarily hide the PDF Editor from the main navigation while its code remains in the repository.
