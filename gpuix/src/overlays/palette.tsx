import { Kbd, Overlay, Press, T, useTheme } from "../primitives"
import { routeStateLabel } from "../format"
import type { Tool } from "../types"

export function Palette({
  tools,
  query,
  onQuery,
  onClose,
  onAction,
  onConversion,
}: {
  tools: Tool[]
  query: string
  onQuery: (value: string) => void
  onClose: () => void
  onAction: (id: string) => void
  onConversion: (id: string) => void
}) {
  const theme = useTheme()
  const q = query.trim().toLowerCase()
  const conversions = tools.filter((tool) => !tool.multi && (!q || `${tool.label} ${tool.blurb || ""} ${tool.from} ${tool.to}`.toLowerCase().includes(q))).slice(0, 12)
  const actions = [
    { id: "add", label: "Add files", detail: "Open the file picker" },
    { id: "helpers", label: "Open Helpers", detail: "Settings, helper installers" },
    { id: "settings", label: "Open Settings", detail: "App-wide preferences" },
    { id: "history", label: "Show converted files", detail: "Jump to the history below the queue" },
  ].filter((action) => !q || `${action.label} ${action.detail}`.toLowerCase().includes(q))

  return (
    <Overlay onClose={onClose} align="start" padTop={120}>
      <div
        testId="palette"
        style={{
          width: 520,
          borderRadius: theme.radius.card,
          backgroundColor: theme.surface,
          boxShadow: theme.shadowModal,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            padding: 16,
            borderBottomWidth: 1,
            borderColor: theme.sep,
          }}
        >
          <T color={theme.t3} size="md">
            ⌕
          </T>
          <input
            value={query}
            placeholder="Search conversions, files, helpers"
            onChange={(event) => onQuery(event.value ?? "")}
            theme={{ caret: theme.acc }}
            style={{ flexGrow: 1, fontSize: theme.type.md, fontFamily: theme.font, color: theme.t1 }}
          />
          <Kbd>esc</Kbd>
        </div>
        <div style={{ padding: 8, maxHeight: 360, overflow: "scroll" }}>
          {conversions.length ? (
            <>
              <Group label="Conversions" />
              {conversions.map((tool) => (
                <Row
                  key={tool.id}
                  glyph={tool.to}
                  label={tool.label}
                  status={routeStateLabel(tool)}
                  onClick={() => onConversion(tool.id)}
                />
              ))}
            </>
          ) : null}
          {actions.length ? (
            <>
              <Group label="Actions" />
              {actions.map((action) => (
                <Row key={action.id} glyph="→" label={action.label} status={action.detail} onClick={() => onAction(action.id)} />
              ))}
            </>
          ) : null}
          {!conversions.length && !actions.length ? (
            <div style={{ padding: 24, alignItems: "center" }}>
              <T color={theme.t3} size="sm">
                No matching commands.
              </T>
            </div>
          ) : null}
        </div>
      </div>
    </Overlay>
  )
}

function Group({ label }: { label: string }) {
  const theme = useTheme()
  return (
    <div style={{ paddingTop: 8, paddingBottom: 8, paddingLeft: 10 }}>
      <T color={theme.t3} size="xs" weight={500}>
        {label.toUpperCase()}
      </T>
    </div>
  )
}

function Row({ glyph, label, status, onClick }: { glyph: string; label: string; status: string; onClick: () => void }) {
  const theme = useTheme()
  return (
    <Press
      onClick={onClick}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 38,
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: theme.radius.control,
        hover: { backgroundColor: theme.quiet },
      }}
    >
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 5,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.bg,
          flexShrink: 0,
        }}
      >
        <T color={theme.t2} size="xs" weight={500} mono>
          {glyph}
        </T>
      </div>
      <div style={{ flexGrow: 1 }}>
        <T size="md">{label}</T>
      </div>
      <T color={theme.t3} size="sm">
        {status}
      </T>
    </Press>
  )
}
