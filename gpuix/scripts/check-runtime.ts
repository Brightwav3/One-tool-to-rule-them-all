#!/usr/bin/env bun
/** Print whether this machine can run the GPUIX client. */

import { diagnose } from "../src/platform"

const report = diagnose()
console.log(JSON.stringify(report, null, 2))

if (!report.bun) {
  console.error("Install Bun: https://bun.sh (Windows and Ubuntu 24.04).")
  process.exitCode = 1
}
if (report.gpuApi === "directx") {
  console.error("Windows DirectX path. Electron NSIS in app/ is unchanged: cd app && npm start")
}
if (report.gpuApi === "vulkan" && (!report.vulkanLoader || !report.vulkanIcd)) {
  console.error("Ubuntu 24.04: sudo bash gpuix/scripts/ubuntu-24.04-deps.sh")
  process.exitCode = 1
}
if (!report.display && report.gpuApi === "vulkan") {
  console.error("No graphical session (DISPLAY / WAYLAND_DISPLAY).")
  process.exitCode = 1
}
