import type { ReactNode } from "react"
import { Button, Overlay, Switch, T, useTheme } from "../primitives"
import type { HelperInfo, Tool } from "../types"
import type { ThemeName } from "../theme"

const TABS = [
  { id: "general", name: "General" },
  { id: "conversions", name: "Conversions" },
  { id: "helpers", name: "Helpers" },
  { id: "advanced", name: "Advanced" },
]

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
  return (
    <Overlay onClose={onClose}>
      <div
        testId="settings"
        style={{
          width: 940,
          height: 660,
          maxWidth: "100%",
          maxHeight: "100%",
          borderRadius: theme.radius.card,
          backgroundColor: theme.bg,
          flexDirection: "row",
          overflow: "hidden",
          boxShadow: theme.shadowModal,
        }}
      >
        <div style={{ width: 236, flexShrink: 0, borderRightWidth: 1, borderColor: theme.sep, flexDirection: "column" }}>
          <div style={{ padding: 12 }}>
            <T size="xs" weight={600} color={theme.t3}>
              SETTINGS
            </T>
          </div>
          <div style={{ flexGrow: 1, paddingLeft: 8, paddingRight: 8, gap: 2 }}>
            {TABS.map((item) => {
              const on = item.id === tab
              return (
                <div
                  key={item.id}
                  onClick={() => onTab(item.id)}
                  style={{
                    minHeight: 30,
                    paddingLeft: 9,
                    paddingRight: 9,
                    borderRadius: theme.radius.control,
                    justifyContent: "center",
                    backgroundColor: on ? theme.quiet2 : "transparent",
                    hover: { backgroundColor: on ? theme.quiet2 : theme.quiet },
                    cursor: "pointer",
                  }}
                >
                  <T size="md" weight={on ? 600 : 500} color={on ? theme.t1 : theme.t2}>
                    {item.name}
                  </T>
                </div>
              )
            })}
          </div>
          <div style={{ padding: 14, borderTopWidth: 1, borderColor: theme.sep }}>
            <T color={theme.t4} size="xs" mono>
              GPUIX 0.1.0
            </T>
          </div>
        </div>
        <div style={{ flexGrow: 1, minWidth: 0, flexDirection: "column" }}>
          <div style={{ height: 44, flexShrink: 0, flexDirection: "row", alignItems: "center", paddingLeft: 24, paddingRight: 12 }}>
            <div style={{ flexGrow: 1 }}>
              <T size="md" weight={600} color={theme.t2}>
                {TABS.find((item) => item.id === tab)?.name || "Settings"}
              </T>
            </div>
            <Button label="Close" variant="ghost" size="sm" onClick={onClose} />
          </div>
          <div style={{ flexGrow: 1, minHeight: 0, overflow: "scroll", paddingLeft: 24, paddingRight: 24, paddingBottom: 40 }}>
            {tab === "general" ? (
              <>
                <Section title="Appearance">
                  <Setting label="Theme" sub="Follows this window, not the system.">
                    <Button label={themeName === "dark" ? "Dark" : "Light"} onClick={() => onTheme(themeName === "dark" ? "light" : "dark")} />
                  </Setting>
                </Section>
              </>
            ) : null}
            {tab === "conversions" ? (
              <Section title="Queue">
                <Setting label="Start converting on drop" sub="Files begin as soon as they land in the queue.">
                  <Switch on={autoStart} onClick={() => onAutoStart(!autoStart)} />
                </Setting>
              </Section>
            ) : null}
            {tab === "helpers" ? (
              <Section title="Helpers">
                <T color={theme.t3} size="xs">
                  Missing tools stay honest. Recheck after you install one.
                </T>
                <Button label="Recheck helpers" variant="secondary" onClick={onRecheck} />
                {helpers.map((helper) => (
                  <div key={helper.name} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 13, paddingBottom: 13, borderBottomWidth: 1, borderColor: theme.sep }}>
                    <div
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: 4,
                        backgroundColor: helper.found ? theme.ok : theme.warn,
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ flexGrow: 1, minWidth: 0 }}>
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
            ) : null}
            {tab === "advanced" ? (
              <Section title="Client">
                <T color={theme.t3} size="sm">
                  This window is GPUIX over the Python converter. Windows paints with DirectX; Ubuntu 24.04 LTS paints with Vulkan. Electron still ships the existing Windows NSIS installer. Files stay on this machine.
                </T>
              </Section>
            ) : null}
          </div>
        </div>
      </div>
    </Overlay>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const theme = useTheme()
  return (
    <div style={{ paddingTop: 22, gap: 6 }}>
      <T size="md" weight={600}>
        {title}
      </T>
      {children}
    </div>
  )
}

function Setting({ label, sub, children }: { label: string; sub: string; children: ReactNode }) {
  const theme = useTheme()
  return (
    <div style={{ flexDirection: "row", alignItems: "center", gap: 20, paddingTop: 14, paddingBottom: 14, borderTopWidth: 1, borderColor: theme.sep }}>
      <div style={{ flexGrow: 1, minWidth: 0 }}>
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
