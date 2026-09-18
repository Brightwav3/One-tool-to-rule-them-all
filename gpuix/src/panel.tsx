import { Button, Overlay, T, Tile, col, row, useTheme } from "./primitives"
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
      <div style={col({ gap: 14 })}>
        <div style={col({ gap: 4 })}>
          <T size="md" weight={600}>
            Output
          </T>
          <T color={theme.t3} size="sm">
            Recipes and destination land here once a container is building.
          </T>
        </div>
        <div style={row({ gap: 8, paddingTop: 14, borderTopWidth: 1, borderColor: theme.sep })}>
          <div style={col({ flexGrow: 1 })}>
            <T color={theme.t3} size="xs" weight={600}>
              RECIPES
            </T>
          </div>
          <T color={theme.accText} size="xs" weight={600}>
            Save current
          </T>
        </div>
        <T color={theme.t3} size="xs">
          A recipe is a container plus its options, name pattern and destination.
        </T>
      </div>
    )
  }
  if (page === "editor") {
    return (
      <div style={col({ gap: 14 })}>
        <div style={row({ gap: 10, alignItems: "flex-start" })}>
          <Tile label="PDF" accent width={30} height={38} />
          <div style={col({ flexGrow: 1, minWidth: 0 })}>
            <T size="md" weight={600} mono>
              {selected?.name || "No document open"}
            </T>
            <T color={theme.t3} size="xs" mono>
              Open a PDF to inspect pages
            </T>
          </div>
        </div>
        <div style={col({ gap: 7 })}>
          <T color={theme.t3} size="xs" weight={600}>
            DOCUMENT
          </T>
          <Row k="Page size" v="—" />
          <Row k="PDF version" v="—" />
          <Row k="Text layer" v="none" />
        </div>
      </div>
    )
  }

  const file = selected?.kind === "queue" ? selected.file : undefined
  const tool = file ? tools.find((item) => item.id === file.conv) : undefined
  if (file) {
    return (
      <div style={col({ gap: 12 })}>
        <div style={col({ gap: 4 })}>
          <T size="md" weight={500}>
            {`Editing ${files.findIndex((item) => item.id === file.id) + 1} of ${files.length} files`}
          </T>
          <T color={theme.t2} size="sm">
            Changes apply to this file unless you say otherwise.
          </T>
        </div>
        <div style={row({ gap: 10, alignItems: "flex-start" })}>
          <Tile label={file.to || file.from} />
          <div style={col({ flexGrow: 1, minWidth: 0, gap: 4 })}>
            <T size="md" weight={600}>
              {file.name}
            </T>
            <T color={theme.t2} size="xs" mono>
              {`${(file.from || "").toUpperCase()} · ${fmtSize(file.sourceSize) || "Size unknown"}`}
            </T>
            <T color={theme.t2} size="sm">
              {`${file.from} → ${file.to || "Choose"}`}
            </T>
          </div>
        </div>
        <T color={theme.t3} size="sm">
          {tool?.blurb || "This converter has no per-file settings."}
        </T>
      </div>
    )
  }

  const blocked = files.filter((item) => item.status === "error").length
  return (
    <div style={col({ gap: 12 })}>
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
    <div style={row({ justifyContent: "space-between", gap: 12, width: "100%" })}>
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
        style={col({
          width: 420,
          maxHeight: 420,
          borderRadius: theme.radius.card,
          backgroundColor: theme.surface,
          boxShadow: theme.shadowModal,
          overflow: "hidden",
        })}
      >
        <div style={row({ paddingTop: 14, paddingBottom: 12, paddingLeft: 16, paddingRight: 16, borderBottomWidth: 1, borderColor: theme.sep, width: "100%" })}>
          <div style={col({ flexGrow: 1 })}>
            <T size="md" weight={500}>
              Choose output format
            </T>
            <T color={theme.t2} size="xs" mono>
              {file.name}
            </T>
          </div>
          <Button label="Close" variant="ghost" size="sm" onClick={onClose} />
        </div>
        <div style={col({ overflow: "scroll", padding: 8, maxHeight: 320, gap: 4 })}>
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
