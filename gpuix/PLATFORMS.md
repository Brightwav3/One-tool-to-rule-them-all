# GPUIX platforms

The GPUIX client is a **second window** over the same Python backend. It does not
retire Electron. Paint APIs:

| OS | GPU API | Users |
| --- | --- | --- |
| Windows 10/11 | DirectX (GPUI / wgpu) | Existing One Tool installs |
| Ubuntu 24.04 LTS (Noble) | Vulkan | Linux first-class target |
| macOS | Metal | Works if you have Bun; not the shipping SKU |

Cross-compiling the native sidecar is not supported. Compile and pack **on the OS you ship**
(`bun run build:windows` / `bun run pack:windows` on Windows, `bun run build:linux` /
`bun run pack:linux` on Ubuntu 24.04). Running the Linux script on Windows (or the reverse)
exits with an error instead of emitting a broken binary.

The Electron Windows product is unchanged: `cd app && npm start` and `npm run dist`
(NSIS web installer). Do not replace that with the GPUIX packager.

## Shared

- Python 3.10+ (`CBZ_PYTHON` overrides). On Windows the client looks for `python`; on Ubuntu, `python3`.
- [Bun](https://bun.sh)
- `converter/server.py` on `127.0.0.1` (spawned by the client, or `ONETOOL_URL`)

```bash
cd gpuix
bun install
bun run doctor
bun run dev
```

## Windows (DirectX)

Keeps the current product path. Do **not** replace `app/` electron-builder NSIS with this.

1. Install [Python 3.10+](https://www.python.org/downloads/windows/) and tick “Add python.exe to PATH”, or set `CBZ_PYTHON`.
2. Install Bun: `powershell -c "irm bun.sh/install.ps1 | iex"`
3. GPU driver with DirectX 12 (Windows Update or the vendor installer).
4. `cd gpuix && bun install && bun run dev`

Pack (on a Windows machine):

```bat
cd gpuix
bun run build:windows
cargo install cargo-packager --locked
cargo packager --release --config packager.windows.json
```

Output: NSIS setup under `gpuix/bundle/`. This is the **GPUIX** installer, separate from
`app/` `OneTool-Web-Setup-*.exe`.

Electron remains: `cd app && npm start` / `npm run dist`.

## Ubuntu 24.04 LTS (Vulkan)

```bash
sudo bash gpuix/scripts/ubuntu-24.04-deps.sh
# bun: curl -fsSL https://bun.sh/install | bash
cd gpuix
bun install
bun run doctor
bun run dev
```

The deps script installs `libvulkan1`, `mesa-vulkan-drivers` (Intel/AMD/llvmpipe ICD),
Wayland/X11 loader libraries, and `python3`. NVIDIA: keep the proprietary driver; it
provides its own Vulkan ICD.

Confirm:

```bash
vulkaninfo --summary
echo "$XDG_SESSION_TYPE $WAYLAND_DISPLAY $DISPLAY"
```

Pack (on Ubuntu 24.04):

```bash
cd gpuix
bun run build:linux
cargo install cargo-packager --locked
cargo packager --release --config packager.linux.json
```

Output: AppImage under `gpuix/bundle/`.

## Environment

| Variable | Meaning |
| --- | --- |
| `ONETOOL_URL` | Use an already-running `server.py` instead of spawning one |
| `CBZ_PYTHON` | Python executable |
| `ONETOOL_CONVERTER` | Path to `converter/` |
| `GPUIX_BACKGROUND=1` | Open the window without stealing focus (ignored on Linux) |
