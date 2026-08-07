# Decomposing a 3544-line file without rewriting a single line

One Tool's UI lived in one file. `converter/ui/index.html` held the markup, 1145
lines of CSS and a 2300-line inline `<script>` — 3544 lines that had to be
scrolled past to change anything. It is now 122 lines that link 11 stylesheets
and load 38 scripts.

The interesting part is not the destination. It is that no line of application
code was rewritten to get there, and that this was provable rather than merely
claimed.

## The constraint that made it work

The instruction going in was blunt: *move the part, don't rewrite it, don't lose
any code.* My first read of that was pessimistic. Extracted files would load
before the remaining monolith, so anything the monolith ran at top level — every
`addEventListener`, the bootstrap fetch, the whole action router — looked stuck
in place. That was about 60% of the file. I assumed a bridge layer would be
needed to hold the two halves together while they were separated.

That assumption was wrong, and the correction reframed the whole project:

> Classic `<script src>` tags, concatenated in order, are equivalent to one
> script. Same global lexical environment, same top-level execution order.

So any contiguous range can leave the file losslessly, as long as the tags
reproduce the original concatenation order. Ranges from the head load *before*
the remaining monolith. Ranges from the tail load *after* it. There is no
"before" restriction at all — there is only order.

The bridge layer evaporated. So did the rewrite. The same equivalence applies to
`<link>` stylesheets, which is why splitting 1145 lines of CSS into 11 files
could not change the cascade: concatenated stylesheets in order are one
stylesheet.

Two consequences fall out, and both are constraints for later:

- **No `type="module"`.** Modules would isolate every file and break every
  cross-file reference. That switch is one flag-day at the very end.
- **Link order follows position in the original file, not the tidy diagram.**
  `motion.css` is linked third, not last, because it sat at line 128. Two
  filenames are a stretch for what they hold — `components.css` is really the
  shared context menus, `base.css` is really the window geometry — and they were
  named for the target tree rather than renamed to fit. Honest labels beat
  pretty ones when the alternative is a rename hiding inside a move.

## The oracle

"I moved it carefully" is not evidence. So every extraction commit reassembled
the source file from its pieces and diffed it byte for byte against the previous
commit. Not byte-identical, no commit.

This is the best kind of test: it cannot be argued with, it needs no judgement,
and it costs nothing to run. It caught the whole class of error that matters
here — a lost line, a duplicated line, a range that moved but left something
behind. 19 commits landed under it. Zero regressions escaped.

The one failure mode a pure relocation *can* introduce is a temporal dead zone:
code that now runs before something it reads is defined. That throws loudly at
load rather than misbehaving quietly, which makes it the good kind of bug, but
it was still guarded — no range moved if it contained a column-zero
`document.` or `window.` statement.

That guard was originally written as `^\s*(document|window)\s*\.`, and it fired
on a range that was obviously fine: the match was an indented statement *inside*
`render()`'s body, not top-level execution at all. The temptation was to
override it and move on. I tightened it to column zero instead, because **a
guard that cries wolf gets overridden by habit, and then it is worthless when it
is right.**

## When the free oracle runs out

Byte identity is perfect and finite. The moment the work stops being relocation
— typed errors, controllers, an event bus — bytes change by definition and the
oracle is gone.

So it was replaced before it was needed, while the two builds were still
provably identical and a recording could be trusted. A controller refactor does
not change *what* the app does, only how it is wired. So record what it does.

A fixed 21-step script drives both builds and captures:

| Recorded | Catches |
|---|---|
| every request, ordered, with body | a stray call, a lost call, a reordered pair |
| every toast, with ok/error | a swallowed error, a duplicated message |
| render passes per step | the classic event-bus bug, firing twice |
| current page per step | navigation that silently stopped working |
| final structure hash | markup that changed shape |
| final computed-style hash | 35 resolved CSS properties on every element |

Two things are deliberately excluded. The 700 ms state poll is recorded as a
boolean, never as an ordered request — how many times it has fired by the end of
a run depends on machine speed, not on behaviour, and a test that fails on a
fast laptop teaches everyone to ignore it. Destructive actions are absent
entirely: converting and installing spend real time and touch real files.

**And the rig was tested.** A checker that always reports "same" is worse than
no checker, because it manufactures confidence. Three faults were injected into
a copy of the recorded baseline — a duplicated render pass, a stray
`POST /api/convert`, a changed style hash. It caught all three, named the first
differing step rather than dumping JSON, and exited non-zero.

## Three things that looked like disasters and weren't

**The DOM diverged by 250 elements.** Baseline reported 648 elements, the
refactored build 398. For a few minutes that looked like the refactor had
destroyed a view. The two servers keep separate queues, and the baseline
happened to have two files sitting in its. Clearing both made the counts match
exactly. `POST /api/clear` to both servers is now a mandatory step before any
comparison — an unequal fixture makes the DOM differ for reasons that have
nothing to do with the code.

**The action sweep hung forever.** One action reaches a hidden
`<input type="file">` and clicks it, which opens a native dialog that nothing in
an automated run will ever dismiss. The fix was to suppress `.click()` on file
inputs for the duration — the handler still runs, only the dialog does not open.

**"I don't think converting works."** The honest answer was that I did not know.
Rather than guess, I syntax-checked every module and served the build looking
for load errors, and found none. It turned out conversion had worked and had
simply taken longer than expected. Two console messages that came up alongside
it — an Electron CSP development warning and a `navigator.vibrate` intervention
notice — were pre-existing and benign, and saying so was more useful than
"fixing" them.

## The first change that wasn't a move

With the file decomposed, the first real edit was chosen to be the smallest one
available. The editor built ids for its edit log like this:

```js
{id: state.edits.length + Date.now(), text}
```

That is two unrelated ideas added together: a clock that can repeat inside a
single millisecond, and a length that *shrinks* when the list is capped at six.
It did not collide in practice. Nothing made that true. A counter is unique by
construction.

The trace came back identical — and that is precisely where it would have been
easy to over-read the result. **The script never reaches `log()`.** An identical
trace only proves the code the script touches. So the change was verified
directly in the running app instead: three edits, ids `edit-1` through
`edit-3`, all distinct.

Knowing the shape of your test's blind spot is worth more than the green tick.
The current set is written down: one viewport, so `@media` branches are unseen;
no `window.appWindow` in a plain browser, so file pickers and window controls
are unreachable; and 17 baseline screenshots that automation cannot compare for
me.

## What it cost, what it bought

24 commits. 78 files. The monolith reached zero and was deleted.

The layout is now boring in the way that good structure is boring:

```
converter/ui/
  index.html         shell only
  styles/            11 stylesheets
  app/               bootstrap, context, state, render
  core/              api-client, actions, capabilities, formatters, ids
  workspaces/        convert/, creator/, editor/
  features/          settings, inspector, command-palette, notifications
  components/        icon, modal, dropdown, file-row, empty-state, context-menu
  interaction/       action-router, keyboard, drag-drop, selection, resize
```

The refactor bought the thing every refactor is supposed to buy and rarely does:
the next change is now smaller than the last one. The regex that decides control
flow by matching English error prose —

```js
/isn.t installed|needs|helper/i.test(f.errorTitle || f.error || '')
```

— is now one identifiable line in one small file, and replacing it is a
contained job instead of an archaeology expedition.

## The transferable part

Three things, in order of how often I see them skipped:

1. **Find the equivalence that makes the move safe, then exploit it ruthlessly.**
   Ordered concatenation was the whole project. Everything else was bookkeeping.
2. **Build the next oracle before the current one expires**, while the two
   builds are still provably identical and a recording can be trusted. A
   behavioural baseline recorded after the first risky change is worthless.
3. **Test the test.** Inject faults. A checker you have never seen fail is a
   checker you have no reason to believe.

And the small one that is really a discipline: when a guard fires and you think
it is wrong, fix the guard. Do not override it. The next time it fires, you will
not be paying attention.
