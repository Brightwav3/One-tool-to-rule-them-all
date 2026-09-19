"""Public conversion API. Implementations live in focused format modules."""
from __future__ import annotations

import types as _types

import formats_common as _common
import formats_pdf_writer as _pdf_writer
import formats_pdf_extract as _pdf_extract
import formats_pdf_convert as _pdf_convert
import formats_documents as _documents
import formats_comics as _comics
import formats_archives as _archives
import formats_creator as _creator
import formats_images as _images
import formats_registry as _registry

_FORMAT_MODULES = (
    _common, _pdf_writer, _pdf_extract, _pdf_convert, _documents,
    _comics, _archives, _creator, _images, _registry,
)

for _module in _FORMAT_MODULES:
    for _name in _module.__all__:
        globals()[_name] = getattr(_module, _name)

__all__ = list(dict.fromkeys(
    name for module in _FORMAT_MODULES for name in module.__all__
))


class _FormatCompatibilityModule(_types.ModuleType):
    """Keep legacy monkeypatches on ``formats`` visible to split modules."""

    def __setattr__(self, name, value):
        super().__setattr__(name, value)
        if name in __all__:
            for module in _FORMAT_MODULES:
                if name in vars(module):
                    setattr(module, name, value)


_types.ModuleType.__setattr__(__import__(__name__), '__class__', _FormatCompatibilityModule)
