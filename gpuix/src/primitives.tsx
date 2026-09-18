import { createContext, useContext, type ReactNode } from "react"
import type { StyleDesc } from "@gpuix/react"
import { cover, drop, TYPE, type Theme } from "./theme"

const ThemeCtx = createContext<Theme | null>(null)

export function ThemeProvider({ theme, children }: { theme: Theme; children: ReactNode }) {
  return <ThemeCtx.Provider value={theme}>{children}</ThemeCtx.Provider>
}

export function useTheme(): Theme {
  const theme = useContext(ThemeCtx)
  if (!theme) throw new Error("useTheme requires ThemeProvider")
  return theme
}

/** GPUIX ignores flexDirection unless display is flex. Default axis is column. */
export function row(style: StyleDesc = {}): StyleDesc {
  return { display: "flex", flexDirection: "row", alignItems: "center", ...style }
}

export function col(style: StyleDesc = {}): StyleDesc {
  return { display: "flex", flexDirection: "column", ...style }
}

export function T({
  children,
  color,
  size = "md",
  weight = 400,
  mono,
  align,
  style,
}: {
  children: string | number
  color?: string
  size?: keyof typeof TYPE | number
  weight?: number
  mono?: boolean
  align?: "left" | "center" | "right"
  style?: StyleDesc
}) {
  const theme = useTheme()
  const fontSize = typeof size === "number" ? size : theme.type[size]
  return (
    <text
      style={{
        color: color ?? theme.t1,
        fontSize,
        fontWeight: weight,
        fontFamily: mono ? theme.mono : theme.font,
        textAlign: align,
        ...style,
      }}
    >
      {String(children)}
    </text>
  )
}

export function Press({
  children,
  onClick,
  disabled,
  testId,
  style,
}: {
  children?: ReactNode
  onClick?: () => void
  disabled?: boolean
  testId?: string
  style?: StyleDesc
}) {
  return (
    <div
      testId={testId}
      onClick={disabled ? undefined : onClick}
      style={{
        display: "flex",
        flexDirection: "row",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "quiet"
export type ButtonSize = "sm" | "md"

/** One button family. Electron’s `.btn` / `.pbtn` / `.u-add` / `.action` collapse here. */
export function Button({
  label,
  kbd,
  variant = "secondary",
  size = "md",
  disabled,
  busy,
  onClick,
  testId,
}: {
  label: string
  kbd?: string
  variant?: ButtonVariant
  size?: ButtonSize
  disabled?: boolean
  busy?: boolean
  onClick?: () => void
  testId?: string
}) {
  const theme = useTheme()
  const height = size === "sm" ? 26 : 28
  const pad = size === "sm" ? 9 : 12
  const fontSize = size === "sm" ? theme.type.xs : theme.type.sm
  let backgroundColor = "transparent"
  let color = theme.t2
  let hoverBg: string | undefined = theme.quiet
  let borderColor: string | undefined = theme.sep2
  let borderWidth = 1

  if (variant === "primary") {
    backgroundColor = disabled && !busy ? theme.quiet3 : theme.acc
    color = disabled && !busy ? theme.t4 : theme.inverse
    hoverBg = disabled ? undefined : theme.accH
    borderWidth = 0
    borderColor = undefined
  } else if (variant === "ghost") {
    borderWidth = 0
    borderColor = undefined
    color = theme.accText
    hoverBg = theme.accTint
  } else if (variant === "danger") {
    backgroundColor = theme.dangTint
    color = theme.dangT
    borderColor = "rgba(224,72,62,0.28)"
    hoverBg = theme.dangTint
  } else if (variant === "quiet") {
    backgroundColor = theme.quiet
    borderColor = theme.sep
    color = theme.t2
  }

  return (
    <Press
      testId={testId}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "row",
        height,
        paddingLeft: pad,
        paddingRight: pad,
        borderRadius: theme.radius.control,
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        backgroundColor,
        borderWidth,
        borderColor,
        flexShrink: 0,
        hover: hoverBg ? { backgroundColor: hoverBg } : undefined,
      }}
    >
      <T color={color} size={fontSize} weight={600}>
        {busy ? "Working…" : label}
      </T>
      {kbd && !busy ? (
        <T color={variant === "primary" ? "rgba(255,255,255,0.72)" : theme.t3} size={theme.type.xs} weight={500} mono>
          {kbd}
        </T>
      ) : null}
    </Press>
  )
}

export type ChipVariant = "filter" | "pill" | "badge"

/** One chip family. Electron’s `.u-chip` / `.pchip` / `.set-chip` / `.badge` collapse here. */
export function Chip({
  label,
  count,
  variant = "filter",
  on,
  tone,
  onClick,
}: {
  label: string
  count?: number
  variant?: ChipVariant
  on?: boolean
  tone?: "ok" | "warn" | "acc"
  onClick?: () => void
}) {
  const theme = useTheme()
  const height = variant === "badge" ? 19 : variant === "pill" ? 22 : 26
  let backgroundColor = "transparent"
  let color = theme.t2
  let borderColor: string | undefined = theme.sep2
  let borderWidth = 1
  if (variant === "filter" && on) {
    backgroundColor = theme.accTint
    color = theme.accText
    borderWidth = 0
    borderColor = undefined
  }
  if (variant === "pill") {
    backgroundColor = theme.quiet2
    color = theme.t2
    borderWidth = 0
    borderColor = undefined
  }
  if (variant === "badge") {
    borderWidth = 0
    borderColor = undefined
    if (tone === "ok") {
      backgroundColor = theme.okTint
      color = theme.okT
    } else if (tone === "acc") {
      backgroundColor = theme.accTint
      color = theme.accText
    } else {
      backgroundColor = theme.warnTint
      color = theme.warnT
    }
  }
  return (
    <Press
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "row",
        height,
        paddingLeft: variant === "badge" ? 7 : 10,
        paddingRight: variant === "badge" ? 7 : 10,
        borderRadius: theme.radius.pill,
        alignItems: "center",
        gap: 6,
        backgroundColor,
        borderWidth,
        borderColor,
        flexShrink: 0,
        hover: onClick ? { backgroundColor: on ? theme.accTint : theme.quiet } : undefined,
      }}
    >
      <T color={color} size={variant === "badge" ? theme.type.xs : theme.type.sm} weight={on ? 600 : 500}>
        {label}
      </T>
      {count !== undefined ? (
        <T color={on ? theme.accText : theme.t3} size={10} weight={500} mono>
          {count}
        </T>
      ) : null}
    </Press>
  )
}

/** One switch. Electron’s `.sw` 38×22 / `.switch` 32×19 / Creator 30×18 collapse here. */
export function Switch({ on, onClick, label }: { on: boolean; onClick: () => void; label?: string }) {
  const theme = useTheme()
  const knob = (
    <Press
      onClick={onClick}
      style={row({
        width: 38,
        height: 22,
        borderRadius: theme.radius.pill,
        padding: 2,
        justifyContent: on ? "flex-end" : "flex-start",
        backgroundColor: on ? theme.acc : theme.sep2,
        flexShrink: 0,
      })}
    >
      <div
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          backgroundColor: "#ffffff",
          boxShadow: drop(1, 2, "rgba(0,0,0,0.22)"),
        }}
      />
    </Press>
  )
  if (!label) return knob
  return (
    <Press onClick={onClick} style={row({ gap: 10, minHeight: 29 })}>
      <div style={{ flexGrow: 1 }}>
        <T size="sm" weight={500}>
          {label}
        </T>
      </div>
      {knob}
    </Press>
  )
}

export function Tile({
  label,
  accent,
  width = 26,
  height = 32,
}: {
  label: string
  accent?: boolean
  width?: number
  height?: number
}) {
  const theme = useTheme()
  return (
    <div
      style={col({
        width,
        height,
        borderRadius: 4,
        alignItems: "center",
        justifyContent: "flex-end",
        paddingBottom: 3,
        flexShrink: 0,
        backgroundColor: accent ? theme.acc : theme.quiet2,
        borderWidth: accent ? 0 : 1,
        borderColor: accent ? undefined : theme.sep,
        overflow: "hidden",
      })}
    >
      <T color={accent ? theme.inverse : theme.t3} size={Math.max(6, Math.min(8, Math.round(width / 4)))} weight={600} mono>
        {label}
      </T>
    </div>
  )
}

export function Check({ on, onClick }: { on: boolean; onClick: () => void }) {
  const theme = useTheme()
  return (
    <Press
      onClick={onClick}
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: on ? theme.acc : "transparent",
        borderWidth: on ? 0 : 1,
        borderColor: on ? undefined : theme.sep2,
        flexShrink: 0,
      }}
    >
      <T color={on ? theme.inverse : theme.t3} size={10} weight={700}>
        {on ? "✓" : " "}
      </T>
    </Press>
  )
}

export function Field({
  label,
  value,
  placeholder,
  onChange,
  width,
}: {
  label?: string
  value: string
  placeholder?: string
  onChange: (value: string) => void
  width?: number
}) {
  const theme = useTheme()
  return (
    <div style={col({ gap: 5, width })}>
      {label ? (
        <T color={theme.t3} size="xs" weight={600}>
          {label}
        </T>
      ) : null}
      <div
        style={row({
          minHeight: 29,
          paddingLeft: 9,
          paddingRight: 9,
          borderRadius: 7,
          borderWidth: 1,
          borderColor: theme.sep2,
          backgroundColor: theme.raised,
        })}
      >
        <input
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.value ?? "")}
          theme={{ caret: theme.acc }}
          style={{ flexGrow: 1, fontSize: theme.type.sm, fontFamily: theme.font, color: theme.t1 }}
        />
      </div>
    </div>
  )
}

export function Segment({
  items,
  value,
  onChange,
}: {
  items: Array<{ id: string; label: string }>
  value: string
  onChange: (id: string) => void
}) {
  const theme = useTheme()
  return (
    <div
      style={row({
        gap: 2,
        padding: 2,
        borderRadius: theme.radius.control,
        backgroundColor: theme.quiet,
      })}
    >
      {items.map((item) => {
        const on = item.id === value
        return (
          <Press
            key={item.id}
            onClick={() => onChange(item.id)}
            style={{
              flexGrow: 1,
              minHeight: 24,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 6,
              backgroundColor: on ? theme.surface : "transparent",
              boxShadow: on ? drop(1, 2, "rgba(0,0,0,0.08)") : undefined,
            }}
          >
            <T size="xs" weight={on ? 600 : 500} color={on ? theme.t1 : theme.t2}>
              {item.label}
            </T>
          </Press>
        )
      })}
    </div>
  )
}

export function NavItem({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const theme = useTheme()
  return (
    <Press
      onClick={onClick}
      style={{
        minHeight: 26,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: theme.radius.pill,
        justifyContent: "center",
        flexShrink: 0,
        backgroundColor: active ? theme.acc : "transparent",
        hover: active ? { backgroundColor: theme.accH } : { backgroundColor: theme.quiet },
      }}
    >
      <T color={active ? theme.inverse : theme.t2} size="sm" weight={active ? 500 : 400}>
        {label}
      </T>
    </Press>
  )
}

/** Scrim + sibling panel so outside-click close does not need DOM stopPropagation. */
export function Overlay({
  onClose,
  children,
  align = "center",
  padTop,
}: {
  onClose: () => void
  children: ReactNode
  align?: "center" | "start"
  padTop?: number
}) {
  const theme = useTheme()
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        ...cover(),
        alignItems: align === "start" ? "flex-start" : "center",
        justifyContent: "center",
        paddingTop: padTop,
      }}
    >
      <div onClick={onClose} style={{ ...cover(), backgroundColor: theme.scrim }} />
      {children}
    </div>
  )
}

export function Kbd({ children }: { children: string }) {
  const theme = useTheme()
  return (
    <div
      style={{
        paddingLeft: 5,
        paddingRight: 5,
        paddingTop: 2,
        paddingBottom: 2,
        borderRadius: theme.radius.xs,
        backgroundColor: theme.quiet2,
        flexShrink: 0,
      }}
    >
      <T color={theme.t3} size="xs" weight={500} mono>
        {children}
      </T>
    </div>
  )
}
