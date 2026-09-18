import { useCallback, useEffect, useMemo, useState } from "react"
import { ConverterApi } from "./api"
import { isBlocked } from "./format"
import { Palette } from "./overlays/palette"
import { helpersFrom, Settings } from "./overlays/settings"
import { Toast } from "./overlays/toast"
import { Panel, RouteSheet } from "./panel"
import { ThemeProvider, col } from "./primitives"
import { ConvertScreen } from "./screens/convert"
import { CreatorScreen, groupsFrom } from "./screens/creator"
import { EditorScreen } from "./screens/editor"
import { Shell } from "./shell"
import { themeOf, type ThemeName } from "./theme"
import type { ConvertFilter, ConvertRow, ConvertSort, CreatorItem, EditorSession, HistoryRecord, PageId, QueueFile, Toast as ToastData, Tool } from "./types"

const SORT_CYCLE: ConvertSort[] = ["newest", "oldest", "name", "largest"]

export function App({ api }: { api: ConverterApi }) {
  const [themeName, setThemeName] = useState<ThemeName>("light")
  const theme = themeOf(themeName)
  const [page, setPage] = useState<PageId>("convert")
  const [tools, setTools] = useState<Tool[]>([])
  const [files, setFiles] = useState<QueueFile[]>([])
  const [history, setHistory] = useState<HistoryRecord[]>([])
  const [outputFolder, setOutputFolder] = useState<string | undefined>()
  const [connected, setConnected] = useState(false)
  const [filter, setFilter] = useState<ConvertFilter>("all")
  const [sort, setSort] = useState<ConvertSort>("newest")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedHistory, setSelectedHistory] = useState<string | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState("")
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState("general")
  const [autoStart, setAutoStart] = useState(false)
  const [toast, setToast] = useState<ToastData>(null)
  const [converting, setConverting] = useState(false)
  const [routeFor, setRouteFor] = useState<QueueFile | null>(null)
  const [creatorStage, setCreatorStage] = useState<"pick" | "build">("pick")
  const [creatorQuery, setCreatorQuery] = useState("")
  const [creatorFmt, setCreatorFmt] = useState("CBZ")
  const [creatorItems, setCreatorItems] = useState<CreatorItem[]>([])
  const [creating, setCreating] = useState(false)
  const [editor, setEditor] = useState<EditorSession | null>(null)
  const mac = typeof process !== "undefined" && process.platform === "darwin"

  const flash = useCallback((title: string, ok = true, sub?: string) => {
    setToast({ title, ok, sub })
    setTimeout(() => setToast(null), 2800)
  }, [])

  const absorb = useCallback((state: { files?: QueueFile[]; outputFolder?: string; tools?: Tool[] }) => {
    if (Array.isArray(state.files)) {
      setFiles(state.files)
      setSelectedId((current) => {
        if (current && state.files!.some((file) => file.id === current)) return current
        return state.files![0]?.id ?? null
      })
    }
    if (typeof state.outputFolder === "string" && state.outputFolder) setOutputFolder(state.outputFolder)
    if (Array.isArray(state.tools)) setTools(state.tools)
    setConnected(true)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [toolData, state, hist] = await Promise.all([api.tools(), api.state(), api.history().catch(() => ({ history: [] }))])
      setTools(toolData.tools || [])
      absorb(state)
      setHistory(Array.isArray(hist.history) ? hist.history : [])
    } catch (error) {
      setConnected(false)
      flash(error instanceof Error ? error.message : "Backend unreachable", false)
    }
  }, [absorb, api, flash])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      api.state().then(absorb).catch(() => setConnected(false))
    }, 700)
    return () => clearInterval(timer)
  }, [absorb, api, refresh])

  const selected = useMemo<ConvertRow | null>(() => {
    const file = files.find((item) => item.id === selectedId)
    if (file) {
      return { kind: "queue", id: file.id, file, name: file.name, from: file.from, to: file.to, state: file.status, cat: "", size: "", when: "" }
    }
    const record = history.find((item) => item.id === selectedHistory)
    if (record) {
      return { kind: "history", id: record.id, record, name: record.name, from: record.from, to: record.to, state: record.state || "done", cat: "", size: "", when: "" }
    }
    return null
  }, [files, history, selectedId, selectedHistory])

  const helperDot = tools.some((tool) => tool.state === "helper")
  const helpers = helpersFrom(tools)

  const run = async (work: () => Promise<unknown>, ok?: string) => {
    try {
      const result = await work()
      if (result && typeof result === "object") absorb(result as { files?: QueueFile[]; outputFolder?: string })
      if (ok) flash(ok)
    } catch (error) {
      flash(error instanceof Error ? error.message : "Request failed", false)
    }
  }

  const addFiles = () => run(() => api.pickFiles(), "Files added")
  const convert = async () => {
    const ids = files.filter((file) => file.status === "idle" && !isBlocked(file)).map((file) => file.id)
    if (!ids.length) return
    setConverting(true)
    try {
      absorb(await api.convert(ids))
      flash("Conversion started")
    } catch (error) {
      flash(error instanceof Error ? error.message : "Convert failed", false)
    } finally {
      setConverting(false)
    }
  }

  const onSelect = (row: ConvertRow) => {
    if (row.kind === "queue") {
      setSelectedId(row.id)
      setSelectedHistory(null)
      void api.select(row.id).catch(() => {})
    } else {
      setSelectedHistory(row.id)
      setSelectedId(null)
    }
  }

  const onReveal = (row: ConvertRow) => {
    const path = row.kind === "history" ? row.record?.outputPath : row.file?.status === "done" ? row.file.out : ""
    if (!path) return
    void run(() => api.reveal(path, row.kind === "history"))
  }

  const addCreatorItems = async () => {
    const before = new Set(files.map((file) => file.id))
    try {
      const next = await api.pickFiles()
      absorb(next)
      const added = (next.files || []).filter((file) => !before.has(file.id) && file.sourcePath)
      setCreatorItems((current) => [
        ...current,
        ...added.map((file) => ({
          id: file.id,
          name: file.name,
          path: file.sourcePath || "",
          size: file.sourceSize || 0,
        })),
      ])
      for (const file of added) {
        await api.remove(file.id).catch(() => {})
      }
      await api.state().then(absorb)
    } catch (error) {
      flash(error instanceof Error ? error.message : "Could not add items", false)
    }
  }

  const create = async () => {
    const groups = groupsFrom(tools)
    const format = groups.flatMap((group) => group.items).find((item) => item.id === creatorFmt)
    const converter = format?.converter
    if (!converter || !creatorItems.length) return
    setCreating(true)
    try {
      absorb(await api.create({ format: converter, items: creatorItems.map((item) => ({ path: item.path })), name: "Untitled" }))
      flash("Create started")
      setPage("convert")
    } catch (error) {
      flash(error instanceof Error ? error.message : "Create failed", false)
    } finally {
      setCreating(false)
    }
  }

  const openPdf = async () => {
    const before = new Set(files.map((file) => file.id))
    try {
      const next = await api.pickFiles()
      absorb(next)
      const added = (next.files || []).filter((file) => !before.has(file.id))
      const pdf = added.find((file) => /\.pdf$/i.test(file.sourcePath || file.name || ""))
      if (!pdf?.sourcePath) {
        flash("Pick a PDF on disk", false)
        return
      }
      const opened = await api.editorOpen([pdf.sourcePath])
      const sessionId = String((opened as { sessionId?: string; id?: string }).sessionId || (opened as { id?: string }).id || "session")
      const pages = Array.isArray((opened as { pages?: EditorSession["pages"] }).pages)
        ? (opened as { pages: EditorSession["pages"] }).pages
        : Array.from({ length: Number((opened as { pageCount?: number }).pageCount) || 8 }, (_, index) => ({ id: String(index + 1), index }))
      setEditor({ sessionId, name: pdf.name, pages })
      await api.remove(pdf.id).catch(() => {})
      flash("Document opened")
    } catch (error) {
      flash(error instanceof Error ? error.message : "Could not open PDF", false)
    }
  }

  const onKey = useCallback((event: { key?: string; modifiers?: { meta?: boolean; control?: boolean } }) => {
    const key = String(event.key || "")
    const mod = event.modifiers?.meta || event.modifiers?.control
    if (key === "Escape") {
      setPaletteOpen(false)
      setSettingsOpen(false)
      setRouteFor(null)
    }
    if (mod && key.toLowerCase() === "k") {
      setPaletteOpen(true)
      setSettingsOpen(false)
    }
    if (mod && key.toLowerCase() === "o") void addFiles()
    if (key === "Enter" && page === "convert") void convert()
  }, [page])

  useEffect(() => {
    const g = globalThis as { __onetoolKeys?: (event: { key?: string }) => void }
    g.__onetoolKeys = onKey
  }, [onKey])

  return (
    <ThemeProvider theme={theme}>
      <div style={col({ height: "100%", width: "100%", position: "relative" })} onKeyDown={(event) => onKey(event as { key?: string })}>
        <Shell
          page={page}
          helperDot={helperDot}
          connected={connected}
          mac={mac}
          inspectorOpen={inspectorOpen}
          onPage={(next) => { setPage(next); setPaletteOpen(false) }}
          onSettings={() => { setSettingsOpen(true); setPaletteOpen(false) }}
          onPalette={() => { setPaletteOpen(true); setPaletteQuery("") }}
          onToggleInspector={() => setInspectorOpen((open) => !open)}
          panel={
            <Panel
              page={page}
              files={files}
              tools={tools}
              outputFolder={outputFolder}
              selected={selected}
              history={history}
            />
          }
        >
          {page === "convert" ? (
            <ConvertScreen
              files={files}
              history={history}
              tools={tools}
              outputFolder={outputFolder}
              filter={filter}
              sort={sort}
              selectedId={selectedId}
              selectedHistory={selectedHistory}
              converting={converting}
              onFilter={setFilter}
              onSort={() => setSort(SORT_CYCLE[(SORT_CYCLE.indexOf(sort) + 1) % SORT_CYCLE.length])}
              onAdd={() => void addFiles()}
              onConvert={() => void convert()}
              onSelect={onSelect}
              onReveal={onReveal}
              onPickFolder={() => void run(() => api.pickFolder(), "Folder updated")}
              onToggleRoute={(row) => { if (row.file) setRouteFor(row.file) }}
            />
          ) : null}
          {page === "creator" ? (
            <CreatorScreen
              tools={tools}
              stage={creatorStage}
              query={creatorQuery}
              fmt={creatorFmt}
              items={creatorItems}
              creating={creating}
              dest={outputFolder}
              onQuery={setCreatorQuery}
              onPick={setCreatorFmt}
              onContinue={() => setCreatorStage("build")}
              onBack={() => setCreatorStage("pick")}
              onAdd={() => void addCreatorItems()}
              onCreate={() => void create()}
              onRemove={(id) => setCreatorItems((current) => current.filter((item) => item.id !== id))}
              onMove={(id, delta) => {
                setCreatorItems((current) => {
                  const index = current.findIndex((item) => item.id === id)
                  const next = index + delta
                  if (index < 0 || next < 0 || next >= current.length) return current
                  const copy = [...current]
                  const [moved] = copy.splice(index, 1)
                  copy.splice(next, 0, moved)
                  return copy
                })
              }}
            />
          ) : null}
          {page === "editor" ? <EditorScreen session={editor} onOpen={() => void openPdf()} /> : null}
        </Shell>
        {paletteOpen ? (
          <Palette
            tools={tools}
            query={paletteQuery}
            onQuery={setPaletteQuery}
            onClose={() => setPaletteOpen(false)}
            onConversion={(id) => { setPaletteOpen(false); flash(`Route ${id}`) }}
            onAction={(id) => {
              setPaletteOpen(false)
              if (id === "add") void addFiles()
              if (id === "settings" || id === "helpers") {
                setSettingsTab(id === "helpers" ? "helpers" : "general")
                setSettingsOpen(true)
              }
              if (id === "history") setPage("convert")
            }}
          />
        ) : null}
        {settingsOpen ? (
          <Settings
            tab={settingsTab}
            themeName={themeName}
            autoStart={autoStart}
            helpers={helpers}
            onTab={setSettingsTab}
            onTheme={setThemeName}
            onAutoStart={setAutoStart}
            onRecheck={() => void run(() => api.recheck(), "Helpers rechecked")}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}
        {routeFor ? (
          <RouteSheet
            file={routeFor}
            tools={tools}
            onClose={() => setRouteFor(null)}
            onChoose={(converter) => {
              const id = routeFor.id
              setRouteFor(null)
              void run(() => api.route(id, converter), "Route changed")
            }}
          />
        ) : null}
        <Toast toast={toast} />
      </div>
    </ThemeProvider>
  )
}
