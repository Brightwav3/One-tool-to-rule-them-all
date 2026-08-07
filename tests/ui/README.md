# Differential UI smoke test

Compares the refactored build against `ui-monolith-baseline` by running the
same harness on both and diffing the reports. A thrown error only counts as a
regression if it appears on the refactored side and not on the baseline — that
is what separates a real break from something that fails in a plain browser
because the Electron bridge (`window.appWindow`) is absent.

## Run it

```bash
git worktree add ../pdf-tool-baseline ui-monolith-baseline
```
```bash
cd ../pdf-tool-baseline/converter && python server.py --port 8898
```
```bash
cd converter && python server.py --port 8899
```

Copy `tests/ui/smoke.js` into each `converter/ui/` so the server can serve it,
open both ports, and in each console:

```js
const s = document.createElement('script'); s.src = '/smoke.js';
s.onload = async () => { window.report = await smoke(); }; document.head.appendChild(s);
```

Delete the copies from `converter/ui/` afterwards. The harness is not app code
and must not ship.

## Equalise state first

The two servers keep separate queues, so an unequal queue makes the DOM differ
for reasons that have nothing to do with the refactor. `POST /api/clear` to
both before comparing, and confirm `/api/state` reports the same
`files` / `historyCount` on each.

## What it measures

| | |
|---|---|
| boot | script count, `tools` loaded, body size |
| globals | `typeof` of 26 cross-file names, to catch a binding that failed to survive relocation |
| pages | every nav target reached, plus a structural fingerprint |
| actions | every `data-act` on every page clicked, errors attributed to the action that raised them |
| errors | `console.error`, `window.onerror`, `unhandledrejection` |

The fingerprint is tag name plus sorted class list for every element in the
body, in document order, excluding `<script>`. It ignores text and ids, so it
survives data changes but changes if the rendered structure changes.

Destructive actions are recorded as `skipped` rather than fired: converting,
creating, installing, removing, resetting. They would spend real time and touch
real files, and would make the two runs diverge for reasons unrelated to the
refactor.

## Result at 4bbeb0a (80 percent extracted)

Both builds, queues equalised to empty:

```
                      baseline (8 scripts)   refactored (28 scripts)
errors                0                      0
actions raised        0                      0
globals defined       26 / 26                26 / 26
```

Structural fingerprint, identical on all three pages:

```
convert  428 elements  e18432503b06c800
creator  453 elements  b86a1dcad20b4000
editor   452 elements  9ed5fc3252928000
```

Same element counts, same hashes. The rendered DOM is structurally identical
between the 3544-line monolith and the 22-file build.

## Known limit

The action sweep is stateful: clicking changes what is rendered, so a later
action may report `gone` on one run and `ok` on the other purely because the
runs drifted into different states. Compare the error counts and the
fingerprints, which are order-independent; treat per-action `gone` differences
as noise unless an error accompanies them.

A plain browser has no `window.appWindow`, so file pickers, reveal-in-folder
and the window controls cannot be exercised here at all. Those still need the
Electron window and the baseline screenshots in `docs/baseline/`.
