import type { ConvertFilter, ConvertRow, ConvertSort, HistoryRecord, QueueFile, Tool } from "./types"

export function fmtSize(bytes?: number): string {
  const n = Number(bytes || 0)
  if (!n) return ""
  const units = ["B", "KB", "MB", "GB"]
  let value = n
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`
}

export function fmtWhen(stamp?: string): string {
  if (!stamp) return ""
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return ""
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })
}

export function isBlocked(file?: QueueFile): boolean {
  if (!file) return false
  return file.status === "error" && /isn.t installed|needs|helper/i.test(`${file.errorTitle || ""} ${file.error || ""}`)
}

export function routeStateLabel(tool: Tool): string {
  if (tool.state === "ready") return "Ready"
  if (tool.state === "helper") return "Needs helper"
  return "Not built yet"
}

const U_RANK = ["running", "queued", "blocked", "idle", "error", "stopped"]
const U_ACTIVE = ["running", "queued", "blocked", "idle", "stopped"]

function histState(record: HistoryRecord): string {
  if (record.presence === "missing") return "missing"
  return record.state || "completed"
}

function histCategory(record: HistoryRecord, tools: Tool[]): string {
  const tool = tools.find((item) => item.id === record.conv)
  return String(tool?.cat || "documents").toLowerCase()
}

export function convertRows(files: QueueFile[], history: HistoryRecord[], tools: Tool[]): ConvertRow[] {
  const toolMap = new Map(tools.map((tool) => [tool.id, tool]))
  const writtenAt = new Map(history.map((record) => [`${record.sourcePath}|${record.to}`, record.finishedAt]))
  const queued: ConvertRow[] = files.map((file) => ({
    kind: "queue",
    id: file.id,
    file,
    name: file.name,
    from: file.from,
    to: file.to,
    state: isBlocked(file) ? "blocked" : file.status,
    cat: String(toolMap.get(file.conv || "")?.cat || "documents").toLowerCase(),
    size: file.status === "done" ? fmtSize(file.size) : "",
    when: file.status === "done" ? fmtWhen(writtenAt.get(`${file.sourcePath}|${file.to}`)) : "",
  }))
  const inQueue = new Set(files.map((file) => `${file.sourcePath}|${file.to}`))
  const written: ConvertRow[] = history
    .filter((record) => !record.deleted && !inQueue.has(`${record.sourcePath}|${record.to}`))
    .map((record) => {
      const state = histState(record)
      return {
        kind: "history" as const,
        id: record.id,
        record,
        name: record.name,
        from: record.from,
        to: record.to,
        state: state === "completed" ? "done" : state === "uncompleted" ? "stopped" : state === "active" ? "running" : "missing",
        cat: histCategory(record, tools),
        size: fmtSize(record.size),
        when: fmtWhen(record.finishedAt),
      }
    })
  return [...queued, ...written]
}

export function rowMatches(row: ConvertRow, filter: ConvertFilter): boolean {
  if (filter === "all") return true
  if (filter === "active") return U_ACTIVE.includes(row.state)
  if (filter === "completed") return row.state === "done"
  if (filter === "stopped") return row.state === "stopped" || row.state === "error"
  if (filter === "missing") return row.state === "missing"
  return row.cat === filter
}

export function visibleRows(
  files: QueueFile[],
  history: HistoryRecord[],
  tools: Tool[],
  filter: ConvertFilter,
  sort: ConvertSort,
): ConvertRow[] {
  const all = convertRows(files, history, tools)
  const order = all.map((row) => row.id)
  return all.filter((row) => rowMatches(row, filter)).sort((a, b) => {
    const rank = (U_RANK.indexOf(a.state) + 1 || 99) - (U_RANK.indexOf(b.state) + 1 || 99)
    if (rank !== 0) return rank
    if (sort === "name") return String(a.name).localeCompare(String(b.name))
    if (sort === "largest") return Number(b.record?.size || b.file?.size || 0) - Number(a.record?.size || a.file?.size || 0)
    if (sort === "oldest") return order.indexOf(b.id) - order.indexOf(a.id)
    return order.indexOf(a.id) - order.indexOf(b.id)
  })
}

export function commonFolder(files: QueueFile[], outputFolder?: string): string {
  if (!files.length) return outputFolder || "~/Converted"
  const raw = files[0]?.out || outputFolder || "~/Converted"
  return raw.replace(/[\\/][^\\/]+$/, "") || outputFolder || "~/Converted"
}

export function statusLabel(row: ConvertRow): { label: string; tone: string } {
  if (row.state === "idle") return { label: "ready", tone: "" }
  if (row.state === "queued") return { label: "waiting", tone: "quiet" }
  if (row.state === "running") return { label: row.file?.phase || "converting", tone: "run" }
  if (row.state === "done") return { label: "on disk", tone: "ok" }
  if (row.state === "stopped") return { label: "stopped", tone: "warn" }
  if (row.state === "missing") return { label: "missing", tone: "quiet" }
  if (row.state === "blocked") return { label: row.file ? statusText(row.file) : "needs helper", tone: "warn" }
  if (row.state === "error") return { label: row.file ? statusText(row.file) : "stopped", tone: "bad" }
  return { label: row.state, tone: "" }
}

function statusText(file: QueueFile): string {
  if (file.errorTitle) return file.errorTitle.replace(/ isn't installed.*/i, "").trim() || file.errorTitle
  if (file.error) return file.error
  return file.status
}

export function progressPct(file?: QueueFile): number {
  if (!file || !file.units) return file?.status === "running" ? 12 : 0
  return Math.max(0, Math.min(100, Math.round((100 * (file.doneUnits || 0)) / file.units)))
}

export const FILTERS: Array<{ id: ConvertFilter; name: string }> = [
  { id: "all", name: "All" },
  { id: "active", name: "Active" },
  { id: "completed", name: "Completed" },
  { id: "stopped", name: "Stopped" },
  { id: "missing", name: "Missing" },
  { id: "comics", name: "Comics" },
  { id: "images", name: "Images" },
  { id: "documents", name: "Documents" },
  { id: "video", name: "Video" },
]

export const SORTS: Record<ConvertSort, string> = {
  newest: "Newest",
  oldest: "Oldest",
  name: "Name",
  largest: "Largest",
}

export const CREATOR_FALLBACK: Array<{ name: string; items: Array<{ id: string; title: string; desc: string; unit: string; needs?: string; dis?: boolean; opts: string[] }> }> = [
  {
    name: "Comics",
    items: [
      { id: "CBZ", title: "CBZ", desc: "Zip of images. The safe default for comic readers.", unit: "Pages", opts: ["compress", "meta", "rename"] },
      { id: "CBR", title: "CBR", desc: "Rar of images. Needs a helper to write.", needs: "7-Zip", unit: "Pages", opts: ["compress", "meta"] },
      { id: "EPUB", title: "EPUB", desc: "Fixed-layout book for e-readers.", unit: "Pages", opts: ["meta"] },
    ],
  },
  {
    name: "Documents",
    items: [
      { id: "PDF", title: "PDF", desc: "One document, one page per image.", unit: "Pages", opts: ["pageSize"] },
    ],
  },
  {
    name: "Archives",
    items: [
      { id: "ZIP", title: "ZIP", desc: "Anything, anywhere. Opens everywhere.", unit: "Files", opts: ["compress", "flatten"] },
    ],
  },
]
