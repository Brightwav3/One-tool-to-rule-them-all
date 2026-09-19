# UI primitives

Classic `<script>` helpers in `converter/ui/components/primitives.js`. They wrap
**existing** class names. They do not restyle Convert, Creator, or Editor to
match each other.

Load order: after `icon.js`, before the views. CSS `<link>` order is unchanged.

## Button families (do not unify)

| `family` | Classes emitted | Used on |
| --- | --- | --- |
| `btn` | `.btn` + `.btn-{variant}` + optional `.btn-sm` + `.press` | Convert foot, Settings, inspector history, sheet |
| `pbtn` | `.pbtn` + `.pri` / `.gh` + `.press` + optional `.off` | Editor, Creator |
| `u-add` | `.u-add.press` | Convert “Add files” (third primary; keep the literal in `convert-view.js`) |
| `u-sort` | `.u-sort.press` | Convert sort |
| `go` | `.btn.btn-primary.press.go` | Convert action (via `OneToolActionState.actionButtonClass`) |
| `action` | `.action` + `.apply` / `.revert` | Inspector canvas foot |
| `tool` | `.tool.press` | Editor rail |

`.btn-sm` and `.btn-ghost` have **no CSS rules**. They stay class names only;
adding padding/colour would change computed style.

## Chip families (do not unify)

`u-chip`, `u-pill`, `pchip`, `set-chip`, `badge`, `pill` — `chipHtml({ family })`.

## Switch families (do not unify)

| `family` | Geometry | Surface |
| --- | --- | --- |
| `sw` | 38×22, `data-on` | Settings |
| `switch` | 32×19, class `on` | Inspector |
| `cr-toggle` | inline 30×18 | Creator options |

## Fields, checks, segments, menus

- `fieldHtml({ family: 'field' })` → `.field` (inspector). Creator `.inp` is `inpHtml`.
- `checkHtml` → `.check.press` (Convert list).
- `segHtml` → `.pseg` (Editor/Creator). Same class, different `data-*`.
- `ctxItemHtml` → `.ctx-item` (context menu). `menuItemHtml` → Settings `.set-menu`.
- `optHtml` → `.opt` (route popover / sheet).

Existing helpers stay: `icon.js`, `file-row.js`, `dropdown.js`, `context-menu.js`,
`modal.js`, `empty-state.js`.

## Wiring rule

A view may call a primitive only when the emitted tag, class list, inline
`style=`, and `data-*` are equivalent to the previous template. Convert’s
`class="u-add press" data-act="add">Add files` and the other Convert
`data-act="…"` templates stay source literals because
`tests/test_ui_state.cjs` matches those strings. The helpers still exist for
those families; they are used from Settings / Editor / Creator / inspector /
sheet.
