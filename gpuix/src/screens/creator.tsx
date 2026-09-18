import { Button, Chip, Press, T, useTheme } from "../primitives"
import { CREATOR_FALLBACK, fmtSize } from "../format"
import { Foot } from "../shell"
import type { CreatorFormat, CreatorGroup, CreatorItem, Tool } from "../types"

const GROUP_ORDER = ["Comics", "Documents", "Archives", "Images", "Ebooks"]

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
  onQuery,
  onPick,
  onContinue,
  onBack,
  onAdd,
  onCreate,
}: {
  tools: Tool[]
  stage: "pick" | "build"
  query: string
  fmt: string
  items: CreatorItem[]
  creating: boolean
  onQuery: (value: string) => void
  onPick: (id: string) => void
  onContinue: () => void
  onBack: () => void
  onAdd: () => void
  onCreate: () => void
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

  if (stage === "build" && current) {
    return (
      <div style={{ flexGrow: 1, minHeight: 0, flexDirection: "column" }}>
        <div
          style={{
            flexShrink: 0,
            flexDirection: "row",
            alignItems: "center",
            gap: 11,
            paddingTop: 10,
            paddingBottom: 10,
            paddingLeft: 18,
            paddingRight: 18,
            borderBottomWidth: 1,
            borderColor: theme.sep,
            backgroundColor: theme.accTint,
          }}
        >
          <Tile label={current.id} accent />
          <T size="md" weight={600} color={theme.accText}>
            {`Making a ${current.title}`}
          </T>
          <div style={{ flexGrow: 1, minWidth: 0 }}>
            <T size="sm" color={theme.accText}>
              {current.desc}
            </T>
          </div>
          <Button label="Change" variant="ghost" size="sm" onClick={onBack} />
        </div>
        <div style={{ flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 13, paddingBottom: 11, paddingLeft: 18, paddingRight: 18 }}>
          <div style={{ flexGrow: 1, minWidth: 0 }}>
            <T size="title" weight={600}>
              Contents
            </T>
            <T color={theme.t2} size="md">
              {`${items.length} items · ${current.unit.toLowerCase()}`}
            </T>
          </div>
          <Button label="Add items" variant="primary" onClick={onAdd} />
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
            overflow: "scroll",
          }}
        >
          {items.length === 0 ? (
            <div style={{ paddingTop: 52, alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 14,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: theme.quiet,
                  borderWidth: 1,
                  borderColor: theme.sep,
                }}
              >
                <T color={theme.t3} size="sm" weight={600} mono>
                  {current.id}
                </T>
              </div>
              <T color={theme.t3} size="md">
                Add items from disk. Creator needs a real path.
              </T>
            </div>
          ) : (
            items.map((item, index) => (
              <div
                key={item.id}
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
                }}
              >
                <T color={theme.t3} size="xs" mono>
                  {String(index + 1).padStart(2, "0")}
                </T>
                <div style={{ flexGrow: 1, minWidth: 0 }}>
                  <T size="md" weight={600}>
                    {item.name}
                  </T>
                </div>
                <T color={theme.t2} size="xs" mono>
                  {fmtSize(item.size)}
                </T>
              </div>
            ))
          )}
        </div>
        <Foot
          summary={items.length ? `${items.length} ready to pack` : "Nothing to create yet"}
          trailing={<Button label="Create" variant="primary" disabled={!items.length || creating} busy={creating} onClick={onCreate} />}
        />
      </div>
    )
  }

  return (
    <div style={{ flexGrow: 1, minHeight: 0, flexDirection: "column" }}>
      <div
        style={{
          flexShrink: 0,
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 12,
          paddingTop: 16,
          paddingBottom: 13,
          paddingLeft: 20,
          paddingRight: 20,
          borderBottomWidth: 1,
          borderColor: theme.sep,
        }}
      >
        <div style={{ flexGrow: 1, minWidth: 0 }}>
          <T size="title" weight={600}>
            What are you making?
          </T>
          <T color={theme.t2} size="md">
            Pick a container. Everything after that depends on it.
          </T>
        </div>
        <div
          style={{
            width: 210,
            minHeight: 29,
            paddingLeft: 9,
            paddingRight: 9,
            borderRadius: 7,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            borderWidth: 1,
            borderColor: theme.sep2,
          }}
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
      <div style={{ flexGrow: 1, minHeight: 0, overflow: "scroll", paddingTop: 14, paddingLeft: 20, paddingRight: 20 }}>
        {visible.map((group) => (
          <div key={group.name} style={{ paddingBottom: 16, gap: 10 }}>
            <div style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <T color={theme.t3} size="xs" weight={600}>
                {group.name.toUpperCase()}
              </T>
              <T color={theme.t4} size="xs" mono>
                {group.items.length}
              </T>
              <div style={{ flexGrow: 1, height: 1, backgroundColor: theme.sep }} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: 4, gap: 8 }}>
              {group.items.map((item) => {
                const on = item.id === fmt
                return (
                  <Press
                    key={item.id}
                    onClick={() => onPick(item.id)}
                    style={{
                      paddingTop: 12,
                      paddingBottom: 12,
                      paddingLeft: 13,
                      paddingRight: 13,
                      borderRadius: 11,
                      gap: 5,
                      backgroundColor: on ? theme.accTint : "transparent",
                      borderWidth: 1,
                      borderColor: on ? theme.accTint2 : theme.sep2,
                      hover: { backgroundColor: on ? theme.accTint : theme.quiet },
                      opacity: item.dis ? 0.45 : 1,
                    }}
                  >
                    <div style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Tile label={item.id} accent={on} />
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

function Tile({ label, accent }: { label: string; accent?: boolean }) {
  const theme = useTheme()
  return (
    <div
      style={{
        width: 22,
        height: 27,
        borderRadius: 4,
        alignItems: "flex-end",
        justifyContent: "center",
        paddingBottom: 3,
        backgroundColor: accent ? theme.acc : theme.quiet2,
        borderWidth: accent ? 0 : 1,
        borderColor: accent ? undefined : theme.sep,
        flexShrink: 0,
      }}
    >
      <T color={accent ? theme.inverse : theme.t3} size={7} weight={600} mono>
        {label}
      </T>
    </div>
  )
}
