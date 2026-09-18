/** One token module for the GPUIX client.
 *
 * Values come from the live prototype sheet (PR #2 design-sheet.md / tokens.css):
 * light `--bg/--acc/--t1`, dark #2 `#000` / `#006efe` / Geist.
 * Electron keeps three class families and a 11-file cascade; this client does not.
 *
 * Shadows are GPUI `BoxShadow` objects (one drop shadow). Hairlines are
 * `borderWidth` + `borderColor`, not CSS `inset` string shadows.
 */

export type ThemeName = "light" | "dark"

/** GPUI paints one drop shadow; keep the shape here so we do not depend on a non-exported type. */
export type DropShadow = {
  offsetX: number
  offsetY: number
  blurRadius: number
  spreadRadius: number
  color: string
}

export function cover(): { position: "absolute"; top: 0; right: 0; bottom: 0; left: 0 } {
  return { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }
}

export function drop(offsetY: number, blurRadius: number, color: string, spreadRadius = 0): DropShadow {
  return { offsetX: 0, offsetY, blurRadius, spreadRadius, color }
}

export const TYPE = {
  xs: 11,
  sm: 12,
  md: 13,
  title: 17,
  display: 25,
} as const

export const SPACE = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
} as const

export const RADIUS = {
  xs: 5,
  control: 8,
  card: 14,
  pill: 999,
} as const

export type Theme = {
  name: ThemeName
  bg: string
  surface: string
  raised: string
  quiet: string
  quiet2: string
  quiet3: string
  sep: string
  sep2: string
  t1: string
  t2: string
  t3: string
  t4: string
  acc: string
  accH: string
  accText: string
  accTint: string
  accTint2: string
  ok: string
  okT: string
  okTint: string
  warn: string
  warnT: string
  warnTint: string
  dang: string
  dangT: string
  dangTint: string
  page: string
  inverse: string
  scrim: string
  paper: string
  ink: string
  font: string
  mono: string
  shadowCard: DropShadow
  shadowRaised: DropShadow
  shadowModal: DropShadow
  ring: DropShadow
  type: typeof TYPE
  space: typeof SPACE
  radius: typeof RADIUS
}

const LIGHT_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", "Helvetica Neue", Helvetica, sans-serif'
const LIGHT_MONO = '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace'
const DARK_FONT = 'Geist, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const DARK_MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Consolas, monospace'

export const LIGHT: Theme = {
  name: "light",
  bg: "#f2f2f4",
  surface: "#ffffff",
  raised: "#ffffff",
  quiet: "rgba(60,60,67,0.055)",
  quiet2: "rgba(60,60,67,0.10)",
  quiet3: "rgba(60,60,67,0.15)",
  sep: "rgba(60,60,67,0.13)",
  sep2: "rgba(60,60,67,0.24)",
  t1: "#1d1d1f",
  t2: "rgba(60,60,67,0.72)",
  t3: "rgba(60,60,67,0.52)",
  t4: "rgba(60,60,67,0.34)",
  acc: "#0b6bcb",
  accH: "#0a5fb5",
  accText: "#0b6bcb",
  accTint: "rgba(11,107,203,0.10)",
  accTint2: "rgba(11,107,203,0.18)",
  ok: "#2f9e57",
  okT: "#1a7a41",
  okTint: "rgba(47,158,87,0.12)",
  warn: "#e08600",
  warnT: "#8a5300",
  warnTint: "rgba(224,134,0,0.12)",
  dang: "#e0483e",
  dangT: "#b3261e",
  dangTint: "rgba(224,72,62,0.10)",
  page: "#e8e6e1",
  inverse: "#ffffff",
  scrim: "rgba(20,20,22,0.32)",
  paper: "#fdfdfd",
  ink: "rgba(60,60,67,0.16)",
  font: LIGHT_FONT,
  mono: LIGHT_MONO,
  shadowCard: drop(1, 2, "rgba(0,0,0,0.06)"),
  shadowRaised: drop(8, 22, "rgba(0,0,0,0.08)"),
  shadowModal: drop(24, 60, "rgba(0,0,0,0.16)"),
  ring: drop(0, 0, "rgba(11,107,203,0.18)", 3),
  type: TYPE,
  space: SPACE,
  radius: RADIUS,
}

export const DARK: Theme = {
  name: "dark",
  bg: "#000000",
  surface: "#000000",
  raised: "#000000",
  quiet: "rgba(237,237,237,0.06)",
  quiet2: "rgba(237,237,237,0.11)",
  quiet3: "rgba(237,237,237,0.16)",
  sep: "rgba(237,237,237,0.12)",
  sep2: "rgba(237,237,237,0.24)",
  t1: "#ededed",
  t2: "rgba(237,237,237,0.70)",
  t3: "rgba(237,237,237,0.50)",
  t4: "rgba(237,237,237,0.32)",
  acc: "#006efe",
  accH: "#2b80ff",
  accText: "#006efe",
  accTint: "rgba(0,110,254,0.18)",
  accTint2: "rgba(0,110,254,0.30)",
  ok: "#00ad3a",
  okT: "#2bd466",
  okTint: "rgba(0,173,58,0.16)",
  warn: "#ffad1f",
  warnT: "#ffc15c",
  warnTint: "rgba(255,173,31,0.16)",
  dang: "#f13342",
  dangT: "#ff6874",
  dangTint: "rgba(241,51,66,0.16)",
  page: "#000000",
  inverse: "#ffffff",
  scrim: "rgba(20,20,22,0.48)",
  paper: "#151517",
  ink: "rgba(237,237,237,0.18)",
  font: DARK_FONT,
  mono: DARK_MONO,
  shadowCard: drop(1, 2, "rgba(0,0,0,0.4)"),
  shadowRaised: drop(8, 22, "rgba(0,0,0,0.45)"),
  shadowModal: drop(24, 60, "rgba(0,0,0,0.55)"),
  ring: drop(0, 0, "rgba(0,110,254,0.30)", 3),
  type: TYPE,
  space: SPACE,
  radius: RADIUS,
}

export function themeOf(name: ThemeName): Theme {
  return name === "dark" ? DARK : LIGHT
}
