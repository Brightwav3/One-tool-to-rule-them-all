# Target architecture

Destination for the decomposition of `converter/ui/index.html`. Files appear
only when real code moves into them — this is a map, not a scaffold to fill.

## Rules that hold for every commit

1. **Move, never rewrite.** A block leaves the monolith byte-for-byte. Renaming,
   reformatting and "while I'm here" cleanups are separate commits, later.
2. **Proof, not judgement.** Every extraction commit reassembles the source file
   from its pieces and diffs it against the previous commit. If it is not
   byte-identical the commit does not happen.
3. **Classic scripts, global scope.** The sibling modules load as
   `<script src>` and talk through the global lexical environment. `type="module"`
   would isolate them and break every cross-file reference. That switch is one
   flag-day at the very end, after the last file is out.
4. **Load order is dependency order.** A file loads before `legacy/monolith.js`
   and after anything it reads. New `<script>` tags go directly above the
   monolith tag, in the order they were extracted.
5. **A function moves only when everything it calls has already moved** or was
   never in the monolith. That ordering constraint picks the sequence.
6. **DOM, class names and `data-act` values are frozen** for the whole
   structural phase. Design-system work is phase B and shares no commit with it.

## Tree

```text
converter/ui/
├── index.html                  shell only, no logic
├── styles/
│   ├── tokens.css              extracted names, no values applied yet
│   ├── base.css
│   ├── shell.css
│   ├── components.css
│   ├── convert.css
│   ├── creator.css
│   ├── editor.css
│   ├── settings.css
│   ├── inspector.css
│   ├── overlays.css
│   └── motion.css
├── app/
│   ├── bootstrap.js
│   ├── app-context.js
│   ├── app-state.js
│   ├── render.js
│   ├── navigation.js
│   └── lifecycle.js
├── core/
│   ├── api-client.js
│   ├── events.js
│   ├── actions.js
│   ├── capabilities.js
│   ├── formatters.js
│   ├── ids.js
│   └── errors.js
├── workspaces/
│   ├── convert/{convert-state,convert-view,convert-actions,convert-selectors,convert-controller}.js
│   ├── creator/{creator-state,creator-view,creator-actions,creator-controller,creator-bridge}.js
│   └── editor/{editor-state,editor-view,editor-actions,editor-controller,editor-bridge}.js
├── features/
│   ├── history/{history-view,history-actions}.js
│   ├── settings/{settings-view,settings-actions}.js
│   ├── inspector/{inspector-view,inspector-controller}.js
│   ├── command-palette/{palette-view,palette-actions}.js
│   └── notifications/toast.js
├── components/
│   ├── button.js
│   ├── file-row.js
│   ├── empty-state.js
│   ├── progress.js
│   ├── context-menu.js
│   ├── modal.js
│   ├── dropdown.js
│   └── icon.js
├── interaction/
│   ├── action-router.js
│   ├── keyboard.js
│   ├── drag-drop.js
│   ├── selection-state.js
│   ├── panel-resize.js
│   └── shortcut-labels.js
└── legacy/
    └── monolith.js             shrinks to zero, then is deleted
```

`legacy/` is temporary. Its size is the progress metric.

```text
3544  index.html at ui-monolith-baseline
2315  monolith.js after the inline <script> came out
2290  formatters, icons
2084  settings
1975  overlays, palette, toast
1793  convert/history list
1643  inspector
1403  creator
1121  editor
 969  context menu, drop wiring
```

Where it stops being mechanical: everything above moved function
declarations between files that share one global lexical environment, so
the only failure mode was a temporal dead zone during load - which throws
loudly. What is left in `legacy/monolith.js` is the part that can break
quietly: listener registration order, the 92-value action switch, and the
90 globals. Those are phase 5 proper and phase 6, and they want the
baseline screenshots as the check rather than a click-through.

## Phases

| Phase | Work | Status |
|---|---|---|
| 0 | Baseline: 17 screenshots, `ui-inventory.md`, tag `ui-monolith-baseline` | done |
| 1 | CSS out of `index.html` → `styles/app.css` | done |
| 2 | Inline `<script>` out → `legacy/monolith.js` | done |
| 3 | Leaves: formatters, icons | done |
| 4 | Views: settings, overlays, palette, toast, convert list, inspector, creator, editor | done |
| 5 | Action groups split out of the global handler (92 `data-act` values) | started |
| 6 | 90 globals → `app/app-state.js` behind bridge getters | |
| 7 | Controllers: separate state mutation, side effects, rendering | |
| 8 | `legacy/monolith.js` reaches zero and is deleted | done |
| B | Design system: apply tokens, unify components, split the action router | started |

## Phase B log

`core/ids.js` — first phase-B commit, deliberately the smallest one available.
One caller, `editor-state.js`'s `log()`, which built ids as
`state.edits.length + Date.now()`: a clock that can repeat inside a millisecond
added to a length that shrinks when the list is capped at six. It did not
collide in practice, but nothing made that true. A counter is unique by
construction.

The other two id schemes — `state.nextId` in the editor and in the creator —
were left alone. They number pages, marks and queue items, reset when their
state is rebuilt, and sit alongside ids that arrive with real data. Different
problem, and this commit was meant to be the warm-up, not the sweep.

The golden trace is identical, but the trace does not reach `log()`, so the
change was checked directly instead: three edits, ids `edit-1`..`edit-3`, all
distinct. Worth remembering that an identical trace only proves the code the
script touches.

The eleven stylesheets are done, and as a pure move rather than a rewrite.
`app.css` was already sectioned by top-level comments, and every section is a
contiguous range, so each file is one verbatim slice and the `<link>` tags keep
the original order. Concatenated stylesheets in order are identical to one
file, so the cascade cannot change — the same equivalence the scripts rely on.

That means `motion.css` is linked third rather than last: it sat at line 128 in
`app.css`, and link order follows position, not the order the tree lists. Two
names are a stretch for what they hold — `components.css` is the shared context
menus, and `base.css` is the window geometry block. Both were named for the
tree rather than renamed to fit.

Verified by computed style, not just structure: 35 properties on every element
across all three pages are byte-identical to `ui-monolith-baseline`.

Editor is last in phase 4 because it is the most coupled.
# Editor engine boundary and release tiers

Only `converter/pdf_engine.py` imports `pdfengine`. The vendored FreeDF distribution (`freedf`) lives in `converter/vendor/pdfengine`; the distribution/import name split is intentional. The development suite allows unavailable optional engine backends. Release runs set `ONETOOL_REQUIRE_ENGINE=1`, making an unavailable engine a failure. Poppler is required for Editor previews; Tesseract remains optional and OCR degrades with an explicit capability reason. The live Electron golden trace records 9 requests, 0 toasts, 57 renders, 0 errors, and a final 523-element editor DOM (`238ec99f5a4b2a00` structure, `199440d0cc893000` computed style).
