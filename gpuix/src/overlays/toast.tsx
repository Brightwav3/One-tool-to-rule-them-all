import { T, useTheme } from "../primitives"
import type { Toast as ToastData } from "../types"

export function Toast({ toast }: { toast: ToastData }) {
  const theme = useTheme()
  if (!toast) return null
  return (
    <div
      style={{
        position: "absolute",
        left: 20,
        bottom: 74,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: 12,
        borderRadius: theme.radius.control,
        backgroundColor: theme.surface,
        boxShadow: theme.shadowRaised,
      }}
    >
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: toast.ok ? theme.ok : theme.dang,
          flexShrink: 0,
        }}
      >
        <T color={theme.inverse} size="xs">
          {toast.ok ? "✓" : "!"}
        </T>
      </div>
      <div>
        <T size="sm" weight={500}>
          {toast.title}
        </T>
        {toast.sub ? (
          <T color={theme.t3} size="xs" mono>
            {toast.sub}
          </T>
        ) : null}
      </div>
    </div>
  )
}
