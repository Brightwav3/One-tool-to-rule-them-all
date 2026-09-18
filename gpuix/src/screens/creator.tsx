import { Button, Chip, Press, T, Tile, col, row, useTheme } from "../primitives"
import { CREATOR_FALLBACK, fmtSize } from "../format"
import { Foot } from "../shell"
import type { CreatorFormat, CreatorGroup, CreatorItem, Tool } from "../types"

const GROUP_ORDER = ["Comics", "Documents", "Archives", "Images", "Ebooks"]

const CREATOR_KINDS: Record<string, string> = {
  cbz: "Archive",
  cbr: "Archive",
  cb7: "Archive",
  zip: "Archive",
  "7z": "Archive",
  rar: "Archive",
  pdf: "Document",
  epub: "Document",
  docx: "Document",
  odt: "Document",
  png: "Image",
  jpg: "Image",
  jpeg: "Image",
  webp: "Image",
  tif: "Image",
  tiff: "Image",
  heic: "Image",
  txt: "Text",
  md: "Text",
}

function itemExt(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : ""
}

function itemKind(name: string): string {
  return CREATOR_KINDS[itemExt(name).toLowerCase()] || "File"
}

export function groupsFrom(tools: Tool[]): CreatorGroup[] {
  const containers = tools.filter((tool) => tool.multi)
  if (!containers.length) {
    return CREATOR_FALLBACK.map((group) => ({
      name: group.name,
      items: group.items.map((item) => ({
        id: item.id,
        title: item.title,
        desc: item.desc,
        unit: item.unit,
        opts: item.opts,
        needs: item.needs,
        dis: item.dis,
      })),
    }))
  }
  const byGroup = new Map<string, CreatorFormat[]>()
  for (const tool of containers) {
    const item: CreatorFormat = {
      id: tool.to,
      converter: tool.id,
      title: tool.to === "TGZ" ? "tar.gz" : tool.to,
      desc: tool.blurb || tool.sub || "",
      unit: tool.kind === "comic" || tool.kind === "image" ? "Pages" : "Files",
      opts: (tool.options || []).map((option) => option.key),
      needs: tool.state === "helper" ? tool.helper?.name : "",
      dis: tool.state === "soon",
    }
    const name = tool.cat || "Other"
    const list = byGroup.get(name) || []
    list.push(item)
    byGroup.set(name, list)
  }
  return [...byGroup.entries()]
    .sort((a, b) => (GROUP_ORDER.indexOf(a[0]) + 1 || 99) - (GROUP_ORDER.indexOf(b[0]) + 1 || 99))
    .map(([name, items]) => ({ name, items }))
}

export function CreatorScreen({
  tools,
  stage,
  query,
  fmt,
  items,
  creating,
  dest,
  onQuery,
  onPick,
  onContinue,
  onBack,
  onAdd,
  onCreate,
  onRemove,
  onMove,
}: {
  tools: Tool[]
  stage: "pick" | "build"
  query: string
  fmt: string
  items: CreatorItem[]
  creating: boolean
  dest?: string
  onQuery: (value: string) => void
  onPick: (id: string) => void
  onContinue: () => void
  onBack: () => void
  onAdd: () => void
  onCreate: () => void
  onRemove: (id: string) => void
  onMove: (id: string, delta: number) => void
}) {
  const theme = useTheme()
  const groups = groupsFrom(tools)
  const q = query.trim().toLowerCase()
  const visible = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !q || `${item.id} ${item.title} ${item.desc}`.toLowerCase().includes(q)),
    }))
    .filter((group) => group.items.length)
  const current = groups.flatMap((group) => group.items).find((item) => item.id === fmt) || groups[0]?.items[0]
  const addKbd = typeof process !== "undefined" && process.platform === "darwin" ? "⌘O" : "Ctrl O"
  const path = `${dest || "~/Converted"}/${current?.title || "Untitled"}.${(current?.id || "cbz").toLowerCase()}`

  if (stage === "build" && current) {
    return (
      <div style={col({ flexGrow: 1, minHeight: 0, width: "100%", backgroundColor: theme.surface })}>
        <div
          style={row({
            flexShrink: 0,
            gap: 11,
            paddingTop: 10,
            paddingBottom: 10,
            paddingLeft: 18,
            paddingRight: 18,
            borderBottomWidth: 1,
            borderColor: theme.sep,
            backgroundColor: theme.accTint,
            width: "100%",
          })}
        >
          <Tile label={current.id} accent width={24} height={30} />
          <T size="md" weight={600} color={theme.accText}>
            {`Making a ${current.title}`}
          </T>
          <div style={col({ flexGrow: 1, minWidth: 0 })}>
            <T size="sm" color={theme.accText}>
              {current.desc}
            </T>
          </div>
          <Button label="Change" variant="ghost" size="sm" onClick={onBack} />
        </div>
        <div style={row({ flexShrink: 0, gap: 12, paddingTop: 13, paddingBottom: 11, paddingLeft: 18, paddingRight: 18, width: "100%" })}>
          <div style={col({ flexGrow: 1, minWidth: 0 })}>
            <T size="title" weight={600}>
              Contents
            </T>
            <T color={theme.t2} size="md">
              {`${items.length} items · ${current.unit.toLowerCase()} · in the order below`}
            </T>
          </div>
          <Button label="Manual order ▾" variant="secondary" onClick={() => {}} />
          <Button label="Add items" kbd={addKbd} variant="primary" onClick={onAdd} />
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
            <Head w={52} label="Order" />
            <div style={{ width: 26, flexShrink: 0 }} />
            <Head flex label="Item" />
            <Head w={92} label="Kind" />
            <Head w={60} label={current.unit} right />
            <Head w={70} label="Size" right />
            <div style={{ width: 18, flexShrink: 0 }} />
          </div>
          <div style={col({ flexGrow: 1, minHeight: 0, overflow: "scroll", width: "100%" })}>
            {items.length === 0 ? (
              <div style={col({ paddingTop: 52, paddingBottom: 52, alignItems: "center", gap: 10 })}>
                <div
                  style={col({
                    width: 64,
                    height: 64,
                    borderRadius: 14,
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: theme.quiet,
                    borderWidth: 1,
                    borderColor: theme.sep,
                  })}
                >
                  <T color={theme.t3} size="sm" weight={600} mono>
                    {current.id}
                  </T>
                </div>
                <T size="md" weight={600}>
                  {`Nothing in this ${current.id} yet`}
                </T>
                <T color={theme.t2} size="md">
                  Add images, folders or existing archives. They go in the order you see here.
                </T>
                <Button label="Choose files" variant="primary" onClick={onAdd} />
              </div>
            ) : (
              items.map((item, index) => (
                <div
                  key={item.id}
                  style={row({
                    gap: 12,
                    paddingTop: 10,
                    paddingBottom: 10,
                    paddingLeft: 14,
                    paddingRight: 14,
                    borderBottomWidth: 1,
                    borderColor: theme.sep,
                    width: "100%",
                    hover: { backgroundColor: theme.quiet },
                  })}
                >
                  <div style={row({ width: 52, gap: 5, flexShrink: 0 })}>
                    <T color={theme.t3} size="xs" mono>
                      {String(index + 1)}
                    </T>
                    <div style={col({ gap: 1 })}>
                      <Press onClick={() => onMove(item.id, -1)} style={row({ width: 15, height: 11, justifyContent: "center", borderRadius: 3, backgroundColor: theme.quiet2 })}>
                        <T color={theme.t3} size={7}>
                          ▲
                        </T>
                      </Press>
                      <Press onClick={() => onMove(item.id, 1)} style={row({ width: 15, height: 11, justifyContent: "center", borderRadius: 3, backgroundColor: theme.quiet2 })}>
                        <T color={theme.t3} size={7}>
                          ▼
                        </T>
                      </Press>
                    </div>
                  </div>
                  <Tile label={itemExt(item.name) || current.id} />
                  <div style={col({ flexGrow: 1, minWidth: 0 })}>
                    <T size="md" weight={600}>
                      {item.name}
                    </T>
                  </div>
                  <div style={col({ width: 92, flexShrink: 0 })}>
                    <T color={theme.t2} size="xs" mono>
                      {itemKind(item.name)}
                    </T>
                  </div>
                  <div style={col({ width: 60, alignItems: "flex-end", flexShrink: 0 })}>
                    <T color={theme.t2} size="xs" align="right" mono>
                      {item.units ? String(item.units) : "—"}
                    </T>
                  </div>
                  <div style={col({ width: 70, alignItems: "flex-end", flexShrink: 0 })}>
                    <T color={theme.t2} size="xs" align="right" mono>
                      {fmtSize(item.size) || "—"}
                    </T>
                  </div>
                  <Press onClick={() => onRemove(item.id)} style={row({ width: 18, justifyContent: "center", flexShrink: 0 })}>
                    <T color={theme.t3} size="md">
                      ×
                    </T>
                  </Press>
                </div>
              ))
            )}
            {items.length ? (
              <Press onClick={onAdd} style={row({ gap: 10, paddingTop: 11, paddingBottom: 11, paddingLeft: 14, paddingRight: 14, width: "100%" })}>
                <div style={col({ flexGrow: 1 })}>
                  <T color={theme.t3} size="sm">
                    Drop more items here
                  </T>
                </div>
                <T color={theme.accText} size="sm" weight={600}>
                  Choose files
                </T>
              </Press>
            ) : null}
          </div>
        </div>
        <div
          style={row({
            flexShrink: 0,
            gap: 12,
            paddingTop: 10,
            paddingBottom: 10,
            paddingLeft: 18,
            paddingRight: 18,
            borderTopWidth: 1,
            borderColor: theme.sep,
            width: "100%",
          })}
        >
          <div style={col({ flexGrow: 1, minWidth: 0 })}>
            <T color={theme.t3} size="xs" mono>
              {path}
            </T>
          </div>
          <Button
            label={creating ? "Creating…" : "Create file"}
            kbd="⏎"
            variant="primary"
            disabled={!items.length || creating}
            busy={creating}
            onClick={onCreate}
          />
        </div>
      </div>
    )
  }

  return (
    <div style={col({ flexGrow: 1, minHeight: 0, width: "100%", backgroundColor: theme.surface })}>
      <div
        style={row({
          flexShrink: 0,
          alignItems: "flex-end",
          gap: 12,
          paddingTop: 16,
          paddingBottom: 13,
          paddingLeft: 20,
          paddingRight: 20,
          borderBottomWidth: 1,
          borderColor: theme.sep,
          width: "100%",
        })}
      >
        <div style={col({ flexGrow: 1, minWidth: 0 })}>
          <T size="title" weight={600}>
            What are you making?
          </T>
          <T color={theme.t2} size="md">
            Pick a container. Everything after that depends on it.
          </T>
        </div>
        <div
          style={row({
            width: 210,
            minHeight: 29,
            paddingLeft: 9,
            paddingRight: 9,
            borderRadius: 7,
            gap: 8,
            borderWidth: 1,
            borderColor: theme.sep2,
            backgroundColor: theme.raised,
            flexShrink: 0,
          })}
        >
          <T color={theme.t3} size="xs">
            ⌕
          </T>
          <input
            value={query}
            placeholder="Filter containers"
            onChange={(event) => onQuery(event.value ?? "")}
            theme={{ caret: theme.acc }}
            style={{ flexGrow: 1, fontSize: theme.type.sm, fontFamily: theme.font, color: theme.t1 }}
          />
        </div>
      </div>
      <div style={col({ flexGrow: 1, minHeight: 0, overflow: "scroll", paddingTop: 14, paddingLeft: 20, paddingRight: 20, paddingBottom: 8 })}>
        {visible.map((group) => (
          <div key={group.name} style={col({ paddingBottom: 16, gap: 10 })}>
            <div style={row({ gap: 10, width: "100%" })}>
              <T color={theme.t3} size="xs" weight={600}>
                {group.name.toUpperCase()}
              </T>
              <T color={theme.t4} size="xs" mono>
                {group.items.length}
              </T>
              <div style={{ flexGrow: 1, height: 1, backgroundColor: theme.sep }} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: 4, gap: 8, width: "100%" }}>
              {group.items.map((item) => {
                const on = item.id === fmt
                return (
                  <Press
                    key={item.id}
                    onClick={() => onPick(item.id)}
                    style={col({
                      paddingTop: 12,
                      paddingBottom: 12,
                      paddingLeft: 13,
                      paddingRight: 13,
                      borderRadius: 11,
                      gap: 5,
                      width: "100%",
                      backgroundColor: on ? theme.accTint : "transparent",
                      borderWidth: 1,
                      borderColor: on ? theme.accTint2 : theme.sep2,
                      hover: { backgroundColor: on ? theme.accTint : theme.quiet },
                      opacity: item.dis ? 0.45 : 1,
                    })}
                  >
                    <div style={row({ gap: 8 })}>
                      <Tile label={item.id} accent={on} width={22} height={27} />
                      <T size="md" weight={600} color={on ? theme.accText : theme.t1}>
                        {item.title}
                      </T>
                    </div>
                    <T size="xs" color={on ? theme.accText : theme.t3}>
                      {item.desc}
                    </T>
                    {item.needs ? <Chip label={`Needs ${item.needs}`} variant="badge" tone="warn" /> : null}
                  </Press>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      <Foot
        summary={`${current?.title || "Nothing"} selected · next you choose what goes in it`}
        trailing={<Button label="Continue" kbd="⏎" variant="primary" onClick={onContinue} />}
      />
    </div>
  )
}

function Head({ label, w, flex, right }: { label: string; w?: number; flex?: boolean; right?: boolean }) {
  const theme = useTheme()
  return (
    <div style={col({ width: w, flexGrow: flex ? 1 : 0, flexShrink: flex ? 1 : 0, alignItems: right ? "flex-end" : "flex-start", minWidth: 0 })}>
      <T color={theme.t3} size="xs" weight={600}>
        {label.toUpperCase()}
      </T>
    </div>
  )
}
