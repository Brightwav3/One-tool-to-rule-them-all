import { useState, type ReactNode } from "react"
import { Button, Overlay, Press, Switch, T, col, row, useTheme } from "../primitives"
import type { HelperInfo, Tool } from "../types"
import type { ThemeName } from "../theme"

const TABS = [
  { id: "general", name: "General", glyph: "⚙" },
  { id: "conversions", name: "Conversions", glyph: "⇄" },
  { id: "editing", name: "Editing", glyph: "✎" },
  { id: "files", name: "Files and locations", glyph: "🗀" },
  { id: "helpers", name: "Helpers", glyph: "⚗" },
  { id: "shortcuts", name: "Shortcuts", glyph: "⌘" },
  { id: "advanced", name: "Advanced", glyph: "⌥" },
] as const

type PrefKind = "switch" | "select" | "action"

type PrefRow = { id: string; lab: string; sub: string; kind: PrefKind; opts?: string[]; on?: boolean; value?: string }

const SET_DATA: Record<string, Array<{ title: string; rows: PrefRow[] }>> = {
  general: [
    {
      title: "On launch",
      rows: [
        { id: "openWith", lab: "Open with", sub: "What One Tool shows when you start it.", kind: "select", opts: ["Last document", "File browser", "Empty window"] },
        { id: "restore", lab: "Restore open documents", sub: "Reopen everything that was open when you quit.", kind: "switch", on: true },
      ],
    },
    {
      title: "Appearance",
      rows: [
        { id: "theme", lab: "Theme", sub: "Follows this window, not the system.", kind: "select", opts: ["Light", "Dark"] },
        { id: "density", lab: "Thumbnail size", sub: "Pages per row in the grid.", kind: "select", opts: ["Medium", "Small", "Large"] },
        { id: "anim", lab: "Animate view changes", sub: "Zoom between the grid and the reader.", kind: "switch", on: true },
      ],
    },
  ],
  conversions: [
    {
      title: "Queue",
      rows: [
        { id: "autoStart", lab: "Start converting on drop", sub: "Files begin as soon as they land in the queue.", kind: "switch", on: false },
        { id: "parallel", lab: "Files at once", sub: "Higher is faster but uses more CPU.", kind: "select", opts: ["2", "1", "4", "8"] },
        { id: "onFail", lab: "When a file fails", sub: "Applies to the rest of the queue.", kind: "select", opts: ["Skip and continue", "Stop the queue", "Retry once"] },
      ],
    },
    {
      title: "Output",
      rows: [
        { id: "overwrite", lab: "If the output exists", sub: "Checked before anything is written.", kind: "select", opts: ["Add a number", "Overwrite", "Skip the file"] },
        { id: "notify", lab: "Notify when a batch finishes", sub: "A system notification, even when One Tool is in the background.", kind: "switch", on: true },
      ],
    },
  ],
  editing: [
    {
      title: "Pages",
      rows: [
        { id: "confirmDel", lab: "Confirm before deleting pages", sub: "Ask once when more than one page is selected.", kind: "switch", on: true },
        { id: "rotStep", lab: "Rotation step", sub: "Applied by R and the toolbar buttons.", kind: "select", opts: ["90°", "180°", "15°"] },
        { id: "insertAt", lab: "Insert blank pages", sub: "Where a new page lands.", kind: "select", opts: ["After selection", "At the end", "Before selection"] },
      ],
    },
    {
      title: "Redaction",
      rows: [
        { id: "redactWarn", lab: "Warn before applying", sub: "Applying removes the content underneath permanently.", kind: "switch", on: true },
        { id: "redactScope", lab: "Default scope", sub: "Which pages a new block covers.", kind: "select", opts: ["This page", "All pages"] },
      ],
    },
  ],
  files: [
    {
      title: "Saving",
      rows: [
        { id: "saveTo", lab: "Save new files to", sub: "Used by Extract and Save as new file.", kind: "select", opts: ["~/Converted", "Beside the original", "Ask each time"] },
        { id: "keepOrig", lab: "Keep the original", sub: "Never overwrite the file you opened.", kind: "switch", on: true },
        { id: "suffix", lab: "Name new files", sub: "Appended to the original name.", kind: "select", opts: ["— edited", "(1)", "Date stamp"] },
      ],
    },
  ],
  shortcuts: [
    {
      title: "Global",
      rows: [
        { id: "paletteKey", lab: "Command palette", sub: "Opens from anywhere in the app.", kind: "select", opts: ["⌘K", "⌃K", "F1"] },
        { id: "settingsKey", lab: "Open settings", sub: "This window.", kind: "select", opts: ["⌘,", "⌃,", "None"] },
        { id: "zoomToggle", lab: "Grid and reader", sub: "Switches between all pages and a single page.", kind: "select", opts: ["⌃Space", "⌘0", "Tab"] },
      ],
    },
  ],
  advanced: [
    {
      title: "Performance",
      rows: [
        { id: "cache", lab: "Page cache", sub: "More cache renders faster, uses more memory.", kind: "select", opts: ["512 MB", "256 MB", "2 GB"] },
        { id: "gpu", lab: "GPU rendering", sub: "Turn off if pages render incorrectly.", kind: "switch", on: true },
      ],
    },
    {
      title: "Diagnostics",
      rows: [
        { id: "logs", lab: "Verbose logging", sub: "Writes to the app log folder.", kind: "switch", on: false },
        { id: "reset", lab: "Reset all settings", sub: "Returns everything in this window to its default.", kind: "action", value: "Reset" },
      ],
    },
  ],
}

function defaults(): Record<string, string | boolean> {
  const next: Record<string, string | boolean> = {}
  for (const sections of Object.values(SET_DATA)) {
    for (const section of sections) {
      for (const row of section.rows) {
        if (row.kind === "switch") next[row.id] = Boolean(row.on)
        else if (row.kind === "select") next[row.id] = row.opts?.[0] || ""
        else next[row.id] = row.value || "Clear"
      }
    }
  }
  return next
}

export function Settings({
  tab,
  themeName,
  autoStart,
  helpers,
  onTab,
  onTheme,
  onAutoStart,
  onRecheck,
  onClose,
}: {
  tab: string
  themeName: ThemeName
  autoStart: boolean
  helpers: HelperInfo[]
  onTab: (id: string) => void
  onTheme: (name: ThemeName) => void
  onAutoStart: (on: boolean) => void
  onRecheck: () => void
  onClose: () => void
}) {
  const theme = useTheme()
  const [query, setQuery] = useState("")
  const [prefs, setPrefs] = useState(defaults)
  const [openSel, setOpenSel] = useState<string | null>(null)
  const missing = helpers.filter((helper) => !helper.found).length
  const q = query.trim().toLowerCase()
  const showHelpers = tab === "helpers" && !q
  const source = q ? Object.values(SET_DATA).flat() : SET_DATA[tab] || []
  const sections = source
    .map((sec) => ({ title: sec.title, rows: sec.rows.filter((row) => !q || `${row.lab} ${row.sub}`.toLowerCase().includes(q)) }))
    .filter((sec) => sec.rows.length)

  const valueOf = (item: PrefRow): string | boolean => {
    if (item.id === "theme") return themeName === "dark" ? "Dark" : "Light"
    if (item.id === "autoStart") return autoStart
    return prefs[item.id]
  }

  const setValue = (item: PrefRow, next: string | boolean) => {
    if (item.id === "theme") {
      onTheme(next === "Dark" ? "dark" : "light")
      return
    }
    if (item.id === "autoStart") {
      onAutoStart(Boolean(next))
      return
    }
    setPrefs((current) => ({ ...current, [item.id]: next }))
  }

  return (
    <Overlay onClose={onClose}>
      <div
        testId="settings"
        style={row({
          width: 940,
          height: 660,
          maxWidth: "100%",
          maxHeight: "100%",
          borderRadius: theme.radius.card,
          backgroundColor: theme.bg,
          alignItems: "stretch",
          overflow: "hidden",
          boxShadow: theme.shadowModal,
        })}
      >
        <div style={col({ width: 236, flexShrink: 0, borderRightWidth: 1, borderColor: theme.sep, height: "100%" })}>
          <div style={col({ paddingTop: 12, paddingBottom: 10, paddingLeft: 12, paddingRight: 12, flexShrink: 0 })}>
            <div
              style={row({
                height: 32,
                paddingLeft: 10,
                paddingRight: 10,
                borderRadius: 8,
                gap: 8,
                backgroundColor: theme.surface,
                borderWidth: 1,
                borderColor: theme.sep2,
              })}
            >
              <T color={theme.t3} size="sm">
                ⌕
              </T>
              <input
                value={query}
                placeholder="Search settings…"
                onChange={(event) => setQuery(event.value ?? "")}
                theme={{ caret: theme.acc }}
                style={{ flexGrow: 1, fontSize: theme.type.sm, fontFamily: theme.font, color: theme.t1 }}
              />
            </div>
          </div>
          <div style={col({ flexGrow: 1, minHeight: 0, overflow: "scroll", paddingLeft: 8, paddingRight: 8, paddingBottom: 12, gap: 2 })}>
            <div style={col({ paddingTop: 6, paddingBottom: 4, paddingLeft: 8 })}>
              <T size="xs" weight={600} color={theme.t3}>
                ONE TOOL
              </T>
            </div>
            {TABS.map((item) => {
              const on = item.id === tab
              return (
                <Press
                  key={item.id}
                  onClick={() => onTab(item.id)}
                  style={row({
                    minHeight: 30,
                    paddingLeft: 9,
                    paddingRight: 9,
                    borderRadius: theme.radius.control,
                    gap: 10,
                    backgroundColor: on ? theme.quiet2 : "transparent",
                    hover: { backgroundColor: on ? theme.quiet2 : theme.quiet },
                    width: "100%",
                  })}
                >
                  <T size="sm" color={on ? theme.t1 : theme.t2}>
                    {item.glyph}
                  </T>
                  <div style={col({ flexGrow: 1, minWidth: 0 })}>
                    <T size="md" weight={on ? 600 : 500} color={on ? theme.t1 : theme.t2}>
                      {item.name}
                    </T>
                  </div>
                  {item.id === "helpers" && missing ? (
                    <div style={row({ minWidth: 16, height: 16, paddingLeft: 5, paddingRight: 5, borderRadius: 8, backgroundColor: theme.warnTint, justifyContent: "center" })}>
                      <T color={theme.warnT} size={10} weight={600}>
                        {missing}
                      </T>
                    </div>
                  ) : null}
                </Press>
              )
            })}
          </div>
          <div style={col({ padding: 14, borderTopWidth: 1, borderColor: theme.sep, flexShrink: 0 })}>
            <T color={theme.t4} size="xs" mono>
              One Tool 0.1.0
            </T>
          </div>
        </div>
        <div style={col({ flexGrow: 1, minWidth: 0, height: "100%" })}>
          <div style={row({ height: 44, flexShrink: 0, paddingLeft: 24, paddingRight: 12, width: "100%" })}>
            <div style={col({ flexGrow: 1 })}>
              <T size="md" weight={600} color={theme.t2}>
                {q ? "Search results" : TABS.find((item) => item.id === tab)?.name || "Settings"}
              </T>
            </div>
            <Button label="✕" variant="ghost" size="sm" onClick={onClose} />
          </div>
          <div style={col({ flexGrow: 1, minHeight: 0, overflow: "scroll", paddingLeft: 24, paddingRight: 24, paddingBottom: 40 })}>
            {showHelpers ? (
              <Section title="Helpers">
                <T color={theme.t3} size="xs">
                  {missing ? `${helpers.length - missing} of ${helpers.length} installed · ${missing} missing` : helpers.length ? `All ${helpers.length} installed` : "No external helpers are registered."}
                </T>
                <Button label="Recheck helpers" variant="secondary" onClick={onRecheck} />
                {helpers.map((helper) => (
                  <div key={helper.name} style={row({ gap: 12, paddingTop: 13, paddingBottom: 13, borderBottomWidth: 1, borderColor: theme.sep, width: "100%" })}>
                    <div
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 4,
                        backgroundColor: helper.found ? theme.ok : theme.warn,
                        flexShrink: 0,
                      }}
                    />
                    <div style={col({ flexGrow: 1, minWidth: 0 })}>
                      <T size="md" weight={600} mono>
                        {helper.name}
                      </T>
                      <T color={theme.t3} size="xs">
                        {helper.why || (helper.found ? helper.foundPath || "Found" : "Not on this machine")}
                      </T>
                    </div>
                  </div>
                ))}
              </Section>
            ) : sections.length ? (
              sections.map((section) => (
                <Section key={section.title} title={section.title}>
                  {section.rows.map((item) => (
                    <Setting key={item.id} label={item.lab} sub={item.sub}>
                      {item.kind === "switch" ? (
                        <Switch on={Boolean(valueOf(item))} onClick={() => setValue(item, !valueOf(item))} />
                      ) : item.kind === "select" ? (
                        <Select
                          value={String(valueOf(item))}
                          options={item.opts || []}
                          open={openSel === item.id}
                          onToggle={() => setOpenSel(openSel === item.id ? null : item.id)}
                          onPick={(next) => {
                            setValue(item, next)
                            setOpenSel(null)
                          }}
                        />
                      ) : (
                        <Button label={String(valueOf(item))} size="sm" onClick={() => {}} />
                      )}
                    </Setting>
                  ))}
                </Section>
              ))
            ) : (
              <div style={col({ padding: 40, alignItems: "center" })}>
                <T color={theme.t3} size="md">
                  {`Nothing matches “${query}”.`}
                </T>
              </div>
            )}
          </div>
        </div>
      </div>
    </Overlay>
  )
}

function Select({
  value,
  options,
  open,
  onToggle,
  onPick,
}: {
  value: string
  options: string[]
  open: boolean
  onToggle: () => void
  onPick: (value: string) => void
}) {
  const theme = useTheme()
  return (
    <div style={col({ position: "relative", flexShrink: 0 })}>
      <Press
        onClick={onToggle}
        style={row({
          height: 26,
          paddingLeft: 9,
          paddingRight: 9,
          borderRadius: 7,
          gap: 8,
          borderWidth: 1,
          borderColor: theme.sep2,
          backgroundColor: theme.surface,
        })}
      >
        <T size="sm" weight={500}>
          {value}
        </T>
        <T color={theme.t3} size={8}>
          ▼
        </T>
      </Press>
      {open ? (
        <div
          style={col({
            position: "absolute",
            right: 0,
            top: 30,
            minWidth: 168,
            padding: 4,
            borderRadius: 9,
            backgroundColor: theme.surface,
            boxShadow: theme.shadowRaised,
            borderWidth: 1,
            borderColor: theme.sep,
            gap: 1,
          })}
        >
          {options.map((option) => (
            <Press
              key={option}
              onClick={() => onPick(option)}
              style={row({
                minHeight: 28,
                paddingLeft: 8,
                paddingRight: 8,
                borderRadius: 6,
                gap: 8,
                backgroundColor: option === value ? theme.quiet : "transparent",
                hover: { backgroundColor: theme.quiet },
                width: "100%",
              })}
            >
              <T color={theme.accText} size={10}>
                {option === value ? "✓" : " "}
              </T>
              <T size="sm" weight={option === value ? 600 : 400}>
                {option}
              </T>
            </Press>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme()
  return (
    <div style={col({ paddingTop: 22, gap: 6 })}>
      <T size="title" weight={600}>
        {title}
      </T>
      {children}
    </div>
  )
}

function Setting({ label, sub, children }: { label: string; sub: string; children: ReactNode }) {
  const theme = useTheme()
  return (
    <div style={row({ gap: 20, paddingTop: 14, paddingBottom: 14, borderTopWidth: 1, borderColor: theme.sep, width: "100%" })}>
      <div style={col({ flexGrow: 1, minWidth: 0 })}>
        <T size="md" weight={500}>
          {label}
        </T>
        <T color={theme.t3} size="xs">
          {sub}
        </T>
      </div>
      {children}
    </div>
  )
}

export function helpersFrom(tools: Tool[]): HelperInfo[] {
  const map = new Map<string, HelperInfo>()
  for (const tool of tools) {
    if (tool.helper?.name) map.set(tool.helper.name, tool.helper)
    for (const req of tool.requirements || []) {
      if (req.name && !map.has(req.name)) map.set(req.name, req)
    }
  }
  return [...map.values()]
}
