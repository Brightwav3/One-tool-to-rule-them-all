# Vendored third-party code

## FreeDF (import package `pdfengine`)

| | |
| --- | --- |
| Distribution | `freedf` |
| Version | `0.2.0` |
| Import package | `pdfengine` |
| Source repo | `Brightwav3/custom-pdf-engine` |
| Branch | `feat/v0.2-integration` |
| Commit | `2a48e49` |
| Licence | MIT |

The distribution name and the import package name differ on purpose. `freedf`
is what the wheel is called; `pdfengine` is what you `import`. Upstream's
`pyproject.toml` documents the split and `docs/CONTRACT-CHANGELOG.md` records
the deferred rename. Do not "fix" either name here.

### Why the tree is unpacked rather than a `.whl`

`app/main.js` spawns the user's **system Python** — there is no bundled
interpreter, no virtualenv, and no install step anywhere in the packaged app, so
a wheel sitting in `converter/` would never be installed. electron-builder
copies `../converter` verbatim, so the package ships as a plain directory that
`converter/pdf_engine.py` puts on `sys.path`.

Zipimporting the wheel would also break `pdfengine.api.contracts.schema_bytes()`,
which resolves `SCHEMA_DIR` from `__file__` and calls `Path.read_bytes()`.

### How to refresh

```bash
cd "/c/Users/Sajmon/pdf engine/pdf-engine" && python -m pip wheel . -w /tmp/freedf-wheel --no-deps
```

```bash
cd "C:/Users/Sajmon/pdf  tool" && mkdir -p converter/vendor && python -c "
import glob, zipfile, pathlib, shutil
whl = glob.glob('/tmp/freedf-wheel/freedf-*.whl')[0]
dest = pathlib.Path('converter/vendor')
shutil.rmtree(dest / 'pdfengine', ignore_errors=True)
with zipfile.ZipFile(whl) as z:
    z.extractall(dest, [n for n in z.namelist() if n.startswith('pdfengine/')])
print('unpacked', whl)
"
```

Then update the version and commit in the table above and run
`python -m unittest tests.test_vendoring`.
