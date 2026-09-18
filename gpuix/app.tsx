/**
 * One Tool GPUIX client.
 *
 * Windows (DirectX) and Ubuntu 24.04 LTS (Vulkan). Same Python backend as Electron.
 * Desktop: bun run doctor && bun run dev
 */

import { render } from "@gpuix/react"
import { App } from "./src/app"
import { ConverterApi } from "./src/api"
import { startBackend, type BackendHandle } from "./src/backend"
import { bootHint, diagnose } from "./src/platform"

type Host = { backend?: BackendHandle }

const host = (globalThis as Host)

async function boot() {
  const report = diagnose()
  for (const note of report.notes) console.log(`[one-tool] ${note}`)
  if (!host.backend) host.backend = await startBackend()
  const api = new ConverterApi(host.backend.url)
  try {
    render(<App api={api} />, {
      title: "One Tool",
      appName: "One Tool",
      width: 980,
      height: 700,
      minWidth: 900,
      minHeight: 600,
      titlebarTransparent: true,
      windowBackground: "opaque",
      trafficLightX: 14,
      trafficLightY: 14,
      appId: "dev.brightwav3.onetool",
      focus: typeof process === "undefined" || process.env.GPUIX_BACKGROUND !== "1",
    })
  } catch (error) {
    console.error(bootHint(error))
    throw error
  }
}

const isEntryPoint =
  typeof Bun !== "undefined"
    ? Bun.isStandaloneExecutable || Bun.main === import.meta.path
    : typeof window !== "undefined"

if (isEntryPoint) {
  boot().catch((error) => {
    console.error("[one-tool] failed to start")
    console.error(bootHint(error))
    process.exitCode = 1
  })
}
