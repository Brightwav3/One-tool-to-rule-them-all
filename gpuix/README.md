# GPUIX client

React over Zed GPUI (`@gpuix/react`). Not Electron, not a DOM port.

The Python converter stays the local-first backend. This window spawns
`converter/server.py` on a free `127.0.0.1` port (same contract as `app/main.js`)
and talks to `/api/tools`, `/api/state`, add/convert/create/editor.

Lookalike of Convert, Creator, and Editor — palette, density, three workspaces.
Not a golden-trace pixel match of `converter/ui/`.

This client must run on **both**:

| OS | GPU API | Packaging |
| --- | --- | --- |
| Windows 10/11 | DirectX | GPUIX NSIS (`bun run pack:windows`) **and** the existing Electron installer in `app/` |
| Ubuntu 24.04 LTS | Vulkan | AppImage (`bun run pack:linux`) |

Ubuntu 24.04 is a Linux target, not a replacement for Windows. Deps, run, and
packaging for both: **[PLATFORMS.md](./PLATFORMS.md)**.

## Run

```bash
cd gpuix
bun install
bun run doctor
bun run dev
```

Windows (existing One Tool users): install Python 3.10+ on PATH and Bun, then the
same commands in `gpuix/`. Keep `cd app && npm start` / `npm run dist` for Electron.

Ubuntu 24.04 LTS:

```bash
sudo bash gpuix/scripts/ubuntu-24.04-deps.sh
cd gpuix && bun install && bun run doctor && bun run dev
```

Point at an already-running backend with `ONETOOL_URL=http://127.0.0.1:8756`.
Override the interpreter with `CBZ_PYTHON`.

```bash
bun test          # tokens, platforms, live /api/tools and /api/state
bun run typecheck
```

## Style (this client only)

Electron CSS cannot unify under golden-trace 1:1. This client does:

| Electron | GPUIX |
| --- | --- |
| 11 CSS files + cascade (`base.css` after `shell.css`) | One token module (`src/theme.ts`) |
| `.btn` ≠ `.pbtn` ≠ `.u-add`; `.sw` ≠ `.switch` | `Button` / `Chip` / `Switch` / `Field` with variants |
| ~15 font sizes | One scale: 11 / 12 / 13 / 17 / 25 |
| innerHTML string soup | React components, `style={{}}` |

Token values are the live prototype sheet from PR #2 (`#0b6bcb` light, dark `#000` /
`#006efe` / Geist). No CSS is imported from `converter/ui/`.

## Layout

```text
gpuix/
├── app.tsx                 window entry: spawn backend, render()
├── PLATFORMS.md            Windows DirectX + Ubuntu 24.04 Vulkan
├── packager.windows.json   GPUIX NSIS (does not replace app/ electron-builder)
├── packager.linux.json     AppImage
├── scripts/ubuntu-24.04-deps.sh
├── src/theme.ts            tokens
├── src/primitives.tsx      Button, Chip, Switch, Field, Check, Segment
├── src/platform.ts         DirectX / Vulkan / Metal + doctor
├── src/backend.ts          Python spawn (`python` on Windows, `python3` on Ubuntu)
├── src/api.ts              fetch /api/*
├── src/screens/            Convert, Creator, Editor
└── src/overlays/           palette, settings, toast
```
