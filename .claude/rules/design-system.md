---
paths:
  - "src/**/*.tsx"
  - "src/**/*.css"
  - "shared/theme/**/*.ts"
---

# Design system

Hard constraints. The linked docs own the full catalogs and audits; rules without a pointer live only here.

## Colour vocabulary

Check `src/components/ui/` before hand-rolling a surface — there are 55 primitives.

Semantic tokens (`text-text-primary`, `bg-surface-panel`) are the **current** vocabulary. The legacy `daintree-*` aliases and shadcn's `muted-foreground`/`bg-muted` names only shrink — never add one.

**Never slash-alpha a text colour.** Tailwind v4 bakes it into `color-mix()` on `color` and the contrast cannot be recovered. Step down the hierarchy instead. `text-muted` has no dark-theme contrast floor (2.22:1 on namib, 2.50:1 on redwoods) — use `text-text-secondary` for icons and anything load-bearing.

## Accent restraint

Accent (`--color-accent-primary`, `text-accent-primary`, `outline-accent-primary`) is at most **one** load-bearing signal — a focus anchor or a primary CTA — per active focus region (focus trap or arrow-key domain).

Never for multi-select, membership, secondary emphasis, or anything appearing on several elements at once. Use the `bg-overlay-subtle` title-bar lift, focus styling, or neutral surfaces instead. In doubt, no accent. A neutral high-contrast button beats an accent one for a primary CTA — and it stays theme-aware by construction, so never hardcode white.

Checklist: `docs/themes/theme-system.md`. Green is separately governed by `docs/themes/status-success-policy.md`.

## Scales

Type and spacing are Tailwind's stock scales. Radius is `--radius-*`: `rounded-full` and `rounded-none` are legal, bare `rounded` is not (it resolves to the `rounded-lg` value, not Tailwind's 4px).

`cva()` only for a closed set of named variants callers pick between; otherwise `cn()`.

Five `component-contract/*` ESLint rules enforce the vocabulary, text alpha, type and radius scales, and focus suppression (warn + ratchet). The primitive and CVA rules are convention. Full contract: `docs/themes/component-contract.md`.

## Motion

Shared tiers unless the duration itself encodes meaning: state changes 150ms `ease-out`; entry/exit 200/120ms; palette and tooltip 150/100ms; panel motion 200/120ms. Use the constants in `src/lib/animationUtils.ts`, never literals.

Semantic exceptions where decay, width, or sequencing *is* the signal (`ActivityLight`, `FileChangeList` recency) are exempt from tier-fixing.

Use the narrowest transition property set — never widen to bare `transition` or `transition-all`. Keep `transform` out of press snaps (copy `src/styles/components/toolbar.css` or `button.tsx`'s `active:scale-[0.98] active:duration-[1ms]`). Box-shadow either interpolates in its own named 150ms slot **or** snaps with `active:shadow-none`, never both.

Focus-ring transitions are wired once globally in `src/index.css` `*:focus-visible` — never restate them, and never add a per-element `outline-*` transition. The ring's colour and width are component-owned. Never suppress a ring without a replacement, and use `outline-hidden`, never `outline-none`.

Patterns: `docs/themes/interaction-state-recipes.md`.

## Loading indicators

A 400ms Doherty gate governs page and panel level waits: under 400ms show nothing; 400ms–1s a skeleton (`animate-pulse-delayed`, gate built in) when the layout shape is predictable, else `Spinner`; over 1s a skeleton is mandatory; over 5s add "Still working…".

The gates are a family, not one number — all in `src/lib/animationUtils.ts`:

- `UI_DOHERTY_THRESHOLD` (400ms) — page/panel spinners, via `useDeferredLoading`.
- `UI_SKELETON_GATE_MS` (200ms) — skeleton onset, via `useSkeletonGate`.
- `UI_INLINE_LOADING_GATE_MS` (200ms) — granular per-item indicators (file-tree expansion). Deliberately shorter; 400ms feels sluggish at this grain.
- `UI_SKELETON_FLOOR_MS` (250ms) — **minimum dwell** once a skeleton has appeared, via `useSkeletonDisplayFloor`. Onset gates only suppress early display; without the floor a skeleton can appear and tear down in the same frame, which reads as a glitch.

`animate-pulse-immediate` only for waits already known to exceed the gate. `Spinner` has no delay — never use it for sub-400ms waits or predictable shapes. Reduced-motion and performance modes bypass the pulse. Canonical: `BrowserPaneSkeleton`. Settings tabs render chrome immediately from safe defaults and populate on resolve — never a full-area `Spinner`.

## Icons

Lucide only (`lucide-react`) — no bespoke glyphs for app concepts. A new concept takes the closest Lucide icon, added to the alias list in `src/components/icons/index.ts`. Bespoke exceptions: `DaintreeIcon`, `AgentStateCircles`, `McpServerIcon`, `brands/`.

Agent-state glyphs (green spinner / amber circle / blue check) are app-wide vocabulary — never swap in a foreign glyph. Never render `SpinnerCircle` static.

## High contrast

`@media (prefers-contrast: more)` and `@media (forced-colors: active)` in `src/index.css` are separate on purpose — macOS fires only the former, Windows swaps in system colors. **Never consolidate them.** Rationale is inline in the block comments.

Forced-colors drops `box-shadow`, so Tailwind `ring-*` vanishes there — re-declare badge cut-outs as an outline.
