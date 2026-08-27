# Component Contract

What to reach for when you build a surface, and which spelling is current when more than one exists. [theme-system.md](./theme-system.md) owns the palette → semantic token → component variable pipeline, [theme-tokens.md](./theme-tokens.md) is the full token reference, and [interaction-state-recipes.md](./interaction-state-recipes.md) holds the canonical class string per interactive role. This document owns the layer above those: which primitive, which vocabulary, which scale, and where the boundary sits between a component's styling and the app's.

Some of it is machine-checkable and some of it is judgement. The `component-contract` ESLint plugin lives in `scripts/eslint-rules/component-contract/`, is registered in `eslint.config.js` over `src/**` and the builtin plugin renderers, and backs five of the rules below — each section names its rule where one exists, and the rest are conventions you are expected to follow. See [Opting out](#opting-out) for the escape hatch and how the counts ratchet.

## Primitives

Check `src/components/ui/` before you hand-roll anything. A surface built from these inherits the dialog frame's focus trap, the palette's keyboard model and the toast router's placement logic for free, and none of those are cheap to rebuild correctly.

| Reach for | When |
| --- | --- |
| `AppDialog` | Any modal. It is the shared dialog frame — chrome, focus trap, dismissal and escape handling — and what surfaces like the worktree overview are built on. |
| `ConfirmDialog` | Any destructive confirmation. Pass `typedNameTarget` for a D3 catastrophic action to make the user type the target's name; see [destructive-action-safeguards.md](../architecture/destructive-action-safeguards.md) for the tiers. The `danger: "confirm"` marker lives on the action definition, not on this component. |
| `SearchablePalette`, `AppPaletteDialog`, `AppPalettePopover` | Anything list-and-filter. The palette family owns the arrow-key model, the active-descendant cursor and hover/keyboard reconciliation. |
| `popover`, `fixed-dropdown`, `dropdown-menu`, `context-menu`, `select`, `tooltip` | Layered surfaces. `fixed-dropdown` is the one that survives overlay-count races on cold start. |
| `button` | Any button. Its variant table is the accent budget in code — pick a variant rather than restyling a `ghost`. |
| `SegmentedToggle`, `SegmentedRadioGroup`, `RadioChoiceGroup` / `RadioChoiceRow` | Two-to-three-way mode switches and option groups. |
| `EmptyState` | An empty region. The `user-cleared` variant deliberately nulls its action so completed-work states stay quiet. |
| `Skeleton`, `Spinner` | Loading, under the 400ms Doherty gate in `CLAUDE.md` — skeleton when the layout shape is predictable, `Spinner` when it is not. |
| `field`, `input`, `textarea`, `checkbox`, `switch` | Any form control. `field` owns the label/description/error wiring and the `aria-describedby` and `aria-invalid` plumbing that hand-rolled forms get wrong. |
| `card`, `badge` | A bounded content block and its status pill. |
| `SurfaceHeader` | A panel or dialog header, at either density. |
| `Kbd`, `ShortcutHint`, `HighlightedText`, `TruncatedTooltip` | Chrome details that already exist and are easy to reinvent slightly differently. |

New primitives belong in `src/components/ui/` only when a second caller appears. One-off composition stays with its feature.

## The colour vocabulary

Three vocabularies are live in the codebase. **The semantic tokens are the current one.** The other two are legacy and only shrink from here:

| Vocabulary | Shape | Uses | Status |
| --- | --- | --- | --- |
| Semantic tokens | `text-text-secondary`, `bg-surface-panel`, `border-border-default`, `text-status-error` | ~4,900 | **Current.** The validated contract is 155 tokens; the full list is in [theme-tokens.md](./theme-tokens.md). |
| Legacy `daintree-*` aliases | `text-daintree-text/70`, `bg-daintree-accent/10` | ~2,300 | Legacy. Five aliases over tokens that already have semantic names. Every solid use is gone; what remains is alpha forms, which is the only reason the alias layer still has to generate. |
| shadcn defaults | `text-muted-foreground`, `bg-muted`, `bg-popover` | ~250 | Legacy. Arrived with the vendored shadcn primitives. Nearly all are theme-backed (`--muted` resolves to `--theme-surface-panel`), so they render correctly — they are simply a third name for tokens that already have one. |

Counts are utilities in production `src/**`, measured with the same extraction the rules use.

The `daintree-*` layer is pure aliasing — `--color-daintree-text` is defined in `src/index.css` as nothing but `var(--theme-text-primary)`. Two names for one token means neither reads as canonical, and because the alias layer covers five tokens against the semantic layer's 155, anything outside those five has no legacy spelling at all. That is why single class strings today mix both vocabularies.

Migrate on the utility, keeping the prefix:

| Legacy | Current |
| --- | --- |
| `text-daintree-text` | `text-text-primary` |
| `bg-daintree-bg` | `bg-surface-canvas` |
| `bg-daintree-sidebar` | `bg-surface-sidebar` |
| `border-daintree-border` | `border-border-default` |
| `outline-daintree-accent`, `ring-daintree-accent` | `outline-accent-primary`, `ring-accent-primary` |

Two further aliases, `--color-daintree-accent-rgb` and `--color-daintree-focus`, were deleted once their last call sites went. The rule still maps them, deliberately: a utility naming an alias that no longer exists generates no CSS at all, which is a worse failure than the vocabulary mixing and worth catching by name rather than falling through to the generic message.

An alpha modifier carries across unchanged on surfaces and edges — `bg-daintree-accent/10` becomes `bg-accent-primary/10`. On a **text** colour it does not: `text-daintree-text/70` becomes `text-text-secondary` or `text-text-muted`, per the next section. Both rules fire on that token, and both fixes are needed.

Enforced by `component-contract/no-legacy-daintree-utilities`. Reads of `var(--color-daintree-*)` inside an arbitrary value are deliberately not flagged — they are far rarer, and folding them in would double-count the same migration.

## Alpha on text

Never fade a text colour with slash-alpha. `text-text-secondary/70` compiles in Tailwind v4 to a solid declaration followed by a `@supports` block that replaces it with `color-mix(in oklab, var(--theme-text-secondary) 70%, transparent)` — the alpha lands on the `color` property itself, so the label is composited against whatever sits behind it and the contrast loss is baked in. An `opacity: 1` further down the tree cannot recover it. De-emphasise with a solid token one step down the hierarchy: `text-text-secondary`, then `text-text-muted`.

This has already cost real legibility. `src/index.css` carries a `[class*="text-daintree-text/"]` override inside the `prefers-contrast: more` block, forcing the solid token back, added to claw back what the pattern costs under macOS Increase Contrast. The rule exists so that override's surface area stops growing.

Alpha on surfaces and edges is fine and is not flagged — `bg-status-error/10` composites against a known background, and that ladder is the `overlay-*` design rather than debt.

Enforced by `component-contract/no-text-color-slash-alpha`, variant-prefixed forms included: a `hover:` fade fades the label exactly as hard as a base one, which is why the production override above matches on a substring. The font-size/line-height shorthand (`text-sm/6`, `text-[11px]/4`) is not an alpha and is not flagged; nor is `text-shadow-*`, whose modifier is a shadow alpha rather than the glyph colour.

## CVA or inline classes

`cva()` earns its place when a component has a **closed set of named variants that callers choose between**, and the variants differ in more than a class or two. `src/components/ui/button.tsx` is the canonical case: fifteen variants and seven sizes, where the variant name is the API and the class strings are an implementation detail. `SurfaceHeader` is the other, splitting two densities.

Everything else is `cn()`. A component with one appearance, or whose only variation is a boolean the parent already computes, does not need a variant table — a `cn("…", isActive && "…")` is clearer and shorter. Reaching for CVA to hold two states is how you get a variant table with one real variant in it.

The signal to convert is a component growing a third or fourth `isX && "…"` branch that callers are choosing between by prop. At that point name them.

Extract shared class strings the way `src/components/ui/paletteRowStyles.ts` does — one exported `cn()` constant, so five palettes cannot grow five spellings of the same row.

## Scales

**Type.** Tailwind's stock `--text-*` steps; this repo overrides none of them. Arbitrary sizes (`text-[11px]`) are off the scale, invisible to it, and do not move when it moves — and because the values sit a pixel apart, 9px through 13px are all in use where the scale offers two steps. When a design genuinely needs a step the scale lacks, add a named step to the `@theme` block in `src/index.css` and use that — `--text-2xs` (11px), `--text-3xs` (10px) and `--text-4xs` (9px) are exactly that, added for the label sizes the stock scale skips, and `button`'s `xs` size now spells itself `text-3xs`. One list of legal sizes beats an open set of brackets. Enforced by `component-contract/no-arbitrary-text-size`; arbitrary _colours_ share the `text-[…]` spelling and are not flagged.

**Radius.** `--radius-xs` through `--radius-3xl`, all derived in `src/index.css` from one base: `--radius: calc(0.625rem * var(--theme-radius-scale, 1))`. A theme can therefore scale every corner in the app at once. Both `rounded-md` and `rounded-[var(--radius-md)]` are on the scale and resolve to the same value; the second is the codebase's prevailing spelling. `rounded-full` and `rounded-none` are shape decisions rather than points on a scale and stay legal.

Three spellings are not. An arbitrary radius that hardcodes a value — `rounded-[2px]`, `rounded-[0]`, `rounded-[calc(2px)]` — ignores `--theme-radius-scale`. So does a step above `3xl`, where this repo stops redefining and Tailwind's fixed `rounded-4xl` (2rem) takes over. And bare `rounded` is the subtle one: Tailwind documents it as 0.25rem and it reads that way, but the utility resolves through `--radius` — which this repo overrides — so it actually renders the `rounded-lg` value. Name the step you mean. Enforced by `component-contract/no-raw-radius`.

**Spacing.** Tailwind's stock scale, unmodified, so `p-2` and `gap-1.5` behave exactly as documented. `--height-xs|sm|md|lg` tokens exist in `src/index.css` for control heights, but nothing uses them yet — `button` still spells its sizes `h-6` through `h-9`. Treat them as available, not as an established convention.

## The focus ring

The split matters, because "it's wired globally" is true of one half and false of the other.

**App-level, do not restate:** the transition and the accessibility floors. `*:focus-visible` in `src/index.css` declares `outline-color`, `outline-offset` and `box-shadow` transitions from `--focus-transition-duration` / `--focus-transition-easing`, and three more `*:focus-visible` blocks handle reduced motion, `forced-colors: active` (a `2px solid Highlight` outline, `!important`) and `prefers-contrast: more` (`outline-width: 3px`). Those are deliberately separate blocks, per the high-contrast dual-block rule in `CLAUDE.md`. Do not add per-element `outline-*` transitions on top. One caveat worth knowing: the transition rule sits in the `base` layer, so a component's own `transition` or `transition-colors` utility — which lives in `utilities` — overrides `transition-property` and drops part of it. The floors under `forced-colors` are `!important` and always hold.

**Component-owned:** the normal-mode ring's colour, width and offset. `button.tsx` shows the shape — `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2` plus the accent token. Prefer `outline` over `ring` for keyboard focus (it survives Windows High Contrast), and `:focus-visible` over `:focus`.

**Never suppress without replacing.** `outline-hidden` with nothing painted in its place leaves the element focusable but invisibly so — it still takes keyboard focus, and nothing shows where that focus is. If focus genuinely belongs to a wrapper — a compound control painting one ring via `focus-within`, say — that is a real exception, but it needs to be written down at the site.

Use `outline-hidden`, never `outline-none`: v4 changed `outline-none` to emit a bare `outline-style: none`, dropping the transparent outline that keeps a focus indicator paintable in forced-colors mode. `outline-hidden` is the spelling that kept v3's behaviour.

Enforced twice, deliberately. `src/config/__tests__/focusRingFallback.contract.test.ts` is the hard gate: it fails the build, scans `src/**` plus the GitHub plugin renderer, keeps a 44-entry allowlist of the elements that legitimately delegate focus to a wrapper, and owns a second invariant the lint rule does not — `--tw-outline-style` does not inherit, so `outline-hidden` and `focus-visible:outline-2` on the same element resolve to nothing painted at all. `component-contract/no-unpaired-outline-suppression` is the editor-time mirror: same contract, reported on the line as you type, opted out with a comment rather than a central array. `src/config/__tests__/outlineHidden.contract.test.ts` bans `outline-none` across `src/**`.

The cost of running both is that a genuinely new exception has to be recorded in two places — an inline disable and an allowlist entry. Consolidating them onto one shared predicate is worth doing; it is not done yet.

## Opting out

Every rule takes the same escape hatch, with a reason:

```ts
// eslint-disable-next-line component-contract/no-raw-radius -- matches the native scrollbar's fixed 2px corner
```

The reason is the point. A rule with no written rationale gets disabled the first time it is inconvenient, so state what makes this site different rather than that the rule was noisy.

All five ship as `warn`, because each has thousands of pre-existing uses. `scripts/lint-ratchet.mjs` records today's per-rule counts in `scripts/baselines/eslint-warnings-baseline.json` and fails CI when any single rule's count rises, so new violations cannot land quietly. A rule that vanishes from ESLint's output is a hard failure too — you cannot silence one to make a number go away.

Two sharp edges when you clean up. The counts fall only when someone reseeds the baseline; `--update` writes whatever it currently sees, so reseeding is a deliberate act to review, not a formality. And the update path refuses a drop of more than 10% for any single rule, which is easier to hit than it sounds — 233 of the 2,322 legacy uses trips it, as does fixing four of the 35 focus warnings, and on a rule already down to six a single fix does — and clearing a rule all the way to zero is stricter still: the rule vanishes from ESLint's output, so check mode reports it as disappeared and hard-fails until the baseline is reseeded. The escape is `npm run lint:ratchet -- --update --force`, which is the case that guard is designed to let through deliberately; note that it lifts the guard for every rule at once, so read the whole diff before committing it.
