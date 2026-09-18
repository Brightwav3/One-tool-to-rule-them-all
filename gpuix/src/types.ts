export type RouteState = "ready" | "helper" | "soon" | string

export type HelperInfo = {
  name: string
  why?: string
  cmd?: string
  url?: string
  download?: string
  found?: boolean
  foundPath?: string
}

export type ToolOption = { key: string; label: string; placeholder?: string }

export type Tool = {
  id: string
  from: string
  to: string
  label: string
  cat: string
  kind?: string
  ext?: string
  state: RouteState
  blurb?: string
  sub?: string
  multi?: boolean
  options?: ToolOption[]
  helper?: HelperInfo | null
  requirements?: HelperInfo[]
}

export type QueueFile = {
  id: string
  conv?: string | null
  from: string
  to: string
  convLabel?: string
  kind?: string
  name: string
  sourcePath?: string
  sourcePaths?: string[]
  sourceSize?: number
  sourceExt?: string
  opts?: Record<string, string>
  out?: string
  status: string
  units?: number
  doneUnits?: number
  phase?: string
  size?: number
  errorTitle?: string
  error?: string
}

export type HistoryRecord = {
  id: string
  name: string
  from: string
  to: string
  conv?: string
  sourcePath?: string
  outputPath?: string
  size?: number
  finishedAt?: string
  presence?: string
  state?: string
  deleted?: boolean
  options?: Record<string, string>
}

export type AppState = {
  files: QueueFile[]
  outputFolder?: string
  outputFolders?: string[]
  counts?: Record<string, number>
  tools?: Tool[]
  history?: HistoryRecord[]
}

export type PageId = "convert" | "creator" | "editor"

export type ConvertFilter =
  | "all"
  | "active"
  | "completed"
  | "stopped"
  | "missing"
  | "comics"
  | "images"
  | "documents"
  | "video"

export type ConvertSort = "newest" | "oldest" | "name" | "largest"

export type ConvertRow = {
  kind: "queue" | "history"
  id: string
  file?: QueueFile
  record?: HistoryRecord
  name: string
  from: string
  to: string
  state: string
  cat: string
  size: string
  when: string
}

export type CreatorItem = {
  id: string
  name: string
  path: string
  size: number
  units?: number
}

export type CreatorFormat = {
  id: string
  converter?: string
  title: string
  desc: string
  unit: string
  opts: string[]
  needs?: string
  dis?: boolean
}

export type CreatorGroup = { name: string; items: CreatorFormat[] }

export type Toast = { title: string; ok: boolean; sub?: string } | null

export type EditorSession = {
  sessionId: string
  name: string
  pages: Array<{ id: string; index: number; w?: number; h?: number; rot?: number }>
}
