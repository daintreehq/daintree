# Component Contract

What to reach for when you build a surface, and which spelling is current when more than one exists. [theme-system.md](./theme-system.md) owns the palette → semantic token → component variable pipeline, [theme-tokens.md](./theme-tokens.md) is the full token reference, and [interaction-state-recipes.md](./interaction-state-recipes.md) holds the canonical class string per interactive role. This document owns the layer above those: which primitive, which vocabulary, which scale, and where the boundary sits between a component's styling and the app's.

Some of it is machine-checkable and some of it is judgement. The `component-contract` ESLint plugin lives in `scripts/eslint-rules/component-contract/`, is registered in `eslint.config.js` over `src/**` and the builtin plugin renderers, and backs five of the rules below — each section names its rule where one exists, and the rest are conventions you are expected to follow. See [Opting out](#opting-out) for the escape hatch and how the counts ratchet.

## Primitives

Check `src/components/ui/` before you hand-roll anything. A surface built from these inherits the dialog frame's focus trap, the palette's keyboard model and the toast router's placement logic for free, and none of those are cheap to rebuild correctly.

| Reach for | When |
| --- | --- |
| `AppDialog` | Any modal. It is the shared dialog frame — chrome, focus trap, dismissal and escape handling — and what surfaces like the worktree overview are built on. |
| `ConfirmDialog` | Any destructive confirmation. Pass `typedNameTarget` for a D3 catastrophic action to make the user type the target's name; see [destructive-action-safeguards.md](../architecture/destructive-action-safeguards.md) for the tiers. The `danger: "confirm"` marker lives on the action definition, not on this component. |
| `notify` with an `Undo` action | A small change the app can put back exactly: act at once, then offer Undo on a toast rather than a `ConfirmDialog`. Use `UNDO_TOAST_DURATION_MS` from `src/lib/undoToast.ts`; `notify()` makes an Undo toast urgent by default so quiet hours can't swallow it. See [Confirm or undo](../architecture/destructive-action-safeguards.md#confirm-or-undo). |
| `SearchablePalette`, `AppPaletteDialog`, `AppPalettePopover` | Anything list-and-filter. The palette family owns the arrow-key model, the active-descendant cursor and hover/keyboard reconciliation. |
| `popover`, `fixed-dropdown`, `dropdown-menu`, `context-menu`, `select`, `tooltip` | Layered surfaces. `fixed-dropdown` is the one that survives overlay-count races on cold start. |
| `button` | Any button. Its variant table is the accent budget in code — pick a variant rather than restyling a `ghost`. |
| `SegmentedRadioGroup`, `RadioChoiceGroup` / `RadioChoiceRow` | `SegmentedRadioGroup` is every single-choice mode switch, scope switch and range picker (radiogroup, one tab stop, arrows and Home/End, `compact` density for 32px chrome); `RadioChoice*` for option groups with descriptions. |
| `EmptyState` | An empty region. The `user-cleared` variant deliberately nulls its action so completed-work states stay quiet. |
| `Skeleton`, `Spinner` | Loading, under the 400ms Doherty gate in `CLAUDE.md` — skeleton when the layout shape is predictable, `Spinner` when it is not. |
| `field`, `input`, `textarea`, `checkbox`, `switch` | Any form control. `field` owns the label/description/error wiring and the `aria-describedby` and `aria-invalid` plumbing that hand-rolled forms get wrong. |
| `card`, `badge` | A bounded content block and its status pill. |
| `SurfaceHeader` | A panel or dialog header, at either density. |
| `Kbd`, `ShortcutHint`, `HighlightedText`, `TruncatedTooltip` | Chrome details that already exist and are easy to reinvent slightly differently. |
| `CopyButton`, `copyWithToast` | Anything that puts text on the clipboard. See [Copy feedback](#copy-feedback) for which one. |
| `ResizeHandle` + `useSplitterKeys` | Any draggable edge between two regions. The primitive owns the 12px target, the grip, the focus outline, the ARIA and the "(double-click to reset)" label suffix; the hook owns the keyboard contract. You own the drag. `src/config/__tests__/resizeHandle.contract.test.ts` fails on any `role="separator"` rendered anywhere else. |

New primitives belong in `src/components/ui/` only when a second caller appears. One-off composition stays with its feature.

## Pane chrome

A pane's title bar and status strip are one frame, and every pane, side panel and floating surface draws it the same way, so a grid pane, the assistant and the Review Hub line up when they sit side by side.

| Edge | Spelling | Rule |
| --- | --- | --- |
| Title bar | `SurfaceHeader density="compact"` | 32px (`h-8`), 12px inset (`px-3`), `border-b border-divider`. Title is `text-xs font-medium`. Actions are `Button ghost icon-xs` or `SurfaceHeaderCloseButton`, which both fit the 32px bar without negative margins. |
| Focused lift | `SURFACE_HEADER_FOCUS_LIFT_CLASS` | The bar of the pane the keyboard is in steps up one neutral overlay (`--panel-header-focus-bg`, falling back to `overlay-medium`). Never accent, never `surface-highlight`. `PanelHeader` and the assistant share the one string. |
| Status strip | `PANE_STATUS_FOOTER_CLASS` | `min-h-6`, `px-3`, `border-t border-divider`, `text-2xs text-text-secondary`. A strip whose items carry their own `px-1.5` hover chip insets by `px-1.5` instead, so the ink still lands on the 12px line. |

Three families sit outside this on purpose:

- **Dialog headers** use the comfortable density (`px-6 py-4 border-border-strong`), and a toolbar row directly under one keeps the dialog's `px-6` inset with a `border-divider` separator (Compare worktrees).
- **Full-window views** that cover the main toolbar (the plugin manager) take the toolbar's own chrome: `h-12 px-4 border-b border-divider`, with room for the traffic lights.
- **Bottom drawers** (the Dev Preview output drawer and the Diagnostics dock, #12948) keep their 32px strips on `border-overlay`, including the session-diagnostics strip inside the drawer.

Enforced by `src/components/ui/__tests__/surfaceHeaders.contract.test.ts`, which also holds the Review Hub to the same 12px inset for its section bands (`REVIEW_HUB_SECTION_BAND`).

## The colour vocabulary

Three vocabularies are live in the codebase. **The semantic tokens are the current one.** The other two are legacy and only shrink from here:

| Vocabulary | Shape | Uses | Status |
| --- | --- | --- | --- |
| Semantic tokens | `text-text-secondary`, `bg-surface-panel`, `border-border-default`, `text-status-error` | thousands, and growing | **Current.** The validated contract is 156 tokens; the full list is in [theme-tokens.md](./theme-tokens.md). |
| Legacy `daintree-*` aliases | `bg-daintree-accent/10`, `text-daintree-text/40` | hundreds, ratcheted down | Legacy. Five aliases over tokens that already have semantic names. Every solid use is gone (#12056), and #12065 took the text opacity ramp with it; what remains is the non-text alpha composites and a reviewed set of dim text carve-outs, which is the only reason the alias layer still has to generate. |
| shadcn defaults | `text-muted-foreground`, `bg-muted`, `bg-popover` | hundreds | Legacy. Arrived with the vendored shadcn primitives. Nearly all are theme-backed (`--muted` resolves to `--theme-surface-panel`), so they render correctly — they are simply a third name for tokens that already have one. |

The legacy count is the only one with an authoritative live number: `component-contract/no-legacy-daintree-utilities` in `scripts/baselines/eslint-warnings-baseline.json`, which can only fall. Read it there rather than trusting a figure in prose — that is the whole point of the ratchet. The other two rows are directional: semantic is several times the size of either legacy layer and is the one that grows.

The `daintree-*` layer is pure aliasing — `--color-daintree-text` is defined in `src/index.css` as nothing but `var(--theme-text-primary)`. Two names for one token means neither reads as canonical, and because the alias layer covers five tokens against the semantic layer's 156, anything outside those five has no legacy spelling at all. That is why single class strings today mix both vocabularies.

Migrate on the utility, keeping the prefix:

| Legacy | Current |
| --- | --- |
| `text-daintree-text` | `text-text-primary` |
| `bg-daintree-bg` | `bg-surface-canvas` |
| `bg-daintree-sidebar` | `bg-surface-sidebar` |
| `border-daintree-border` | `border-border-default` |
| `outline-daintree-accent`, `ring-daintree-accent` | `outline-accent-primary`, `ring-accent-primary` |

Two further aliases, `--color-daintree-accent-rgb` and `--color-daintree-focus`, were deleted once their last call sites went. The rule still maps them, deliberately: a utility naming an alias that no longer exists generates no CSS at all, which is a worse failure than the vocabulary mixing and worth catching by name rather than falling through to the generic message.

An alpha modifier carries across unchanged on surfaces and edges — `bg-daintree-accent/10` becomes `bg-accent-primary/10`. On a **text** colour it does not: the alpha has to go, and the step picks a solid role, per the next section. Both rules fire on that token, and both fixes are needed.

Enforced by `component-contract/no-legacy-daintree-utilities`. Reads of `var(--color-daintree-*)` inside an arbitrary value are deliberately not flagged — they are far rarer, and folding them in would double-count the same migration.

## Alpha on text

Never fade a text colour with slash-alpha. `text-text-secondary/70` compiles in Tailwind v4 to a solid declaration followed by a `@supports` block that replaces it with `color-mix(in oklab, var(--theme-text-secondary) 70%, transparent)` — the alpha lands on the `color` property itself, so the label is composited against whatever sits behind it and the contrast loss is baked in. An `opacity: 1` further down the tree cannot recover it. De-emphasise with a solid token one step down the hierarchy: `text-text-secondary`, then `text-text-muted`.

This has already cost real legibility. `src/index.css` carries a `[class*="text-daintree-text/"]` override inside the `prefers-contrast: more` block, forcing the solid token back, added to claw back what the pattern costs under macOS Increase Contrast. The rule exists so that override's surface area stops growing.

### The retired ramp

`text-daintree-text/NN` was that mistake at scale — a text hierarchy expressed through fifteen opacity steps across nearly two thousand sites. #12065 retired it against measured numbers rather than taste. `npm run theme:text-contrast` composites every step against every surface on all 15 themes; taking floor non-regression as the rule (a step may only adopt a role whose weakest measurement is no worse than the step's own) leaves three bands:

| Step        | Role                    | Step floor | Role floor |
| ----------- | ----------------------- | ---------- | ---------- |
| `/20`–`/35` | `text-text-placeholder` | 1.4–2.0:1  | 1.9:1      |
| `/45`–`/70` | `text-text-secondary`   | 2.5–4.6:1  | 5.0:1      |
| `/75`–`/90` | `text-text-primary`     | 5.3–7.1:1  | 8.4:1      |

Roughly 80% of the ramp collapses onto `text-text-secondary`. That is the finding, not a defect in the mapping: four text roles cannot carry fifteen steps, and the fine-grained hierarchy those sites looked like they were expressing was never perceptible — it already did not survive Increase Contrast.

**`text-muted` receives nothing.** Its floor is Lc 16.0 / 2.2:1 on namib's elevated panel, below the `/50` step it looks like it should absorb, and `getThemeContrastWarnings()` guards it on light themes only. Giving it a dark-mode floor is the prerequisite for putting it back in the vocabulary.

A few hundred painted sites stay dim on purpose, dominated by icon affordances and joined by decorative glyphs, deliberate disabled states the bands would have brightened, text already composited by an ancestor's `opacity-*`, prior-ruling carve-outs, and controls whose resting colour sits beside a state colour its band role would erase. Each is recorded with its category and a stated reason in `scripts/baselines/text-ramp-manifest.json`, generated by `npm run theme:text-ramp` — the manifest's own `total` and per-category counts are the live figures. A contract test fails on any ramp site the manifest does not name, and `npm run theme:text-ramp -- --check` re-runs the classifier to catch a carve-out that has stopped qualifying for the category it claims.

Alpha on surfaces and edges is fine and is not flagged — `bg-status-error/10` composites against a known background, and that ladder is the `overlay-*` design rather than debt.

Enforced by `component-contract/no-text-color-slash-alpha`, variant-prefixed forms included: a `hover:` fade fades the label exactly as hard as a base one, which is why the production override above matches on a substring. The font-size/line-height shorthand (`text-sm/6`, `text-[11px]/4`) is not an alpha and is not flagged; nor is `text-shadow-*`, whose modifier is a shadow alpha rather than the glyph colour.

## CVA or inline classes

`cva()` earns its place when a component has a **closed set of named variants that callers choose between**, and the variants differ in more than a class or two. `src/components/ui/button.tsx` is the canonical case: fifteen variants and seven sizes, where the variant name is the API and the class strings are an implementation detail. `SurfaceHeader` is the other, splitting two densities.

Everything else is `cn()`. A component with one appearance, or whose only variation is a boolean the parent already computes, does not need a variant table — a `cn("…", isActive && "…")` is clearer and shorter. Reaching for CVA to hold two states is how you get a variant table with one real variant in it.

The signal to convert is a component growing a third or fourth `isX && "…"` branch that callers are choosing between by prop. At that point name them.

Extract shared class strings the way `src/components/ui/paletteRowStyles.ts` does — one exported `cn()` constant, so five palettes cannot grow five spellings of the same row. The same file holds `LIST_DETAIL_ROW_CLASS` for every list-detail and file-list row: selection, a lighter hover and the open-menu ring keyed off the row's own attributes, so no site picks its selected fill with a ternary of its own.

## Action glyphs

An action that recurs across the app wears one glyph everywhere, so a user who has learned it once can read it anywhere. The three circular arrows are the ones that drift, because they look interchangeable at 14px; each means one thing:

| Glyph | Means | Labels it goes with |
| --- | --- | --- |
| `RefreshCw` | Do it again, or fetch it again. The thing stays what it was. | Retry, Try again, Refresh, Check again, Re-check, Re-scan, Fetch, Redraw |
| `RotateCw` | Reload a page, view or panel, or restart a process, session or server. | Reload, Reload preview, Reload from folder, Restart terminal, Restart dev server, Restart conversation, Auto-restart |
| `RotateCcw` | Go back to an earlier state. | Restore, Reset, Revert, Undo, Replay, Resume session |

Never `RotateCcw` for a retry or a restart: the counter-clockwise arrow promises the user they are going back, and a retry does not undo anything. A control with a busy state spins the same glyph through `SpinningIcon`, which only turns clockwise; that is one more reason restart is `RotateCw`.

The other concepts that had split:

| Concept | Glyph | Not |
| --- | --- | --- |
| Copy (a URL, a path, a link address) | `Copy`, swapping to `Check` for the copied beat | `Link` / `Link2`, which mean linking something (attach an issue, linked work) |
| Edit | `Pencil` | `Edit`, `Edit2`, `Edit3` (deprecated Lucide aliases) |
| Project settings | `Settings` | `Settings2`, which stays the General settings tab and the manage-presets rows |
| Worktree | `FolderGit2`, including worktree counts | `GitBranch`, which is a branch |
| Open project | `FolderOpen` | `Plus`, which is the launcher's "make a new thing" |
| Clone repository | `FolderDown`, beside Open project's `FolderOpen` and Create project's `FolderPlus` | `GitBranch`, `Download`, `FolderGit2` (a worktree) |

`src/config/__tests__/actionGlyphs.contract.test.ts` ties each of these icons to the label beside it (the holder's text or aria-label, an action object's `label`, or a row's `label` prop) and fails when the pair disagrees. A new concept takes the closest Lucide icon and joins the alias list in `src/components/icons/index.ts`.

## Scales

**Type.** Tailwind's stock `--text-*` steps; this repo overrides none of them. Arbitrary sizes (`text-[11px]`) are off the scale, invisible to it, and do not move when it moves — and because the values sit a pixel apart, 9px through 13px are all in use where the scale offers two steps. When a design genuinely needs a step the scale lacks, add a named step to the `@theme` block in `src/index.css` and use that — `--text-2xs` (11px), `--text-3xs` (10px) and `--text-4xs` (9px) are exactly that, added for the label sizes the stock scale skips, and `button`'s `xs` size now spells itself `text-3xs`. One list of legal sizes beats an open set of brackets. Enforced by `component-contract/no-arbitrary-text-size`; arbitrary _colours_ share the `text-[…]` spelling and are not flagged.

**Radius.** `--radius-xs` through `--radius-3xl`, all derived in `src/index.css` from one base: `--radius: calc(0.625rem * var(--theme-radius-scale, 1))`. A theme can therefore scale every corner in the app at once. Both `rounded-md` and `rounded-[var(--radius-md)]` are on the scale and resolve to the same value; the second is the codebase's prevailing spelling. `rounded-full` and `rounded-none` are shape decisions rather than points on a scale and stay legal.

Three spellings are not. An arbitrary radius that hardcodes a value — `rounded-[2px]`, `rounded-[0]`, `rounded-[calc(2px)]` — ignores `--theme-radius-scale`. So does a step above `3xl`, where this repo stops redefining and Tailwind's fixed `rounded-4xl` (2rem) takes over. And bare `rounded` is the subtle one: Tailwind documents it as 0.25rem and it reads that way, but the utility resolves through `--radius` — which this repo overrides — so it actually renders the `rounded-lg` value. Name the step you mean. Enforced by `component-contract/no-raw-radius`.

**Spacing.** Tailwind's stock scale, unmodified, so `p-2` and `gap-1.5` behave exactly as documented. `--height-xs|sm|md|lg` tokens exist in `src/index.css` for control heights, but nothing uses them yet — `button` still spells its sizes `h-6` through `h-9`. Treat them as available, not as an established convention.

## The focus ring

The split matters, because "it's wired globally" is true of one half and false of the other.

**App-level, do not restate:** the fallback ring, the transition and the accessibility floors. `*:focus-visible` in the base layer of `src/index.css` paints the canonical ring (`2px solid` accent, `+2px` offset) on anything that does not draw its own, so a raw control or a programmatically focused container never falls through to Chromium's blue auto ring; every component utility sits in a later layer and overrides it. The same rule declares `outline-color`, `outline-offset` and `box-shadow` transitions from `--focus-transition-duration` / `--focus-transition-easing`, and three more `*:focus-visible` blocks handle reduced motion, `forced-colors: active` (a `2px solid Highlight` outline, `!important`) and `prefers-contrast: more` (`outline-width: 3px`). Those are deliberately separate blocks, per the high-contrast dual-block rule in `CLAUDE.md`. Do not add per-element `outline-*` transitions on top. One caveat worth knowing: the transition rule sits in the `base` layer, so a component's own `transition` or `transition-colors` utility — which lives in `utilities` — overrides `transition-property` and drops part of it. The floors under `forced-colors` are `!important` and always hold.

**Component-owned:** a component that needs its ring anywhere else — inset, a documented neutral or status ink — says so with its own utilities. `button.tsx` shows the shape — `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2` plus the accent token. One mechanism, one width, one ink, two offsets: `outline`, never a `ring-*` box-shadow (forced-colors strips box-shadow); `2px`; accent, except the documented Radix-row, search-field, composer and status-action inks; `+2px` outside, or `-2px` inset when the element sits in a scroller, a packed group or an `overflow-hidden` host where an outside ring is clipped. `:focus-visible`, never `:focus`. `src/config/__tests__/focusRingRecipe.contract.test.ts` enforces all four, with a counted per-file allowlist for the documented exceptions.

**Never suppress without replacing.** `outline-hidden` with nothing painted in its place leaves the element focusable but invisibly so — it still takes keyboard focus, and nothing shows where that focus is. If focus genuinely belongs to a wrapper — a compound control painting one ring via `focus-within`, say — that is a real exception, but it needs to be written down at the site.

Use `outline-hidden`, never `outline-none`: v4 changed `outline-none` to emit a bare `outline-style: none`, dropping the transparent outline that keeps a focus indicator paintable in forced-colors mode. `outline-hidden` is the spelling that kept v3's behaviour.

Enforced twice, deliberately. `src/config/__tests__/focusRingFallback.contract.test.ts` is the hard gate: it fails the build, scans `src/**` plus the GitHub plugin renderer, keeps a 44-entry allowlist of the elements that legitimately delegate focus to a wrapper, and owns a second invariant the lint rule does not — `--tw-outline-style` does not inherit, so `outline-hidden` and `focus-visible:outline-2` on the same element resolve to nothing painted at all. `component-contract/no-unpaired-outline-suppression` is the editor-time mirror: same contract, reported on the line as you type, opted out with a comment rather than a central array. `src/config/__tests__/outlineHidden.contract.test.ts` bans `outline-none` across `src/**`.

The cost of running both is that a genuinely new exception has to be recorded in two places — an inline disable and an allowlist entry. Consolidating them onto one shared predicate is worth doing; it is not done yet.

## Copy feedback

Every copy is confirmed, in the word "Copied" (never "Copied!"), and a refused write is never silent: the user's next paste would be the old value. Which primitive depends on what is left on screen once the copy settles.

| Where the copy lives | Use | Success | Refusal |
| --- | --- | --- | --- |
| A menu row, a banner's overflow item — anything that closes on select | `copyWithToast(label, value)` in `src/lib/copyWithToast.ts` | Transient toast, `"{Label} copied"`, the value (or a stand-in such as the file name) as its body | Error toast `"Couldn't copy {label}"` with Retry, coalesced per value |
| An icon-only button | `CopyButton` with `aria-label` | Copy glyph swaps to a neutral check for `UI_ACTION_SUCCESS_DWELL_MS` | Announced assertively |
| A labelled button | `CopyButton` with `label` | The label reads "Copied" for the dwell | The label reads "Couldn't copy", announced assertively — or `onCopyError` when the surface already has an error line for it (a settings row's `error`), so the failure is stated once |
| A control that cannot be a button (a path pill, a banner action) | `useCopyWithFeedback` | The control's own swap, gated on `copiedText` | The control's own |

Rules that hold across all four:

- **One dwell.** `UI_ACTION_SUCCESS_DWELL_MS`, owned by the hook. Never a local timer or a literal.
- **One announcement.** The hook announces through the polite live region, or the toast's own region does. The accessible name stays constant — a name that flips to "Copied" under focus is announced a second time — and no surface keeps its own `role="status"` copy message beside it.
- **The confirmation belongs to the value.** A string payload is confirmed only while it is still the current one, so a re-pointed control never arrives confirmed. Where two items can carry identical text (two telemetry events), key the button by item.
- **A menu confirms with the toast, not its trigger.** Flipping a "More actions" glyph to a check was three surfaces' private channel for this and is retired.
- **Variant.** A labelled copy takes its context's grammar: `outline` `sm` on a settings row or rail, the group's variant inside a button group, and otherwise `ghost` `xs` beside the payload it copies. The label slot reserves the wider of the label and "Copied", so the button holds its width through the dwell.
- **Main-process clipboard.** Panes hosting a guest webview pass `write={(t) => window.electron.clipboard.writeText(t)}`, since the guest may hold focus.

`src/components/ui/__tests__/copyFeedback.contract.test.ts` bans "Copied!" and holds direct `clipboard.writeText` calls in UI code to a shrinking allowlist (terminal selection, actions, toast actions and a few reducer-owned surfaces). `iconActionButtons.contract.test.ts` holds icon-only copies to `CopyButton`.

## Wording

Copy follows `.claude/rules/user-signals.md`; these are the rules the consistency audit found broken in more than one place, and the ones the contract test pins.

- **Counts go through `pluralize`** (`src/lib/pluralize.ts`): `pluralize(n, "file")` is "1 file" or "1,204 files", with the locale's grouping. Irregular nouns and phrases whose verb agrees pass the plural form: `pluralize(n, "terminal is", "terminals are")`. `pluralNoun` returns the noun alone for a sentence that places the count itself. No local `plural()` copies and no hand-rolled `n === 1 ? "1 x" : \`${n} xs\`` — thirteen private copies had drifted, and a shared toast said "Copied 1 files".
- **Ellipsis is "…"**, one character, in placeholders ("Filter themes…"), progress ("Retrying (1/3)…"), menu items that open a further step ("More agents…") and truncations. A main-process progress message follows the same rule; a renderer that supplies its own progress punctuation strips a trailing "…" (or a legacy "...") before rendering. `SearchablePalette` derives its default `aria-label` the same way.
- **Sentence case** for titles, labels, group headings and pane titles: "Dev server", "CCR routes", "Set log level". An acronym stays upper case. The native OS menu bar is the one exception — it follows the platform's Title Case convention ("Check for Updates…"), and in-app text that quotes a menu item quotes it verbatim.
- **Trash vs Remove vs Delete.** "Trash X" is the soft delete with a way back (a terminal to the trash); "Remove X" is permanent, taking an item out of a list or collection for good (a recipe row, a preset); "Delete X" is the permanent delete of a thing on disk. Worktrees are deleted, single or bulk: "Delete worktree", "Delete 3 worktrees", "Deleted 3 worktrees".
- **"Open in external browser"** is the escape hatch from inside the in-app browser, dev preview and portal — toolbar button, pane context menu and tab menu alike — because "Open in browser" is ambiguous when you are already in one. An icon button's tooltip names the same thing as its `aria-label`.
- **Empty and status fragments take no period**: "No output captured", "No themes match your search".

`src/components/ui/__tests__/wording.contract.test.ts` scans `src`, `shared` and the main-process services for three-dot ellipses in copy (log calls excluded), local `plural*` helpers, the hand-rolled singular/plural conditional, Title Case menu group headings, and "Open in browser" inside the in-app browser surfaces.

## Opting out

Every rule takes the same escape hatch, with a reason:

```ts
// eslint-disable-next-line component-contract/no-raw-radius -- matches the native scrollbar's fixed 2px corner
```

The reason is the point. A rule with no written rationale gets disabled the first time it is inconvenient, so state what makes this site different rather than that the rule was noisy.

All five ship as `warn`, because each has thousands of pre-existing uses. `scripts/lint-ratchet.mjs` records today's per-rule counts in `scripts/baselines/eslint-warnings-baseline.json` and fails CI when any single rule's count rises, so new violations cannot land quietly. A rule that vanishes from ESLint's output is a hard failure too — you cannot silence one to make a number go away.

Two sharp edges when you clean up. The counts fall only when someone reseeds the baseline; `--update` writes whatever it currently sees, so reseeding is a deliberate act to review, not a formality. And the update path refuses a drop of more than 10% for any single rule, which is easier to hit than it sounds — roughly ninety of the legacy-alias warnings trips it, as does fixing four of the thirty-five focus warnings, and on a rule already down to six a single fix does — and clearing a rule all the way to zero is stricter still: the rule vanishes from ESLint's output, so check mode reports it as disappeared and hard-fails until the baseline is reseeded. The escape is `npm run lint:ratchet -- --update --force`, which is the case that guard is designed to let through deliberately; note that it lifts the guard for every rule at once, so read the whole diff before committing it.
