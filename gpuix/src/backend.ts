import { spawn, type ChildProcess } from "node:child_process"
import { createConnection, createServer } from "node:net"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { pythonCommand } from "./platform"

export type BackendHandle = {
  url: string
  port: number
  stop: () => void
}

function converterRoot(): string {
  const override = process.env.ONETOOL_CONVERTER
  if (override) return resolve(override)
  return resolve(join(import.meta.dir, "..", "..", "converter"))
}

function pythonBin(): string {
  return pythonCommand()
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.unref()
    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("could not reserve a localhost port"))
        return
      }
      const { port } = address
      probe.close(() => resolvePort(port))
    })
  })
}

function waitForServer(port: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolveReady, reject) => {
    const attempt = () => {
      const socket = createConnection({ port, host: "127.0.0.1" })
      socket.once("connect", () => {
        socket.destroy()
        resolveReady()
      })
      socket.once("error", () => {
        socket.destroy()
        if (Date.now() > deadline) reject(new Error("the converter backend did not start"))
        else setTimeout(attempt, 120)
      })
    }
    attempt()
  })
}

export async function startBackend(): Promise<BackendHandle> {
  const existing = process.env.ONETOOL_URL
  if (existing) {
    const url = existing.replace(/\/$/, "")
    const port = Number(new URL(url).port || 8756)
    return { url, port, stop: () => {} }
  }

  const port = await freePort()
  const cwd = converterRoot()
  const history = join(homedir(), ".one-tool-gpuix-history.json")
  const settings = join(homedir(), ".one-tool-gpuix-settings.json")
  const pdfRunner = join(cwd, "pdf_to_md.cjs")

  const child: ChildProcess = spawn(pythonBin(), ["server.py", "--port", String(port), "--no-browser"], {
    cwd,
    env: {
      ...process.env,
      ONETOOL_NODE_RUNTIME: process.execPath,
      ONETOOL_PDF_MD_RUNNER: pdfRunner,
      ONETOOL_HISTORY_PATH: history,
      ONETOOL_SETTINGS_PATH: settings,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })

  child.stdout?.on("data", (chunk) => process.stdout.write(`[backend] ${chunk}`))
  child.stderr?.on("data", (chunk) => process.stderr.write(`[backend] ${chunk}`))
  child.on("exit", (code) => {
    if (code && code !== 0) console.error(`[backend] exited with code ${code}`)
  })

  try {
    await waitForServer(port)
  } catch (error) {
    child.kill()
    throw error
  }

  const stop = () => {
    if (child.exitCode == null) child.kill()
  }
  const g = globalThis as { __onetoolSignals?: boolean }
  if (!g.__onetoolSignals) {
    g.__onetoolSignals = true
    process.on("exit", stop)
    process.on("SIGINT", () => {
      stop()
      process.exit(0)
    })
    process.on("SIGTERM", () => {
      stop()
      process.exit(0)
    })
  }

  return { url: `http://127.0.0.1:${port}`, port, stop }
}
