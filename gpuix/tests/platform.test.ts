import { expect, test } from "bun:test"
import { bootHint, diagnose, gpuApi, pythonCommand } from "../src/platform"

test("paint API is DirectX on Windows and Vulkan on Linux", () => {
  expect(gpuApi("win32")).toBe("directx")
  expect(gpuApi("linux")).toBe("vulkan")
  expect(gpuApi("darwin")).toBe("metal")
})

test("python binary follows the host OS unless CBZ_PYTHON is set", () => {
  const previous = process.env.CBZ_PYTHON
  delete process.env.CBZ_PYTHON
  try {
    if (process.platform === "win32") expect(["python", "py"]).toContain(pythonCommand())
    else expect(pythonCommand()).toBe("python3")
  } finally {
    if (previous === undefined) delete process.env.CBZ_PYTHON
    else process.env.CBZ_PYTHON = previous
  }
})

test("CBZ_PYTHON overrides the interpreter on every OS", () => {
  const previous = process.env.CBZ_PYTHON
  process.env.CBZ_PYTHON = "C:\\Python\\python.exe"
  try {
    expect(pythonCommand()).toBe("C:\\Python\\python.exe")
  } finally {
    if (previous === undefined) delete process.env.CBZ_PYTHON
    else process.env.CBZ_PYTHON = previous
  }
})

test("bootHint names the host paint API and keeps the other OS path", () => {
  const hint = bootHint(new Error("native sidecar failed"))
  expect(hint).toContain("GPU API:")
  expect(hint).toContain("converter/server.py")
  if (process.platform === "linux") {
    expect(hint).toContain("vulkan")
    expect(hint).toContain("Ubuntu 24.04")
    expect(hint).toContain("ubuntu-24.04-deps.sh")
  } else if (process.platform === "win32") {
    expect(hint).toContain("directx")
    expect(hint).toContain("Electron NSIS")
    expect(hint).toContain("bun run dev")
  }
})

test("diagnose reports this host without dropping Windows or Ubuntu fields", () => {
  const report = diagnose()
  expect(["metal", "directx", "vulkan"]).toContain(report.gpuApi)
  expect(typeof report.ubuntu24).toBe("boolean")
  expect(typeof report.vulkanLoader).toBe("boolean")
  expect(typeof report.vulkanIcd).toBe("boolean")
  expect(report.notes.length).toBeGreaterThan(0)
  if (process.platform === "linux") {
    expect(report.gpuApi).toBe("vulkan")
    expect(report.notes.some((note) => note.includes("Ubuntu 24.04"))).toBe(true)
  }
  if (process.platform === "win32") {
    expect(report.gpuApi).toBe("directx")
    expect(report.notes.some((note) => /Electron|NSIS/.test(note))).toBe(true)
  }
})
