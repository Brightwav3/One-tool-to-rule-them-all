#!/usr/bin/env bun
/** Compile the GPUIX client on the OS you ship. The native sidecar cannot be cross-compiled. */

import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"

const kind = process.argv[2]
if (kind !== "linux" && kind !== "windows") {
  console.error("Usage: bun scripts/build-native.ts linux|windows")
  process.exit(1)
}

if (kind === "linux" && process.platform !== "linux") {
  console.error("Linux AppImage must be compiled on Ubuntu 24.04 LTS.")
  console.error("The GPUI native sidecar cannot be cross-compiled.")
  process.exit(1)
}

if (kind === "windows" && process.platform !== "win32") {
  console.error("Windows NSIS must be compiled on Windows (DirectX).")
  console.error("The GPUI native sidecar cannot be cross-compiled.")
  console.error("Existing Electron users still ship from app/: npm run dist")
  process.exit(1)
}

mkdirSync("dist", { recursive: true })
const outfile = kind === "windows" ? "dist/one-tool.exe" : "dist/one-tool-linux"
const result = spawnSync(process.execPath, ["build", "--compile", "app.tsx", "--outfile", outfile], {
  stdio: "inherit",
})
process.exit(result.status ?? 1)
