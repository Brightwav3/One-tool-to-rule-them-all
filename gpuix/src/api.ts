import type { AppState, HistoryRecord, Tool } from "./types"

export class ApiError extends Error {
  status: number
  constructor(message: string, status = 0) {
    super(message)
    this.status = status
  }
}

export class ConverterApi {
  constructor(public readonly baseUrl: string) {}

  private url(route: string): string {
    return `${this.baseUrl}${route}`
  }

  async get<T>(route: string): Promise<T> {
    const res = await fetch(this.url(route))
    const data = await res.json().catch(() => ({}))
    if (!res.ok || (data as { error?: string }).error) {
      throw new ApiError((data as { error?: string }).error || `Request failed (${res.status})`, res.status)
    }
    return data as T
  }

  async post<T = AppState>(route: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.url(route), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || (data as { error?: string }).error) {
      throw new ApiError((data as { error?: string }).error || `Request failed (${res.status})`, res.status)
    }
    return data as T
  }

  tools(): Promise<{ tools: Tool[]; engine_info?: unknown }> {
    return this.get("/api/tools")
  }

  state(): Promise<AppState> {
    return this.get("/api/state")
  }

  history(): Promise<{ history: HistoryRecord[] }> {
    return this.get("/api/history")
  }

  pickFiles(): Promise<AppState> {
    return this.post("/api/pick-files")
  }

  pickFolder(): Promise<AppState> {
    return this.post("/api/pick-folder")
  }

  addPath(path: string): Promise<AppState> {
    return this.post("/api/add-path", { path })
  }

  convert(ids: string[]): Promise<AppState> {
    return this.post("/api/convert", { ids })
  }

  route(id: string, converter: string): Promise<AppState> {
    return this.post("/api/route", { id, converter })
  }

  update(id: string, key: string, value: string): Promise<AppState> {
    return this.post("/api/update", { id, key, value })
  }

  remove(id: string): Promise<AppState> {
    return this.post("/api/remove", { id })
  }

  select(id: string): Promise<AppState> {
    return this.post("/api/select", { id })
  }

  reveal(path: string, history = false): Promise<AppState | Record<string, never>> {
    return this.post(history ? "/api/history/reveal" : "/api/reveal", { path })
  }

  create(payload: {
    format: string
    items: Array<{ path: string }>
    name?: string
    dest?: string
    options?: Record<string, unknown>
  }): Promise<AppState> {
    return this.post("/api/create", payload)
  }

  probe(paths: string[]): Promise<{ items?: Array<{ path: string; units?: number; size?: number }> } & AppState> {
    return this.post("/api/probe", { paths })
  }

  recheck(): Promise<AppState> {
    return this.post("/api/recheck")
  }

  editorOpen(paths: string[]): Promise<Record<string, unknown>> {
    return this.post("/api/editor/open", { paths })
  }
}

export function isReachable(baseUrl: string): Promise<boolean> {
  return fetch(`${baseUrl}/api/state`)
    .then((res) => res.ok)
    .catch(() => false)
}
