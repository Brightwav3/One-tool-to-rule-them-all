import type { ReactNode } from "react"
import { Button, Kbd, NavItem, Press, T, useTheme } from "./primitives"
import type { PageId } from "./types"

const PAGES: Array<{ id: PageId; label: string }> = [
  { id: "convert", label: "Convert" },
  { id: "creator", label: "Creator" },
  { id: "editor", label: "Editor" },
]

export function Shell({
  page,
  helperDot,
  connected,
  mac,
  inspectorOpen,
  onPage,
  onSettings,
  onPalette,
  onToggleInspector,
  children,
  panel,
}: {
  page: PageId
  helperDot: boolean
  connected: boolean
  mac: boolean
  inspectorOpen: boolean
  onPage: (page: PageId) => void
  onSettings: () => void
  onPalette: () => void
  onToggleInspector: () => void
  children: ReactNode
  panel: ReactNode
}) {
  const theme = useTheme()
  return (
    <div style={{ height: "100%", width: "100%", backgroundColor: theme.bg, flexDirection: "column" }}>
      <div style={{ flexGrow: 1, minHeight: 0, flexDirection: "row" }}>
        <div style={{ flexGrow: 1, minWidth: 0, flexDirection: "column" }}>
          <div
            style={{
              height: 44,
              flexShrink: 0,
              flexDirection: "row",
              alignItems: "center",
              gap: 16,
              paddingLeft: mac ? 82 : 16,
              paddingRight: 14,
            }}
          >
            <Press
              onClick={onSettings}
              testId="settings-btn"
              style={{ width: 24, height: 24, alignItems: "center", justifyContent: "center", position: "relative" }}
            >
              <T color={theme.name === "dark" ? "#EDEDED" : "#6E6E74"} size={16} weight={600}>
                ⚙
              </T>
              {helperDot ? (
                <div
                  style={{
                    position: "absolute",
                    top: -1,
                    right: -2,
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: theme.warn,
                    borderWidth: 2,
                    borderColor: theme.bg,
                  }}
                />
              ) : null}
            </Press>
            <div style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
              {PAGES.map((item) => (
                <NavItem key={item.id} label={item.label} active={page === item.id} onClick={() => onPage(item.id)} />
              ))}
            </div>
            <div style={{ flexGrow: 1, minWidth: 0, alignItems: "center", justifyContent: "center" }}>
              <Press
                onClick={onPalette}
                testId="search-btn"
                style={{
                  width: 330,
                  maxWidth: "100%",
                  height: 28,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: theme.radius.control,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  backgroundColor: theme.quiet,
                  hover: { backgroundColor: theme.quiet2 },
                }}
              >
                <T color={theme.t3} size="md">
                  ⌕
                </T>
                <div style={{ flexGrow: 1, minWidth: 0 }}>
                  <T color={theme.t3} size="sm">
                    Search conversions, files, helpers
                  </T>
                </div>
                <Kbd>{mac ? "⌘K" : "Ctrl+K"}</Kbd>
              </Press>
            </div>
            <Button label={inspectorOpen ? "Hide" : "Inspector"} variant="secondary" size="sm" onClick={onToggleInspector} />
          </div>

          <div
            style={{
              flexGrow: 1,
              minHeight: 0,
              backgroundColor: theme.surface,
              borderTopWidth: 1,
              borderRightWidth: inspectorOpen ? 0 : 1,
              borderColor: theme.sep,
              borderTopRightRadius: inspectorOpen ? 0 : theme.radius.card,
              boxShadow: theme.shadowRaised,
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            {children}
          </div>
        </div>

        {inspectorOpen ? (
          <div style={{ width: 308, flexShrink: 0, backgroundColor: theme.bg, flexDirection: "column" }}>
            <div style={{ height: 44, flexShrink: 0 }} />
            <div style={{ flexGrow: 1, minHeight: 0, flexDirection: "column", paddingLeft: 16, paddingRight: 16, paddingBottom: 16, gap: 12 }}>
              {panel}
            </div>
          </div>
        ) : null}
      </div>

      <div
        style={{
          position: "absolute",
          left: 20,
          bottom: 18,
          paddingLeft: 10,
          paddingRight: 10,
          paddingTop: 4,
          paddingBottom: 4,
          borderRadius: theme.radius.control,
          backgroundColor: connected ? theme.okTint : theme.warnTint,
        }}
      >
        <T color={connected ? theme.okT : theme.warnT} size="xs" weight={500}>
          {connected ? "Python API connected" : "Waiting for converter…"}
        </T>
      </div>
    </div>
  )
}

export function Foot({ summary, trailing }: { summary: string; trailing?: ReactNode }) {
  const theme = useTheme()
  return (
    <div
      style={{
        flexShrink: 0,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingTop: 11,
        paddingBottom: 11,
        paddingLeft: 18,
        paddingRight: 18,
        borderTopWidth: 1,
        borderColor: theme.sep,
      }}
    >
      <div style={{ flexGrow: 1, minWidth: 0 }}>
        <T color={theme.t2} size="md">
          {summary}
        </T>
      </div>
      {trailing}
    </div>
  )
}
