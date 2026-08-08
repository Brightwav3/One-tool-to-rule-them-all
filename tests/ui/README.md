# UI verification

Two harnesses. `trace.js` is the one that matters from here on.

---

# Golden trace — the oracle for phase B

Phase A had a free oracle: every commit reassembled into the previous file byte
for byte. Controllers, typed errors and an event bus all change bytes by
definition, so that oracle is gone.

This replaces it with **behavioural identity**. A controller refactor does not
change what the app does, only how it is wired — so record what it does and
compare:

| Recorded | Catches |
|---|---|
| every request, ordered, with body | a stray call, a lost call, a reordered pair |
| every toast, with ok/error | a swallowed error, a duplicated message |
| render passes per step | the classic event-bus bug, firing twice |
| current page per step | navigation that silently stopped working |
| final structure hash | markup that changed shape |
| final computed-style hash | 35 resolved CSS properties on every element |

## Run it

Serve the working tree (see the smoke section below for the server command),
clear its queue, then in the Electron renderer console:

```js
const s = document.createElement('script'); s.src = '/trace.js';
s.onload = async () => {
  console.log(JSON.stringify(await trace({
    fixturePath: 'C:/absolute/path/to/tests/fixtures/inherited-pages.pdf',
  })));
};
document.head.appendChild(s);
```

Run the golden trace in the Electron window, not a plain browser: the Editor
opens a real local path through its session bridge. Use the two-page fixture
above because the script deletes one page, then inserts a blank replacement.
The trace never calls Save, so the source fixture is only read. The legacy
monolith worktree remains covered by the differential smoke harness below; it
does not expose the FreeDF Editor session bridge needed by this trace.

Save each output, then:

```bash
node tests/ui/trace-diff.cjs tests/ui/traces/baseline.json tests/ui/traces/head.json
```

Exit 0 means behaviour-preserving. Exit 1 names the first differing step, which
is the one that caused the rest.

`tests/ui/traces/baseline.json` is the recorded FreeDF Editor baseline: 9
requests, 0 toasts, 57 render passes, 523 elements, structure
`238ec99f5a4b2a00`, computed `199440d0cc893000`. Session and page ids are
canonicalized by the harness so a second Electron run produces the same trace.

## The rig is tested

A checker that always reports "same" is worse than none, so the diff was run
against a copy with three faults injected — a duplicated render pass, a stray
`POST /api/convert`, and a changed computed-style hash. It caught all three and
exited 1. Re-do that if you ever change `trace-diff.cjs`.

## Two things it deliberately ignores

The 700ms state poll from `bootstrap.js` is recorded as a flag, never as an
ordered request: how many times it has fired by the end of a run depends on
machine speed, not on behaviour. And destructive actions are absent from the
script for the same reason they are skipped in the smoke sweep.

Every wrapper is restored when the run ends, so a trace leaves the page as it
found it and two runs in one session cannot stack.

---

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
