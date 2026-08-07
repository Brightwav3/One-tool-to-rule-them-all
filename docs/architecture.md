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
| 8 | `legacy/monolith.js` reaches zero and is deleted | |
| B | Design system: split `app.css`, apply tokens, unify components | not started |

Phase 1 split `app.css` as one file on purpose. Splitting it into the eleven
stylesheets above is where cascade order and specificity bite, so it belongs in
phase B with the screenshots as the check — not in the structural phase.

Editor is last in phase 4 because it is the most coupled.
