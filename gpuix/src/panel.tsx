import { Button, Overlay, T, useTheme } from "./primitives"
import { commonFolder, fmtSize } from "./format"
import type { ConvertRow, HistoryRecord, PageId, QueueFile, Tool } from "./types"

export function Panel({
  page,
  files,
  tools,
  outputFolder,
  selected,
  history,
}: {
  page: PageId
  files: QueueFile[]
  tools: Tool[]
  outputFolder?: string
  selected: ConvertRow | null
  history: HistoryRecord[]
}) {
  const theme = useTheme()
  if (page === "creator") {
    return (
      <div style={{ gap: 10 }}>
        <T size="md" weight={500}>
          Output
        </T>
        <T color={theme.t2} size="sm">
          Recipes and destination land here once a container is building.
        </T>
      </div>
    )
  }
  if (page === "editor") {
    return (
      <div style={{ gap: 10 }}>
        <T size="md" weight={500}>
          Pages
        </T>
        <T color={theme.t2} size="sm">
          Rotate, crop and save once a PDF session is open.
        </T>
      </div>
    )
  }

  const file = selected?.kind === "queue" ? selected.file : undefined
  const tool = file ? tools.find((item) => item.id === file.conv) : undefined
  if (file) {
    return (
      <div style={{ gap: 12 }}>
        <T size="md" weight={500}>
          {`Editing ${files.findIndex((item) => item.id === file.id) + 1} of ${files.length} files`}
        </T>
        <T color={theme.t2} size="sm">
          Changes apply to this file unless you say otherwise.
        </T>
        <T size="md" weight={600}>
          {file.name}
        </T>
        <T color={theme.t2} size="xs" mono>
          {`${(file.from || "").toUpperCase()} · ${fmtSize(file.sourceSize) || "Size unknown"}`}
        </T>
        <T color={theme.t2} size="sm">
          {`${file.from} → ${file.to || "Choose"}`}
        </T>
        {tool?.blurb ? (
          <T color={theme.t3} size="sm">
            {tool.blurb}
          </T>
        ) : (
          <T color={theme.t3} size="sm">
            This converter has no per-file settings.
          </T>
        )}
      </div>
    )
  }

  const blocked = files.filter((item) => item.status === "error").length
  return (
    <div style={{ gap: 12 }}>
      <T size="md" weight={500}>
        {files.length ? "Batch summary" : "Nothing queued"}
      </T>
      <T color={theme.t2} size="sm">
        {files.length ? "Select a row to edit that file on its own." : "Drop files to begin."}
      </T>
      {files.length ? (
        <>
          <Row k="Files queued" v={String(files.length)} />
          <Row k="Need a helper" v={String(blocked)} />
          <Row k="Destination" v={commonFolder(files, outputFolder)} />
        </>
      ) : (
        <T color={theme.t3} size="sm">
          {`Once files are queued, this shows the batch at a glance. History keeps ${history.length} written files.`}
        </T>
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  const theme = useTheme()
  return (
    <div style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
      <T color={theme.t2} size="sm">
        {k}
      </T>
      <T size="xs" mono>
        {v}
      </T>
    </div>
  )
}

export function RouteSheet({
  file,
  tools,
  onChoose,
  onClose,
}: {
  file: QueueFile
  tools: Tool[]
  onChoose: (converter: string) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const ext = (file.sourceExt || "").toLowerCase()
  const candidates = tools.filter(
    (tool) => !tool.multi && ((ext && tool.from.toLowerCase() === file.from.toLowerCase()) || tool.id === file.conv),
  )
  const list = candidates.length ? candidates : tools.filter((tool) => !tool.multi && tool.from === file.from)
  return (
    <Overlay onClose={onClose} align="start" padTop={96}>
      <div
        style={{
          width: 420,
          maxHeight: 420,
          borderRadius: theme.radius.card,
          backgroundColor: theme.surface,
          boxShadow: theme.shadowModal,
          overflow: "hidden",
        }}
      >
        <div style={{ paddingTop: 14, paddingBottom: 12, paddingLeft: 16, paddingRight: 16, borderBottomWidth: 1, borderColor: theme.sep, flexDirection: "row", alignItems: "center" }}>
          <div style={{ flexGrow: 1 }}>
            <T size="md" weight={500}>
              Choose output format
            </T>
            <T color={theme.t2} size="xs" mono>
              {file.name}
            </T>
          </div>
          <Button label="Close" variant="ghost" size="sm" onClick={onClose} />
        </div>
        <div style={{ overflow: "scroll", padding: 8, maxHeight: 320 }}>
          {list.map((tool) => (
            <Button
              key={tool.id}
              label={`${tool.label} · ${tool.state}`}
              variant={tool.id === file.conv ? "primary" : "quiet"}
              onClick={() => onChoose(tool.id)}
            />
          ))}
        </div>
      </div>
    </Overlay>
  )
}
