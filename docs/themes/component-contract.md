# Component Contract

What to reach for when you build a surface, and which spelling is current when more than one exists. [theme-system.md](./theme-system.md) owns the palette → semantic token → component variable pipeline, [theme-tokens.md](./theme-tokens.md) is the full token reference, and [interaction-state-recipes.md](./interaction-state-recipes.md) holds the canonical class string per interactive role. This document owns the layer above those: which primitive, which vocabulary, which scale, and where the boundary sits between a component's styling and the app's.

Every rule below is enforced. The `component-contract` ESLint plugin lives in `scripts/eslint-rules/component-contract/` and is registered in `eslint.config.js`; each section names the rule that backs it. See [Opting out](#opting-out) for the escape hatch and how the counts ratchet down.

## Primitives

Check `src/components/ui/` before you hand-roll anything. A surface built from these inherits the dialog frame's focus trap, the palette's keyboard model and the toast router's placement logic for free, and none of those are cheap to rebuild correctly.

| Reach for | When |
| --- | --- |
| `AppDialog` | Any modal. It is the shared dialog frame — chrome, focus trap, dismissal and escape handling — and what surfaces like the worktree overview are built on. |
| `ConfirmDialog` | A destructive action at tier D1 or D2. Carries the `danger:"confirm"` wiring the audit expects; see [destructive-action-safeguards.md](../architecture/destructive-action-safeguards.md). |
| `TypedNameConfirmInput` | A D3 catastrophic action, where the user must type the target's name. |
| `SearchablePalette`, `AppPaletteDialog`, `AppPalettePopover`, `PaletteStrip` | Anything list-and-filter. The palette family owns the arrow-key model, the active-descendant cursor and hover/keyboard reconciliation. |
| `popover`, `fixed-dropdown`, `dropdown-menu`, `context-menu`, `select`, `tooltip` | Layered surfaces. `fixed-dropdown` is the one that survives overlay-count races on cold start. |
| `button` | Any button. Its variant table is the accent budget in code — pick a variant rather than restyling a `ghost`. |
| `SegmentedToggle`, `SegmentedRadioGroup`, `RadioChoice` | Two-to-three-way mode switches and option groups. |
| `EmptyState` | An empty region. The `user-cleared` variant deliberately nulls its action so completed-work states stay quiet. |
| `Skeleton`, `Spinner` | Loading, under the 400ms Doherty gate in `CLAUDE.md` — skeleton when the layout shape is predictable, `Spinner` when it is not. |
| `SurfaceHeader` | A panel or dialog header, at either density. |
| `Kbd`, `ShortcutHint`, `HighlightedText`, `TruncatedTooltip` | Chrome details that already exist and are easy to reinvent slightly differently. |

New primitives belong in `src/components/ui/` only when a second caller appears. One-off composition stays with its feature.

## The colour vocabulary

Three vocabularies are live in the codebase. **The semantic tokens are the current one.** The other two are legacy and only shrink from here:

| Vocabulary | Shape | Uses | Status |
| --- | --- | --- | --- |
| Semantic tokens | `text-text-secondary`, `bg-surface-panel`, `border-border-default`, `text-status-error` | ~2,700 | **Current.** Every theme validates these; the full list is in [theme-tokens.md](./theme-tokens.md). |
| Legacy `daintree-*` aliases | `text-daintree-text`, `bg-daintree-bg` | ~4,500 | Legacy. Seven aliases over tokens that already have semantic names. |
| shadcn defaults | `text-muted-foreground`, `bg-muted`, `bg-popover` | ~230 | Legacy. Arrived with the vendored shadcn primitives and never mapped onto the theme. |

The `daintree-*` layer is pure aliasing — `--color-daintree-text` is defined in `src/index.css` as nothing but `var(--theme-text-primary)`. Two names for one token means neither reads as canonical, and because the alias layer covers seven tokens against the semantic layer's ~145, anything outside those seven has no legacy spelling at all. That is why single class strings today mix both vocabularies.

Migrate on the utility, keeping the prefix and any alpha suffix:

| Legacy | Current |
| --- | --- |
| `text-daintree-text` | `text-text-primary` |
| `bg-daintree-bg` | `bg-surface-canvas` |
| `bg-daintree-sidebar` | `bg-surface-sidebar` |
| `border-daintree-border` | `border-border-default` |
| `outline-daintree-accent`, `ring-daintree-accent` | `outline-accent-primary`, `ring-accent-primary` |
| `*-daintree-focus` | `*-focus-ring` |

Enforced by `component-contract/no-legacy-daintree-utilities`. Reads of `var(--color-daintree-*)` inside an arbitrary value are deliberately not flagged — they are far rarer, and folding them in would double-count the same migration.

## Alpha on text

Never fade a text colour with slash-alpha. `text-text-secondary/70` compiles in Tailwind v4 to `color-mix(in oklab, var(--color-text-secondary) 70%, transparent)` on the `color` property itself, so the label is composited against whatever sits behind it and the contrast loss is baked in — an `opacity: 1` further down the tree cannot recover it. De-emphasise with a solid token one step down the hierarchy: `text-text-secondary`, then `text-text-muted`.

This has already cost real legibility. `src/index.css` carries `[class*="text-daintree-text/"] { color: var(--color-daintree-text) !important; }` inside the `prefers-contrast: more` block, added to claw back what the pattern costs under macOS Increase Contrast, with `!important` because the Tailwind utility has equal specificity and wins on source order. The rule exists so that override's surface area stops growing.

Alpha on surfaces and edges is fine and is not flagged — `bg-status-error/10` composites against a known background, and that ladder is the `overlay-*` design rather than debt.

Enforced by `component-contract/no-text-color-slash-alpha`, variant-prefixed forms included: a `hover:` fade fades the label exactly as hard as a base one, which is why the production override above matches on a substring.

## CVA or inline classes

`cva()` earns its place when a component has a **closed set of named variants that callers choose between**, and the variants differ in more than a class or two. `src/components/ui/button.tsx` is the canonical case: fifteen variants and five sizes, where the variant name is the API and the class strings are an implementation detail. `SurfaceHeader` is the other, splitting two densities.

Everything else is `cn()`. A component with one appearance, or whose only variation is a boolean the parent already computes, does not need a variant table — a `cn("…", isActive && "…")` is clearer and shorter. Reaching for CVA to hold two states is how you get a variant table with one real variant in it.

The signal to convert is a component growing a third or fourth `isX && "…"` branch that callers are choosing between by prop. At that point name them.

Extract shared class strings the way `src/components/ui/paletteRowStyles.ts` does — one exported `cn()` constant, so five palettes cannot grow five spellings of the same row.

## Scales

**Type.** Tailwind's stock `--text-*` steps; this repo overrides none of them. Arbitrary sizes (`text-[11px]`) are off the scale, invisible to it, and do not move when it moves — and because the values sit a pixel apart, 9px through 13px are all in use where the scale offers two steps. When a design genuinely needs a step the scale lacks — the 10-11px label sizes are the real case — add a named step to the `@theme` block in `src/index.css` and use that. One list of legal sizes beats an open set of brackets. Enforced by `component-contract/no-arbitrary-text-size`; arbitrary _colours_ share the `text-[…]` spelling and are not flagged.

**Radius.** `--radius-xs` through `--radius-3xl`, all derived in `src/index.css` from one base: `--radius: calc(0.625rem * var(--theme-radius-scale, 1))`. A theme can therefore scale every corner in the app at once. Both `rounded-md` and `rounded-[var(--radius-md)]` are on the scale and compile to the same value; the second is the codebase's prevailing spelling. `rounded-full` and `rounded-none` are shape decisions rather than points on a scale and stay legal.

Two spellings are not: a hardcoded `rounded-[2px]`, which ignores `--theme-radius-scale`; and bare `rounded`, which is the subtler one. Tailwind documents `rounded` as 0.25rem and it reads that way, but the utility resolves through `--radius` — which this repo overrides — so it actually renders the `rounded-lg` value. Name the step you mean. Enforced by `component-contract/no-raw-radius`.

**Spacing.** Tailwind's stock scale, unmodified, so `p-2` and `gap-1.5` behave exactly as documented. Control heights have their own tokens — `--height-xs|sm|md|lg` in `src/index.css` — for anything that has to line up with a button.

## The focus ring

The split matters, because "it's wired globally" is true of one half and false of the other.

**Global, never restate:** the transition. `*:focus-visible` in `src/index.css` declares `outline-color`, `outline-offset` and `box-shadow` transitions from `--focus-transition-duration` / `--focus-transition-easing`. Three more `*:focus-visible` blocks handle reduced motion, `forced-colors: active` (a `2px solid Highlight` outline, `!important`) and `prefers-contrast: more` (`outline-width: 3px`). Those are accessibility floors — they are deliberately separate blocks, per the high-contrast dual-block rule in `CLAUDE.md`, and per-element `outline-*` transitions must not be added on top.

**Component-owned:** the normal-mode ring's colour, width and offset. `button.tsx` shows the shape — `focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2` plus the accent token. Use `outline` rather than `ring` for keyboard focus (it survives Windows High Contrast), and `:focus-visible` rather than `:focus`.

**Never suppress without replacing.** `outline-hidden` with nothing painted in its place removes the element from keyboard navigation, and nothing in the class string says so. If focus genuinely belongs to a wrapper — a compound control painting one ring via `focus-within`, say — that is a real exception, but it needs to be written down at the site.

Use `outline-hidden`, never `outline-none`: v4 changed `outline-none` to emit a bare `outline-style: none`, dropping the transparent outline that keeps a focus indicator paintable in forced-colors mode. `outline-hidden` is the spelling that kept v3's behaviour.

Enforced by `component-contract/no-unpaired-outline-suppression`, and — as the harder gate — by `src/config/__tests__/focusRingFallback.contract.test.ts`, which also scans `plugins/**`, keeps a reviewed allowlist of the elements that legitimately delegate, and covers a trap the lint rule does not: `--tw-outline-style` does not inherit, so `outline-hidden` and `focus-visible:outline-2` on the same element resolve to nothing painted at all. `src/config/__tests__/outlineHidden.contract.test.ts` bans `outline-none` repo-wide.

## Opting out

Every rule takes the same escape hatch, with a reason:

```ts
// eslint-disable-next-line component-contract/no-raw-radius -- matches the native scrollbar's fixed 2px corner
```

The reason is the point. A rule with no written rationale gets disabled the first time it is inconvenient, so state what makes this site different rather than that the rule was noisy.

All five ship as `warn`, because each has thousands of pre-existing uses. `scripts/lint-ratchet.mjs` records today's per-rule counts in `scripts/baselines/eslint-warnings-baseline.json` and fails CI when any single rule's count rises — so the counts only move down. Two things follow. A rule that vanishes from ESLint's output is a hard failure too, so you cannot silence one to make a number go away. And because the ratchet refuses a baseline update that drops a rule by more than 10%, a cleanup PR that removes a large batch needs `npm run lint:ratchet -- --update --force`; that guard exists to catch coverage loss, and a real cleanup is the case it is designed to let through deliberately.
