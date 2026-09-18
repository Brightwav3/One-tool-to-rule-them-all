import { Button, Check, Chip, Press, T, useTheme } from "../primitives"
import { FILTERS, SORTS, commonFolder, convertRows, isBlocked, progressPct, rowMatches, statusLabel, visibleRows } from "../format"
import { Foot } from "../shell"
import type { ConvertFilter, ConvertRow, ConvertSort, HistoryRecord, QueueFile, Tool } from "../types"

export function ConvertScreen({
  files,
  history,
  tools,
  outputFolder,
  filter,
  sort,
  selectedId,
  selectedHistory,
  converting,
  onFilter,
  onSort,
  onAdd,
  onConvert,
  onSelect,
  onReveal,
  onPickFolder,
  onToggleRoute,
}: {
  files: QueueFile[]
  history: HistoryRecord[]
  tools: Tool[]
  outputFolder?: string
  filter: ConvertFilter
  sort: ConvertSort
  selectedId: string | null
  selectedHistory: string | null
  converting: boolean
  onFilter: (id: ConvertFilter) => void
  onSort: () => void
  onAdd: () => void
  onConvert: () => void
  onSelect: (row: ConvertRow) => void
  onReveal: (row: ConvertRow) => void
  onPickFolder: () => void
  onToggleRoute: (row: ConvertRow) => void
}) {
  const theme = useTheme()
  const all = convertRows(files, history, tools)
  const rows = visibleRows(files, history, tools, filter, sort)
  const ready = files.filter((file) => file.status === "idle" && !isBlocked(file)).length
  const blocked = files.filter(isBlocked).length
  const busy = files.filter((file) => file.status === "queued" || file.status === "running").length
  const written = all.filter((row) => row.state === "done").length
  const dest = commonFolder(files, outputFolder)
  const lastActive = rows.reduce((last, row, index) => (["running", "queued", "blocked", "idle", "stopped"].includes(row.state) ? index : last), -1)
  const summary = busy
    ? `Converting · ${blocked} waiting on a helper`
    : `${ready} ready · ${blocked} waiting on a helper · ${written} written`

  return (
    <div style={{ flexGrow: 1, minHeight: 0, flexDirection: "column" }}>
      <div style={{ flexShrink: 0, paddingTop: 14, paddingBottom: 12, paddingLeft: 18, paddingRight: 18, gap: 10 }}>
        <div style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <div style={{ flexGrow: 1, minWidth: 0, flexDirection: "row", alignItems: "center" }}>
          <Press
            onClick={onPickFolder}
            style={{
              minHeight: 30,
              paddingLeft: 10,
              paddingRight: 8,
              borderRadius: 7,
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              backgroundColor: theme.quiet,
              borderWidth: 1,
              borderColor: theme.sep,
              minWidth: 0,
            }}
          >
            <T color={theme.t2} size="sm">
              Save to
            </T>
            <T color={theme.t2} size="xs">
              {dest}
            </T>
          </Press>
        </div>
          <Button label={SORTS[sort]} variant="secondary" onClick={onSort} />
          <Button label="Add files" kbd="⌘O" variant="primary" onClick={onAdd} testId="add-files" />
        </div>
        <div style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {FILTERS.map((item) => (
            <Chip
              key={item.id}
              label={item.name}
              count={all.filter((row) => rowMatches(row, item.id)).length}
              on={filter === item.id}
              onClick={() => onFilter(item.id)}
            />
          ))}
        </div>
      </div>

      <div
        style={{
          flexGrow: 1,
          minHeight: 0,
          marginLeft: 8,
          marginRight: 8,
          marginBottom: 8,
          borderRadius: 11,
          borderWidth: 1,
          borderColor: theme.sep,
          backgroundColor: theme.surface,
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flexShrink: 0,
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 14,
            paddingRight: 14,
            borderBottomWidth: 1,
            borderColor: theme.sep,
          }}
        >
          <div style={{ width: 16 }} />
          <div style={{ width: 26 }} />
          <HeadCell flex label="File" />
          <HeadCell width={104} label="Conversion" />
          <HeadCell width={168} label="Status" />
          <HeadCell width={64} label="Size" right />
          <HeadCell width={92} label="Written" right />
        </div>
        <div style={{ flexGrow: 1, minHeight: 0, overflow: "scroll" }}>
          {rows.length === 0 ? (
            <div style={{ paddingTop: 56, paddingBottom: 56, alignItems: "center", gap: 6 }}>
              <T size="md" weight={600}>
                Nothing matches
              </T>
              <T color={theme.t2} size="md">
                Nothing in this view yet.
              </T>
            </div>
          ) : (
            rows.map((row, index) => (
              <ConvertRowView
                key={row.id}
                row={row}
                selected={row.kind === "queue" ? row.id === selectedId : row.id === selectedHistory}
                rule={index === lastActive}
                onSelect={() => onSelect(row)}
                onReveal={() => onReveal(row)}
                onToggleRoute={() => onToggleRoute(row)}
              />
            ))
          )}
        </div>
      </div>

      <Foot
        summary={summary}
        trailing={
          <Button
            label={ready > 1 ? `Convert ${ready}` : "Convert"}
            kbd="⏎"
            variant="primary"
            disabled={!ready || converting}
            busy={converting || busy > 0}
            onClick={onConvert}
            testId="convert"
          />
        }
      />
    </div>
  )
}

function HeadCell({ label, width, flex, right }: { label: string; width?: number; flex?: boolean; right?: boolean }) {
  const theme = useTheme()
  return (
    <div style={{ width, flexGrow: flex ? 1 : undefined, alignItems: right ? "flex-end" : "flex-start" }}>
      <T color={theme.t3} size="xs" weight={600}>
        {label.toUpperCase()}
      </T>
    </div>
  )
}

function ConvertRowView({
  row,
  selected,
  rule,
  onSelect,
  onReveal,
  onToggleRoute,
}: {
  row: ConvertRow
  selected: boolean
  rule: boolean
  onSelect: () => void
  onReveal: () => void
  onToggleRoute: () => void
}) {
  const theme = useTheme()
  const meta = statusLabel(row)
  const tone =
    meta.tone === "ok" ? theme.okT
    : meta.tone === "run" ? theme.accText
    : meta.tone === "warn" ? theme.warnT
    : meta.tone === "quiet" ? theme.t3
    : meta.tone === "bad" ? theme.dangT
    : theme.t2
  const pct = progressPct(row.file)

  return (
    <Press
      onClick={onSelect}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 14,
        paddingRight: 14,
        borderBottomWidth: 1,
        borderColor: theme.sep,
        borderTopWidth: rule ? 1 : 0,
        backgroundColor: selected ? theme.accTint : "transparent",
        hover: { backgroundColor: selected ? theme.accTint : theme.quiet },
      }}
    >
      <Check on={selected} onClick={onSelect} />
      <div
        style={{
          width: 26,
          height: 32,
          borderRadius: 4,
          backgroundColor: theme.quiet2,
          borderWidth: 1,
          borderColor: theme.sep,
          alignItems: "center",
          justifyContent: "flex-end",
          paddingBottom: 3,
          flexShrink: 0,
        }}
      >
        <T color={theme.t3} size={7} weight={600} mono>
          {row.to || row.from}
        </T>
      </div>
      <Press onClick={row.state === "done" ? onReveal : onSelect} style={{ flexGrow: 1, minWidth: 0 }}>
        <T color={row.state === "missing" ? theme.t3 : theme.t1} size="md" weight={600}>
          {row.name}
        </T>
      </Press>
      <Press
        onClick={row.kind === "queue" ? onToggleRoute : undefined}
        style={{
          width: 104,
          height: 22,
          paddingLeft: 7,
          paddingRight: 7,
          borderRadius: 6,
          flexDirection: "row",
          alignItems: "center",
          gap: 5,
          backgroundColor: row.state === "blocked" ? theme.warnTint : theme.quiet2,
          flexShrink: 0,
        }}
      >
        <T color={row.state === "blocked" ? theme.warnT : theme.t2} size="xs" weight={600} mono>
          {`${row.from} → ${row.to || "Choose"}`}
        </T>
      </Press>
      <div style={{ width: 168, flexDirection: "row", alignItems: "center", gap: 9, flexShrink: 0 }}>
        {row.state === "running" || row.state === "queued" ? (
          <div style={{ flexGrow: 1, height: 4, borderRadius: 999, backgroundColor: theme.quiet2, overflow: "hidden" }}>
            <div style={{ width: `${Math.max(pct, 8)}%`, height: "100%", backgroundColor: theme.acc, borderRadius: 999 }} />
          </div>
        ) : null}
        <T color={tone} size="xs" weight={500} mono>
          {meta.label}
        </T>
      </div>
      <div style={{ width: 64, alignItems: "flex-end", flexShrink: 0 }}>
        <T color={theme.t2} size="xs" mono align="right">
          {row.size || " "}
        </T>
      </div>
      <div style={{ width: 92, alignItems: "flex-end", flexShrink: 0 }}>
        <T color={theme.t3} size="xs" mono align="right">
          {row.when || " "}
        </T>
      </div>
    </Press>
  )
}
