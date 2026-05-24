# Spike: native `[popover]` + CSS Anchor Positioning for floating surfaces

**Issue:** #8992 **Date:** 2026-05-24 **Environment:** Electron 41 / Chromium 146, React 19.2, Tailwind CSS v4.3, Vite 8 **Status:** Spike complete — recommendation below **Author:** spike implementation under `src/components/spikes/`

## Question

Can the native browser `[popover]` attribute plus CSS Anchor Positioning replace Radix UI for **basic tooltips and small dropdowns**, now that Chromium 146 ships the full anchor-positioning surface? This is a time-boxed evaluation, not a migration. No production floating surface was changed.

## What was built

All additive, all under `src/components/spikes/` (DEV-only, never shipped):

- `NativeTooltip.tsx` — `[popover="hint"]` tooltip, CSS-anchor positioned, `@starting-style` fade/scale, no JS positioning.
- `NativeDropdown.tsx` — `[popover="auto"]` menu with a hand-rolled roving-tabindex / `role="menu"` keyboard layer (~30 lines). Escape is left entirely to the native `CloseWatcher`.
- `NativePopoverSpike.tsx` — demo host: a corner pill opens an `AppDialog` containing both surfaces, so the Escape-arbitration story is exercised live.
- `native-popover-demo.css` — anchor positioning, `@starting-style`, discrete `display`/`overlay` transitions, reduced-motion handling.
- `__tests__/NativeDropdown.test.tsx` — 14 unit tests for the keyboard resolver.

Mounted in `App.tsx` behind `import.meta.env.DEV` via a lazy import.

## Bundle delta

Measured from `dist/renderer-bundle-size-report.json` after `npm run build`.

| Chunk | Raw | Gzip | Notes |
| --- | --- | --- | --- |
| `vendor-radix-overlay` (today's baseline) | 105,042 B | 31,874 B | all five Radix primitives, one deferred chunk |
| `NativePopoverSpike` (spike chunk) | 6,040 B | 2,461 B | emitted but never fetched in production |
| Production main/entry delta from this spike | **0 B** | **0 B** | spike is DEV-gated; entry/critical-path bundle unchanged |

The `import.meta.env.DEV` render gate makes the spike's dynamic import a dead branch at runtime (`!1 && …`), so the chunk is **never fetched** in a production build and adds nothing to the entry/critical-path bundle. Because the `lazy()` declaration still sits at module scope, Rollup keeps the import _edge_ and the `NativePopoverSpike` chunk file is still emitted to `dist/` (~2.5 KB gzip on disk). To drop the file entirely, move the `lazy()` call inside the `import.meta.env.DEV` guard — not done here since the spike is throwaway.

The current `vendor-radix-overlay` chunk bundles **all five** primitives (`react-tooltip`, `react-popover`, `react-dropdown-menu`, `react-select`, `react-context-menu`) behind `radix-deferred.ts`. A native tooltip + dropdown spike adds ~2.5 KB gzip of its own code.

**Projected savings if tooltip + popover + dropdown-menu were migrated:** the deferred chunk would shrink but **could not be eliminated** — `Select` and `ContextMenu` have no native equivalent (`<select>` is not stylable to our surface tokens; the `contextmenu` content API was removed from Chrome). So the realistic win is a _partial_ reduction of a chunk that is already lazy-loaded and off the critical path — not removal of a load-bearing dependency. The native replacement code (~2.5 KB) offsets part of whatever is saved.

## Behaviour-parity matrix

| Capability | Native `[popover]` + anchor | Radix today | Verdict |
| --- | --- | --- | --- |
| Positioning (anchor, side) | `position-area` + `anchor()` | Floating UI | ✅ parity |
| Collision flip | `position-try-fallbacks: flip-block` | Floating UI `flip()` | ✅ parity |
| Height clamp on small viewport | `max-height: calc(100% - 8px)` (IMCB) | Floating UI `size()` | ⚠️ parity for static menus; dynamic `availableHeight` callbacks still need JS |
| Top-layer stacking | automatic; z-index/Portal moot | Portal + `--z-popover` | ✅ better (no Portal, no `getPortalBoundary`) |
| Enter/exit animation | `@starting-style` + `transition-behavior: allow-discrete` + `overlay`, asymmetric timing | Tailwind `data-[state]` | ✅ parity (timing tiers reproduced: 150/100 tooltip, 200/120 dropdown) |
| Reduced motion | media query + `data-reduce-animations` selector | `@variant reduce-motion` | ✅ parity |
| Light dismiss (outside click) | `popover="auto"` native | `DismissableLayer` | ✅ parity |
| Escape, single surface | native `CloseWatcher` | `DismissableLayer` capture handler | ✅ parity |
| **Escape arbitration (popover inside dialog)** | native `CloseWatcher` LIFO — first Escape closes menu, second closes dialog | requires `dialogEscapeBackstop.ts` shim | ✅ better, with a caveat (see gaps #5) |
| Trigger focus-restore on close | automatic for `popover="auto"` | Radix manages | ✅ parity |
| **Focus trap / arrow-key menu nav** | **none** — must hand-roll roving tabindex + `role` wiring | `react-roving-focus`, full ARIA | ❌ **gap — the main cost of a production-quality native dropdown** |
| Hover-to-open tooltip | **none declarative** — `interestfor` still flagged in 146; needs JS pointer/focus wiring | Radix `Tooltip` hover/focus + delay | ❌ gap — JS still required to open on hover |
| Tooltip open/close delay grouping | not provided | `TooltipProvider` delay/skip-delay | ❌ gap |
| Per-instance cost | zero framework overhead | `TooltipProvider` per-item cost (#4749) | ✅ better |

## Capability gaps (the load-bearing ones)

1. **No focus trap or arrow-key navigation for menus.** `[popover]` does not trap focus and provides no roving behaviour. A spec-correct `role="menu"` needs real focus movement (screen readers announce `menuitem` on focus), so we hand-rolled ~30 lines of roving tabindex + Home/End/Enter/Space. This is the single biggest reason native is _not_ a drop-in for Radix `DropdownMenu`, which ships this plus typeahead, sub-menus, and grouping.
2. **No declarative hover trigger for tooltips.** `interestfor`/`interesttarget` is still behind a flag in Chromium 146, so `popover="hint"` must be opened from JS pointer/focus handlers. We also lose Radix's shared open/close delay grouping (`TooltipProvider` delay + skip-delay), which would have to be re-implemented to avoid flicker across many adjacent triggers.
3. **`Select` and `ContextMenu` have no native path**, so the Radix deferred chunk can be shrunk but never removed — capping the bundle upside.
4. **No JSDOM coverage** for `[popover]`, the top layer, `CloseWatcher`, or anchor positioning. Only the keyboard resolver is unit-testable; everything visual is manual-verify or E2E-in-Electron. That raises the regression-test cost of any production migration.
5. **`dialogEscapeBackstop` doesn't transparently coexist with native popovers inside `AppDialog`.** The backstop's capture-phase probe (`radixLayerWasOpenWhenEscapePressed` → `isAnyRadixLayerOpen`) detects open Radix surfaces via `[role="menu"][data-state="open"]` and friends. The native dropdown carries `role="menu"` but **no `data-state`**, so the probe returns `false` while the native menu is open. In the demo the two-step close still appeared correct because `CloseWatcher` fires before the document-bubble backstop — but this is Chromium-timing-dependent, not guaranteed by design. A production adoption would need to extend `isAnyRadixLayerOpen` to also detect open native popovers (e.g. `[popover]:popover-open`) or share an open-count registry. So the shim doesn't simply _disappear_ for native surfaces inside a dialog; it has to be taught about them.

## What native does genuinely better

- **Removes the need for `dialogEscapeBackstop.ts` on standalone native surfaces.** The shim exists only because Radix's `DismissableLayer` calls `preventDefault()` on Escape mid-exit and doesn't use `CloseWatcher`. Native `popover="auto"` resolves Escape LIFO against `<dialog>` automatically. Inside an `AppDialog`, the two-step close worked in the demo — but see gap #5: the existing backstop probe doesn't recognise native popovers, so coexistence is timing-dependent until the probe is extended.
- **No Portal, no `getPortalBoundary()`, no `--z-popover` juggling.** Top-layer rendering sidesteps the entire stacking-context and collision-boundary apparatus in `popover.tsx`.
- **Zero per-instance framework cost** — relevant to the #4749 nested-`TooltipProvider` re-render hotspot.

## Recommendation: **HOLD** (selective, not wholesale)

Native `[popover]` + CSS Anchor Positioning is **production-ready in Chromium 146 for the positioning, animation, top-layer, and Escape-arbitration concerns**, and it is strictly better than Radix on the dismiss-arbitration and Portal/z-index fronts. But it is **not a drop-in replacement**:

- **Don't** migrate `DropdownMenu`, `Select`, or `ContextMenu`. The focus-trap / roving-nav / typeahead surface we'd have to re-implement erases the bundle win, and `Select`/`ContextMenu` have no native equivalent at all.
- **Consider** a follow-up for **tooltips specifically**, where the gap is smallest (no focus trap needed) — but only bundled with a small JS layer for hover-open and delay grouping, and only if the `vendor-radix-overlay` partial saving justifies the migration + test cost. On its own this is a marginal win on an already-deferred chunk.
- **Adopt the pattern for net-new surfaces** that are simple and live inside dialogs, where skipping the Radix dependency and the Escape shim is a clear win from day one.

No follow-up work is committed by this spike. The strongest standalone takeaway is architectural, not bundle-size: **`CloseWatcher` makes the Escape-arbitration shim unnecessary for standalone surfaces built on `popover="auto"`** — and points to extending the existing backstop probe to recognise native popovers as the right first step for any future adoption inside dialogs.
