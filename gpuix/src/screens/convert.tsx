import { Button, Check, Chip, Press, T, Tile, col, row, useTheme } from "../primitives"
import { FILTERS, SORTS, commonFolder, convertRows, isBlocked, progressPct, rowMatches, statusLabel, visibleRows } from "../format"
import { Foot } from "../shell"
import type { ConvertFilter, ConvertRow, ConvertSort, HistoryRecord, QueueFile, Tool } from "../types"

const COL = { conv: 104, status: 168, size: 64, when: 92 }

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
  const addKbd = typeof process !== "undefined" && process.platform === "darwin" ? "⌘O" : "Ctrl O"

  return (
    <div style={col({ flexGrow: 1, minHeight: 0, width: "100%", backgroundColor: theme.surface })}>
      <div style={col({ flexShrink: 0, paddingTop: 14, paddingBottom: 12, paddingLeft: 18, paddingRight: 18, gap: 10, width: "100%" })}>
        <div style={row({ gap: 8, width: "100%" })}>
          <div
            style={row({
              height: 30,
              paddingLeft: 4,
              paddingRight: 6,
              borderRadius: theme.radius.pill,
              gap: 6,
              backgroundColor: theme.quiet,
              minWidth: 0,
              flexShrink: 1,
            })}
          >
            <Press onClick={onPickFolder} style={row({ gap: 8, minWidth: 0, flexShrink: 1, height: 26, paddingLeft: 8, paddingRight: 8, borderRadius: 5 })}>
              <T color={theme.t2} size="sm" weight={500}>
                Save to
              </T>
              <T color={theme.t2} size="xs" mono>
                {dest}
              </T>
              <T color={theme.t3} size={9}>
                ▾
              </T>
            </Press>
            <Button label="Change" variant="ghost" size="sm" onClick={onPickFolder} />
          </div>
          <div style={{ flexGrow: 1, minWidth: 0 }} />
          <Button label={`${SORTS[sort]} ▾`} variant="secondary" onClick={onSort} />
          <Button label="Add files" kbd={addKbd} variant="primary" onClick={onAdd} testId="add-files" />
        </div>
        <div style={row({ flexWrap: "wrap", gap: 6, width: "100%" })}>
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
        style={col({
          flexGrow: 1,
          minHeight: 0,
          marginLeft: 8,
          marginRight: 8,
          marginBottom: 8,
          borderRadius: 11,
          borderWidth: 1,
          borderColor: theme.sep,
          backgroundColor: theme.surface,
          overflow: "hidden",
        })}
      >
        <div
          style={row({
            flexShrink: 0,
            gap: 12,
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 14,
            paddingRight: 14,
            borderBottomWidth: 1,
            borderColor: theme.sep,
            width: "100%",
          })}
        >
          <Check on={false} onClick={() => {}} />
          <div style={{ width: 26, flexShrink: 0 }} />
          <HeadCell flex label="File" />
          <HeadCell width={COL.conv} label="Conversion" />
          <HeadCell width={COL.status} label="Status" />
          <HeadCell width={COL.size} label="Size" right />
          <HeadCell width={COL.when} label="Written" right />
        </div>
        <div style={col({ flexGrow: 1, minHeight: 0, overflow: "scroll", width: "100%" })}>
          {rows.length === 0 ? (
            <div style={col({ paddingTop: 56, paddingBottom: 56, alignItems: "center", gap: 6 })}>
              <T size="md" weight={600}>
                Nothing matches
              </T>
              <T color={theme.t2} size="md">
                Nothing in this view yet.
              </T>
            </div>
          ) : (
            rows.map((rowItem, index) => (
              <ConvertRowView
                key={rowItem.id}
                item={rowItem}
                selected={rowItem.kind === "queue" ? rowItem.id === selectedId : rowItem.id === selectedHistory}
                rule={index === lastActive + 1 && lastActive >= 0}
                onSelect={() => onSelect(rowItem)}
                onReveal={() => onReveal(rowItem)}
                onToggleRoute={() => onToggleRoute(rowItem)}
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
    <div style={col({ width, flexGrow: flex ? 1 : 0, flexShrink: flex ? 1 : 0, alignItems: right ? "flex-end" : "flex-start", minWidth: 0 })}>
      <T color={theme.t3} size="xs" weight={600}>
        {label.toUpperCase()}
      </T>
    </div>
  )
}

function ConvertRowView({
  item,
  selected,
  rule,
  onSelect,
  onReveal,
  onToggleRoute,
}: {
  item: ConvertRow
  selected: boolean
  rule: boolean
  onSelect: () => void
  onReveal: () => void
  onToggleRoute: () => void
}) {
  const theme = useTheme()
  const meta = statusLabel(item)
  const tone =
    meta.tone === "ok" ? theme.okT
    : meta.tone === "run" ? theme.accText
    : meta.tone === "warn" ? theme.warnT
    : meta.tone === "quiet" ? theme.t3
    : meta.tone === "bad" ? theme.dangT
    : theme.t2
  const pct = progressPct(item.file)

  return (
    <Press
      onClick={onSelect}
      style={row({
        gap: 12,
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 14,
        paddingRight: 14,
        borderBottomWidth: 1,
        borderColor: theme.sep,
        borderTopWidth: rule ? 1 : 0,
        backgroundColor: selected ? theme.accTint : "transparent",
        width: "100%",
        hover: { backgroundColor: selected ? theme.accTint : theme.quiet },
      })}
    >
      <Check on={selected} onClick={onSelect} />
      <Tile label={item.to || item.from} />
      <Press onClick={item.state === "done" ? onReveal : onSelect} style={col({ flexGrow: 1, minWidth: 0 })}>
        <T color={item.state === "missing" ? theme.t3 : theme.t1} size="md" weight={600}>
          {item.name}
        </T>
      </Press>
      <div style={row({ width: COL.conv, flexShrink: 0, justifyContent: "flex-start" })}>
        <Press
          onClick={item.kind === "queue" ? onToggleRoute : undefined}
          style={row({
            height: 22,
            paddingLeft: 7,
            paddingRight: 7,
            borderRadius: 6,
            gap: 5,
            backgroundColor: item.state === "blocked" ? theme.warnTint : theme.quiet2,
            flexShrink: 0,
          })}
        >
          <T color={item.state === "blocked" ? theme.warnT : theme.t2} size="xs" weight={600} mono>
            {`${item.from} → ${item.to || "Choose"}`}
          </T>
        </Press>
      </div>
      <div style={row({ width: COL.status, gap: 9, flexShrink: 0, justifyContent: "flex-start" })}>
        {item.state === "running" || item.state === "queued" ? (
          <div style={col({ flexGrow: 1, height: 4, borderRadius: 999, backgroundColor: theme.quiet2, overflow: "hidden" })}>
            <div style={{ width: `${Math.max(pct, 8)}%`, height: 4, backgroundColor: theme.acc, borderRadius: 999 }} />
          </div>
        ) : null}
        <T color={tone} size="xs" weight={500} mono>
          {meta.label}
        </T>
      </div>
      <div style={col({ width: COL.size, alignItems: "flex-end", flexShrink: 0 })}>
        <T color={theme.t2} size="xs" align="right" mono>
          {item.size || "—"}
        </T>
      </div>
      <div style={col({ width: COL.when, alignItems: "flex-end", flexShrink: 0 })}>
        <T color={theme.t3} size="xs" align="right" mono>
          {item.when || " "}
        </T>
      </div>
    </Press>
  )
}
