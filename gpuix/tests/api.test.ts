import { afterAll, expect, test } from "bun:test"
import { LIGHT, DARK, TYPE, SPACE, RADIUS, themeOf } from "../src/theme"
import { ConverterApi } from "../src/api"
import { startBackend, type BackendHandle } from "../src/backend"

test("live prototype palette is the token module", () => {
  expect(LIGHT.acc).toBe("#0b6bcb")
  expect(LIGHT.bg).toBe("#f2f2f4")
  expect(LIGHT.t1).toBe("#1d1d1f")
  expect(DARK.acc).toBe("#006efe")
  expect(DARK.bg).toBe("#000000")
  expect(DARK.t1).toBe("#ededed")
  expect(themeOf("dark")).toBe(DARK)
})

test("one type scale and 4px grid, not three CSS dialects", () => {
  expect(TYPE).toEqual({ xs: 11, sm: 12, md: 13, title: 17, display: 25 })
  expect(SPACE[1]).toBe(4)
  expect(SPACE[2]).toBe(8)
  expect(RADIUS.control).toBe(8)
  expect(RADIUS.card).toBe(14)
  expect(LIGHT.type).toBe(TYPE)
  expect(DARK.type).toBe(TYPE)
})

let backend: BackendHandle | undefined

test("client API reaches converter/server.py", async () => {
  backend = await startBackend()
  const api = new ConverterApi(backend.url)
  const tools = await api.tools()
  const state = await api.state()
  expect(Array.isArray(tools.tools)).toBe(true)
  expect(tools.tools.length).toBeGreaterThan(10)
  expect(Array.isArray(state.files)).toBe(true)
  expect(backend.url.startsWith("http://127.0.0.1:")).toBe(true)
}, 20000)

afterAll(() => {
  backend?.stop()
})
