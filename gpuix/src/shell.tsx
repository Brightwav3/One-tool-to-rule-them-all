import type { ReactNode } from "react"
import { Button, Kbd, NavItem, Press, T, col, row, useTheme } from "./primitives"
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
    <div style={col({ height: "100%", width: "100%", backgroundColor: theme.bg })}>
      <div style={row({ flexGrow: 1, minHeight: 0, alignItems: "stretch", width: "100%" })}>
        <div style={col({ flexGrow: 1, minWidth: 0, minHeight: 0 })}>
          <div
            style={row({
              height: 44,
              flexShrink: 0,
              gap: 16,
              paddingLeft: mac ? 82 : 16,
              paddingRight: inspectorOpen ? 14 : 16,
              width: "100%",
            })}
          >
            <Press
              onClick={onSettings}
              testId="settings-btn"
              style={row({ width: 24, height: 24, justifyContent: "center", position: "relative", flexShrink: 0 })}
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
            <div style={row({ gap: 4, flexShrink: 0 })}>
              {PAGES.map((item) => (
                <NavItem key={item.id} label={item.label} active={page === item.id} onClick={() => onPage(item.id)} />
              ))}
            </div>
            <div style={row({ flexGrow: 1, minWidth: 0, justifyContent: "center" })}>
              <Press
                onClick={onPalette}
                testId="search-btn"
                style={row({
                  width: 330,
                  maxWidth: "100%",
                  height: 28,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: theme.radius.pill,
                  gap: 8,
                  backgroundColor: theme.quiet,
                  hover: { backgroundColor: theme.quiet2 },
                })}
              >
                <T color={theme.t3} size="md">
                  ⌕
                </T>
                <div style={col({ flexGrow: 1, minWidth: 0 })}>
                  <T color={theme.t3} size="sm">
                    Search conversions, files, helpers
                  </T>
                </div>
                <Kbd>{mac ? "⌘K" : "Ctrl K"}</Kbd>
              </Press>
            </div>
            {connected ? null : (
              <T color={theme.warnT} size="xs" weight={500}>
                Waiting for converter…
              </T>
            )}
            <Press
              onClick={onToggleInspector}
              style={row({
                width: 30,
                height: 26,
                justifyContent: "center",
                borderRadius: theme.radius.pill,
                flexShrink: 0,
                backgroundColor: inspectorOpen ? theme.acc : "transparent",
                hover: { backgroundColor: inspectorOpen ? theme.accH : theme.quiet },
              })}
            >
              <T color={inspectorOpen ? theme.inverse : theme.t2} size="sm">
                ▥
              </T>
            </Press>
          </div>

          <div
            style={col({
              flexGrow: 1,
              minHeight: 0,
              marginTop: 0,
              marginBottom: 8,
              marginLeft: 8,
              marginRight: inspectorOpen ? 0 : 8,
              backgroundColor: theme.surface,
              borderWidth: 1,
              borderColor: theme.sep,
              borderRadius: theme.radius.card,
              overflow: "hidden",
              boxShadow: theme.shadowCard,
            })}
          >
            {children}
          </div>
        </div>

        {inspectorOpen ? (
          <div style={col({ width: 308, flexShrink: 0, backgroundColor: theme.bg, height: "100%" })}>
            <div style={{ height: 44, flexShrink: 0 }} />
            <div style={col({ flexGrow: 1, minHeight: 0, paddingLeft: 16, paddingRight: 16, paddingBottom: 16, gap: 12 })}>
              {panel}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function Foot({ summary, trailing }: { summary: string; trailing?: ReactNode }) {
  const theme = useTheme()
  return (
    <div
      style={row({
        flexShrink: 0,
        gap: 12,
        paddingTop: 11,
        paddingBottom: 11,
        paddingLeft: 18,
        paddingRight: 18,
        borderTopWidth: 1,
        borderColor: theme.sep,
        width: "100%",
        justifyContent: "space-between",
      })}
    >
      <div style={col({ flexGrow: 1, minWidth: 0 })}>
        <T color={theme.t2} size="md">
          {summary}
        </T>
      </div>
      {trailing}
    </div>
  )
}
