import { Button, T, col, row, useTheme } from "../primitives"
import { Foot } from "../shell"
import type { EditorSession } from "../types"

const GHOSTS = [0, 1, 2, 3, 4, 5, 6, 7]
const LINES = [
  { w: "72%", head: true },
  { w: "96%", head: false },
  { w: "88%", head: false },
  { w: "64%", head: false },
  { w: "81%", head: false },
  { w: "54%", head: false },
]

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
  const mac = typeof process !== "undefined" && process.platform === "darwin"

  return (
    <div style={col({ flexGrow: 1, minHeight: 0, width: "100%", backgroundColor: theme.surface })}>
      <div
        style={row({
          flexShrink: 0,
          gap: 12,
          paddingTop: 12,
          paddingBottom: 11,
          paddingLeft: 16,
          paddingRight: 16,
          borderBottomWidth: 1,
          borderColor: theme.sep,
          width: "100%",
        })}
      >
        <div style={col({ flexGrow: 1, minWidth: 0 })}>
          <T size="title" weight={600}>
            {session?.name || "No document open"}
          </T>
        </div>
        {session ? (
          <>
            <T color={theme.t3} size="sm">
              {`Click a page, then ${mac ? "⌃Space" : "Ctrl Space"} to open it`}
            </T>
            <Button label="Select all" variant="secondary" onClick={() => {}} />
            <Button label="Open another" variant="secondary" onClick={onOpen} />
          </>
        ) : (
          <Button label="Open a PDF" variant="primary" onClick={onOpen} />
        )}
      </div>
      <div style={col({ flexGrow: 1, minHeight: 0, overflow: "scroll", paddingTop: 16, paddingLeft: 18, paddingRight: 18, paddingBottom: 16, opacity: empty ? 0.35 : 1 })}>
        <div style={{ display: "grid", gridTemplateColumns: 6, gap: 16, width: "100%" }}>
          {pages.map((page, index) => (
            <div key={page.id} style={col({ alignItems: "center", gap: 6, width: "100%" })}>
              <div
                style={col({
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
                })}
              >
                {LINES.map((line, lineIndex) => (
                  <div
                    key={lineIndex}
                    style={{
                      height: line.head ? 5 : 3,
                      width: line.w,
                      borderRadius: 2,
                      backgroundColor: line.head ? theme.t4 : theme.ink,
                      flexShrink: 0,
                    }}
                  />
                ))}
              </div>
              <T color={theme.t3} size="xs" mono>
                {String(index + 1)}
              </T>
            </div>
          ))}
          {session ? (
            <div style={col({ alignItems: "center", gap: 6, width: "100%" })}>
              <div
                style={col({
                  width: "100%",
                  height: 148,
                  borderRadius: 3,
                  borderWidth: 2,
                  borderColor: theme.sep2,
                  alignItems: "center",
                  justifyContent: "center",
                })}
              >
                <T color={theme.t3} size={18}>
                  +
                </T>
              </div>
              <T color={theme.t3} size="xs" mono>
                Insert
              </T>
            </div>
          ) : null}
        </div>
      </div>
      {session ? (
        <Foot
          summary={`${session.pages.length} pages · no unsaved edits`}
          trailing={
            <div style={row({ gap: 8, flexShrink: 0 })}>
              <Button label="Revert" variant="ghost" disabled onClick={() => {}} />
              <Button label="Save a copy" variant="secondary" onClick={() => {}} />
              <Button label="Save" kbd={mac ? "⌘S" : "Ctrl S"} variant="primary" onClick={() => {}} />
            </div>
          }
        />
      ) : (
        <Foot summary="Open a PDF to edit its pages" />
      )}
    </div>
  )
}
