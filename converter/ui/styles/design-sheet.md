# Design sheet — live prototype tokens

This is a catalog of the renderer’s **live** `:root` (the prototype block) and
the **second** dark theme (`#000` / `#006efe` / Geist). It is not a new brand
and it does not introduce tokens.

Computed style is the spec. Convert, Creator, and Editor stay three dialects.
Do not collapse type scales or button families to match this sheet.

Stylesheet load order (do not reorder):

```text
tokens → motion → shell → convert → inspector → overlays
→ components → base → settings → editor → creator
```

`base.css` winning over `shell.css` is part of the look.

## Light (live `:root`)

| Token | Value |
| --- | --- |
| `--bg` | `#f2f2f4` |
| `--surface` / `--raised` | `#ffffff` |
| `--page` | `#e8e6e1` |
| `--quiet` / `--quiet2` / `--quiet3` | `rgba(60,60,67,.055 / .10 / .15)` |
| `--sep` / `--sep2` | `rgba(60,60,67,.13 / .24)` |
| `--t1` | `#1d1d1f` |
| `--t2` / `--t3` / `--t4` | `rgba(60,60,67,.72 / .52 / .34)` |
| `--acc` / `--acc-h` / `--acc-text` | `#0b6bcb` / `#0a5fb5` / `#0b6bcb` |
| `--acc-tint` / `--acc-tint2` | `rgba(11,107,203,.10 / .18)` |
| `--ok` / `--ok-t` | `#2f9e57` / `#1a7a41` |
| `--warn` / `--warn-t` | `#e08600` / `#8a5300` |
| `--dang` / `--dang-t` | `#e0483e` / `#b3261e` |
| `--ui` | system UI stack (not Inter) |
| `--mono` | IBM Plex Mono stack |
| `--text-xs/sm/base/2xl` | `11 / 12 / 13 / 25px` |
| `--radius-xs/nav/card/pill` | `5 / 8 / 14 / 999px` |
| `--tracking` | `-.018em` |
| motion | `--d-quick` 150ms … `--d-vslow` 500ms, `--d-stagger` 50ms |
| `--ease-inout` | `cubic-bezier(.4,0,.2,1)` (folded from the dead first block; used by `.go`) |
| `--ring` | `0 0 0 3px var(--blue-100)` (folded; used by inspector/overlay focus) |

Compatibility aliases (`--accent` → `--acc`, `--text-primary` → `--t1`,
`--font-sans` → `--ui`, `--blue-100` → `--acc-tint2`, …) are listed in
`tokens.css` and must keep the same resolved values.

## Dark (live `[data-theme="dark"]`)

The first dark block (`#131315` / `#2b7fff`, `--surface-inverse:#1f2024`) is
dead. Live dark:

| Token | Value |
| --- | --- |
| `--bg` / `--surface` / `--raised` / `--page` | `#000000` |
| `--t1` | `#ededed` |
| `--acc` / `--acc-h` / `--acc-text` | `#006efe` / `#2b80ff` / `#006efe` |
| `--ui` | Geist, then Inter, then system |
| `--mono` | Geist Mono stack |

`--ring` is not redefined in dark; it follows `--blue-100` → `--acc-tint2`.

## What this sheet does not unify

- Convert `.btn` / `.u-add` vs Editor/Creator `.pbtn` vs inspector `.action`
- Settings `.sw` (38×22) vs inspector `.switch` vs Creator’s inline 30×18 toggle
- Convert 12.5px row type vs Settings 12.5/11.5 vs Editor 17px `.wk-h1` vs empty 25px
- `.press` token timing vs Creator’s 150/120ms override
- Inline `style=` typography on Creator/Editor

Those stay as three handoffs. See `docs/ui-primitives.md` for the wrap API.
