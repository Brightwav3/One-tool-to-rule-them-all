import { Button, T, useTheme } from "../primitives"
import { Foot } from "../shell"
import type { EditorSession } from "../types"

const GHOSTS = [0, 1, 2, 3, 4, 5, 6, 7]

export function EditorScreen({
  session,
  onOpen,
}: {
  session: EditorSession | null
  onOpen: () => void
}) {
  const theme = useTheme()
  const pages = session?.pages.length ? session.pages : GHOSTS.map((index) => ({ id: `g${index}`, index }))
  const empty = !session

  return (
    <div style={{ flexGrow: 1, minHeight: 0, flexDirection: "column", backgroundColor: theme.bg }}>
      <div
        style={{
          flexShrink: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingTop: 13,
          paddingBottom: 11,
          paddingLeft: 18,
          paddingRight: 18,
        }}
      >
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          <T size="title" weight={600}>
            {session?.name || "No document open"}
          </T>
        </div>
        <Button label={session ? "Open another" : "Open a PDF"} variant="primary" onClick={onOpen} />
      </div>
      <div style={{ flexGrow: 1, minHeight: 0, overflow: "scroll", paddingTop: 16, paddingLeft: 18, paddingRight: 18, opacity: empty ? 0.35 : 1 }}>
        <div style={{ display: "grid", gridTemplateColumns: 6, gap: 12 }}>
          {pages.map((page, index) => (
            <div key={page.id} style={{ alignItems: "center", gap: 6 }}>
              <div
                style={{
                  width: "100%",
                  height: 148,
                  backgroundColor: theme.paper,
                  borderRadius: 3,
                  borderWidth: 1,
                  borderColor: theme.sep,
                  boxShadow: theme.shadowCard,
                  paddingTop: 9,
                  paddingLeft: 8,
                  paddingRight: 8,
                  gap: 4,
                }}
              >
                <div style={{ height: 5, width: "72%", borderRadius: 2, backgroundColor: theme.ink }} />
                <div style={{ height: 3, width: "96%", borderRadius: 2, backgroundColor: theme.ink }} />
                <div style={{ height: 3, width: "88%", borderRadius: 2, backgroundColor: theme.ink }} />
                <div style={{ height: 3, width: "64%", borderRadius: 2, backgroundColor: theme.ink }} />
              </div>
              <T color={theme.t3} size="xs">
                {String(index + 1)}
              </T>
            </div>
          ))}
        </div>
      </div>
      <Foot summary={session ? `${session.pages.length} pages` : "Open a PDF to edit its pages"} />
    </div>
  )
}
