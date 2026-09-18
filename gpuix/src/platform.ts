import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

export type GpuApi = "metal" | "directx" | "vulkan"

export type RuntimeReport = {
  os: NodeJS.Platform
  gpuApi: GpuApi
  ubuntu24: boolean
  python: string
  bun: boolean
  display: boolean
  vulkanLoader: boolean
  vulkanIcd: boolean
  notes: string[]
}

export function gpuApi(platform = process.platform): GpuApi {
  if (platform === "darwin") return "metal"
  if (platform === "win32") return "directx"
  return "vulkan"
}

export function isUbuntu24(): boolean {
  try {
    const text = readFileSync("/etc/os-release", "utf8")
    return /VERSION_CODENAME=noble/.test(text) || /VERSION_ID="24\.04"/.test(text)
  } catch {
    return false
  }
}

function which(bin: string): boolean {
  const dirs = (process.env.PATH || "").split(delimiter)
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  return dirs.some((dir) => exts.some((ext) => existsSync(join(dir, bin + ext))))
}

function vulkanLoaderPresent(): boolean {
  if (process.platform !== "linux") return process.platform === "win32" || process.platform === "darwin"
  const candidates = [
    "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
    "/usr/lib/aarch64-linux-gnu/libvulkan.so.1",
    "/lib/x86_64-linux-gnu/libvulkan.so.1",
    "/usr/lib/libvulkan.so.1",
  ]
  return candidates.some((path) => existsSync(path))
}

function vulkanIcdPresent(): boolean {
  if (process.platform !== "linux") return true
  const dirs = [
    "/usr/share/vulkan/icd.d",
    "/etc/vulkan/icd.d",
    join(homedir(), ".local/share/vulkan/icd.d"),
  ]
  return dirs.some((dir) => {
    try {
      return readdirSync(dir).some((name) => name.endsWith(".json"))
    } catch {
      return false
    }
  })
}

export function pythonCommand(): string {
  if (process.env.CBZ_PYTHON) return process.env.CBZ_PYTHON
  if (process.platform === "win32") return which("python") ? "python" : "py"
  return which("python3") ? "python3" : "python"
}

export function diagnose(): RuntimeReport {
  const api = gpuApi()
  const ubuntu24 = process.platform === "linux" && isUbuntu24()
  const python = pythonCommand()
  const notes: string[] = []

  if (api === "directx") {
    notes.push("Windows paints with DirectX via GPUI. A WDDM / DirectX 12 GPU driver is required.")
    notes.push("Existing Electron users keep `cd app && npm start` and the NSIS installer. This client is a second window, not a replacement.")
  }
  if (api === "vulkan") {
    notes.push("Linux paints with Vulkan via GPUI. Ubuntu 24.04 LTS (Noble) is the documented Linux target.")
    if (!ubuntu24) notes.push("This is not Ubuntu 24.04. Packages may still work; install libvulkan1 and a Vulkan ICD.")
  }
  if (api === "metal") notes.push("macOS paints with Metal via GPUI.")
  if (!which(python) && !process.env.CBZ_PYTHON) {
    notes.push(
      process.platform === "win32"
        ? "Python not on PATH. Install Python 3.10+, tick Add python.exe to PATH, or set CBZ_PYTHON."
        : "python3 not on PATH. Ubuntu 24.04: sudo bash gpuix/scripts/ubuntu-24.04-deps.sh",
    )
  }

  return {
    os: process.platform,
    gpuApi: api,
    ubuntu24,
    python,
    bun: typeof Bun !== "undefined" || which("bun"),
    display: Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY || process.platform === "win32" || process.platform === "darwin"),
    vulkanLoader: vulkanLoaderPresent(),
    vulkanIcd: vulkanIcdPresent(),
    notes,
  }
}

export function bootHint(error: unknown): string {
  const report = diagnose()
  const message = error instanceof Error ? error.message : String(error)
  const lines = [
    "GPUIX failed to open a native window.",
    message,
    "",
    `GPU API: ${report.gpuApi} (${report.os})`,
  ]
  if (report.gpuApi === "vulkan") {
    lines.push("Ubuntu 24.04 LTS: sudo bash gpuix/scripts/ubuntu-24.04-deps.sh")
    lines.push("That installs libvulkan1, mesa-vulkan-drivers, Wayland/X11 loader libs, and python3.")
    if (!report.vulkanLoader) lines.push("Missing libvulkan.so.1 — the Vulkan loader is not installed.")
    if (!report.vulkanIcd) lines.push("No Vulkan ICD in /usr/share/vulkan/icd.d. Install mesa-vulkan-drivers or an NVIDIA driver.")
    if (!report.display) lines.push("No DISPLAY or WAYLAND_DISPLAY. Log into a graphical session, or use a compositor.")
  }
  if (report.gpuApi === "directx") {
    lines.push("Windows: install Python 3.10+ (`python` on PATH, or set CBZ_PYTHON) and Bun.")
    lines.push("Update the GPU driver so DirectX 12 is available. Then: cd gpuix && bun install && bun run dev")
    lines.push("The Electron NSIS installer in app/ is unchanged and still ships the Windows product.")
  }
  lines.push("Python backend: converter/server.py on 127.0.0.1. Override with ONETOOL_URL or CBZ_PYTHON.")
  return lines.join("\n")
}
