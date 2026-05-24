# Spike: native `[popover]` + CSS Anchor Positioning for floating surfaces

**Issue**: #8992  
**Date**: 2026-05-24  
**Time-box**: ~1 day  
**Target runtime**: Electron 41 / Chromium 146  
**Status**: complete — POC components landed behind developer-mode gate in TroubleshootingTab  
**Recommendation**: **HOLD** — re-evaluate when focus-trap / sub-menu primitives ship in Chromium

---

## What was built

Two isolated POC components, zero modifications to existing Radix wrappers, `dialogEscapeBackstop.ts`, `escapeStack.ts`, `radix-loader.ts`, or `radix-deferred.ts`:

- `src/components/ui/NativeTooltip.tsx` — native `popover="hint"` + `anchor-name` + `position-area`, Tier 2-fast motion (150ms enter / 100ms exit)
- `src/components/ui/NativeDropdown.tsx` — native `popover="auto"` + `position-try-fallbacks` flip, Tier 2 motion (200ms enter / 120ms exit)
- `src/styles/components/native-popover.css` — shared anchor-positioning reset + animation pattern with `overlay` in every transition list
- `src/spikes/NativePopoverSpikeDemo.tsx` — multi-anchor tooltip grid, transformed-ancestor anchor test, dropdown flip-near-edge test, local reduce-motion toggle
- Gated into `Settings → Troubleshooting` behind the existing `developerMode` setting (one import + one `<SettingsSection>` block in `TroubleshootingTab.tsx`)

A standalone HTML fixture was rejected: `cspTransformPlugin()` in `vite.config.ts` throws on any Vite-processed HTML without a CSP meta tag, so the in-app demo is genuinely lower-friction.

## Bundle baseline (current Radix footprint, gzipped)

| Chunk | Raw | Gzip | Loads when |
| --- | --- | --- | --- |
| `radix-loader` | 1.0 kB | 0.6 kB | always — primes the deferred chunk |
| `radix-deferred` | 0.2 kB | 0.2 kB | first floating surface — just re-exports the 5 packages |
| `vendor-radix` | 5.1 kB | 1.9 kB | dialog primitives |
| `vendor-radix-utils` | 14.6 kB | 3.3 kB | shared Radix internals |
| `vendor-radix-overlay` | 105.0 kB | **32.0 kB** | tooltip + popover + dropdown + select + context-menu |
| **Total deferred surface** | 125.9 kB | **38.0 kB** |  |

The `vendor-radix-overlay` chunk (32 kB gzipped) is the realistic prize. The deferred loading already hides this from cold-load — it lands when a tooltip/popover/dropdown first becomes visible. A full native migration would remove ~32 kB gzip from the deferred surface; a partial migration (tooltip + simple dropdown only) would not — `vendor-radix-overlay` is a single chunk that loads as long as _any_ of the five primitives is in use. **Bundle savings only materialize at the point all five Radix primitive consumers are eliminated, not before.**

## Parity matrix

| Capability | Native `[popover]` (Chrome 146) | Radix today | Verdict |
| --- | --- | --- | --- |
| Anchored positioning (4 sides + 3 aligns) | `position-area` + `anchor-name` | Floating UI middlewares | ✅ parity |
| Collision flip | `position-try-fallbacks: flip-block, flip-inline` | `collisionBoundary` + auto flip | ✅ parity |
| Hide-when-anchor-scrolled-offscreen | `position-visibility: anchor-visible` | `hideWhenDetached` | ✅ parity |
| Top-layer escape from transform / overflow ancestors | top-layer promotion (automatic) | Portal to body | ✅ parity (better — no portal allocation) |
| Entry / exit animation | `@starting-style` + `transition-behavior: allow-discrete` + `overlay` in transition list | Radix Presence + data-state | ✅ works, with caveat (see Gap #1) |
| Light-dismiss (click-outside) | native via `popover="auto"` | `DismissableLayer` | ✅ parity |
| Escape key | native via CloseWatcher (capture phase) | `DismissableLayer` `onEscapeKeyDown` | ⚠️ collides with `dialogEscapeBackstop` (Gap #2) |
| Focus management on open | manual `popover.showPopover()` + focus call | Radix FocusScope autoFocus | ⚠️ DIY needed (Gap #3) |
| Focus trap inside popover | none — Tab can escape | Radix FocusScope trap | ❌ missing (Gap #3) |
| Hover-intent (safe polygon) | none | Radix `delayDuration` + provider | ❌ missing (Gap #4) |
| Sub-menu chains | structurally possible (nested popovers); no keyboard arrow coordination | Radix `Sub` + `SubTrigger` | ❌ missing (Gap #5) |
| Virtual element anchors | needs proxy `<div>` with `anchor-name` | Floating UI `getBoundingClientRect` object | ❌ workaround required |
| ARIA wiring (role, aria-controls, aria-expanded) | manual | Radix component default | ⚠️ DIY needed |
| `keepMounted` / suspended-but-not-unmounted state | no native equivalent | Radix Presence + `forceMount` | ❌ missing (Gap #6) |
| Per-instance `data-state` selectors | not native — manage via `:popover-open` + `toggle` event | Radix `data-state="open\|closed"` | ⚠️ different idiom |
| Multi-instance hygiene (no leak between unrelated tooltips) | inherent — each popover element is independent | requires FixedDropdownVisibleContext + key-on-visibility workaround (#8001) | ✅ better |
| Pointer-priming for dock popovers (#8008) | n/a — no Radix priming path | `primeOnEvent` + `primeRadix` | ✅ better (no priming needed) |

## Gaps with severity and migration cost

### Gap #1 — Exit-animation `overlay` requirement _(severity: low; mitigation: documented in CSS)_

`@starting-style` + `transition-behavior: allow-discrete` works in Chromium 146, but `overlay` MUST appear in the transition list alongside `display`. Without it, top-layer ejection on close is synchronous and the exit fade is clipped to a single frame. Invisible in Chrome DevTools' default Animations panel — you have to inspect the top-layer panel.

```css
transition:
  opacity 150ms ease,
  display 150ms allow-discrete,
  overlay 150ms allow-discrete;
```

Codified in `src/styles/components/native-popover.css`. Any future native popover work must follow this pattern — there is no `@exit-style` rule and no Tailwind utility for the `overlay` longhand.

### Gap #2 — CloseWatcher collides with `dialogEscapeBackstop.ts` _(severity: HIGH; blocks any production migration)_

Native `[popover]` handles Escape via CloseWatcher in capture phase. `dialogEscapeBackstop.ts` also runs in capture phase and probes for open Radix layers by reading `data-state="open"` attributes. A native popover provides no `data-state` signal, so the backstop's probe sees no open layer and treats the native close as a spurious dismissal of whatever AppDialog is the top of the escape stack.

Migration would require teaching the backstop to also probe for open `[popover]` elements (`document.querySelector('[popover]:popover-open')`) and to coordinate with CloseWatcher's beforeclose event. This is non-trivial because CloseWatcher's beforeclose can't be conditionally cancelled per-stack-position — it's all-or-nothing for the specific popover element. A LIFO stack across mixed native + Radix layers needs careful design.

**Past lesson**: #3831 introduced the escape stack on the explicit assumption that Radix `DismissableLayer` events are the source of truth. #4588 layered routing for xterm/CodeMirror on top. Both would need rework, not just the backstop.

### Gap #3 — Focus management: open-focus + trap + restore _(severity: HIGH for dropdown/popover; LOW for tooltip)_

Native `[popover]` provides:

- ✅ Automatic focus restore to the invoker on close
- ❌ No autofocus on open (Tab/Shift-Tab from the trigger lands wherever it would without the popover; you must call `firstFocusable.focus()` after `showPopover()`)
- ❌ No focus trap (Tab from inside the popover can escape into the document)

Radix FocusScope handles all three. The POC dropdown leaves Tab-escape unfixed — visible in the demo. Any migration would need a minimal focus-trap helper (~80 LOC) or a port of Floating UI's `FloatingFocusManager`.

**Past lesson**: #2828 — AppDialog's focus trap checks `closest('[aria-modal="true"]')` to skip portaled Radix popovers. A native `[popover]` is NOT an `aria-modal` ancestor of its trigger (it's in the top layer; ancestor traversal stops at the trigger's parent). If a native popover contained focusable elements and lived inside an AppDialog, AppDialog's focus trap would hijack Tab focus away from the popover. Fix: extend the AppDialog focus trap guard to also check for `:popover-open` ancestors, OR use `popover="manual"` and call `inert` on the surrounding tree, OR move the popover under the dialog in document order before opening.

### Gap #4 — No hover-intent / safe polygon _(severity: medium for menu sub-items; low for app tooltip)_

Native `[popover]` has no equivalent of Floating UI's `safePolygon` — moving the cursor diagonally from a menu item toward a sub-menu instantly closes the parent. Daintree's current `Tooltip` provider uses Radix's `delayDuration` + `skipDelayDuration` for the "if a sibling tooltip is already open, skip the delay" pattern; native popover requires a DIY timer per trigger (the POC implements a simple version).

### Gap #5 — Sub-menu coordination _(severity: HIGH for any Radix `DropdownMenu` migration)_

Structurally, nested `[popover]` works — but the cross-popover keyboard coordination (ArrowRight enters sub, ArrowLeft returns to parent, focus-chain restoration, sub-popover dismissal on parent dismissal) is all DIY. Radix `DropdownMenu.Sub` provides this out-of-the-box. Daintree has ~12 surfaces using `DropdownMenuSub` (toolbar overflow, terminal context menu, sidebar project actions, etc.); migrating any of them is a meaningful refactor, not a swap.

### Gap #6 — No `keepMounted` / Activity equivalent _(severity: medium)_

Tooltip leak fix #8001 relies on the dropdown's `FixedDropdownVisibleContext` to force-close tooltips when a parent dropdown enters Activity-hidden state. Native popover has no equivalent — `hidePopover()` is the only signal, and there's no Suspense-style "mounted but visually hidden" affordance. Either: (a) call `hidePopover()` imperatively whenever the parent enters hidden state (requires the same kind of context wiring), or (b) accept that any imperatively-shown tooltip whose dismiss path is skipped strands in the top layer.

## What native genuinely wins

- **Multi-instance hygiene** — each popover element is a leaf in the DOM with its own visibility state. The #8001 class of bug (stale tooltip stranded at 0,0 after parent dropdown unmounts) is impossible: when the parent unmounts, the child popover element is removed from the DOM and the browser cleans up the top-layer entry. No `key={visible ? "v" : "h"}` workaround.
- **Top-layer escape** — anchor positioning correctly reads the anchor's post-transform bounding box (Chromium 144+); top-layer promotion lifts the popover out of any transform-induced containing block. No Portal allocation, no z-index war.
- **Smaller per-instance cost** — no React-rendered Portal node, no DismissableLayer event tree, no FocusScope subtree. For low-priority hover tooltips this matters at scale (sidebar with hundreds of project rows).
- **Native primitives are stable surface** — Chromium 146 ships `popover=hint`, `popover=auto`, `position-area`, `position-try-fallbacks`, `position-visibility`, `@starting-style`, `transition-behavior: allow-discrete`, CloseWatcher all as default-enabled. Removed Floating UI / Radix dependency upgrades from the surface.

## What native does NOT win

- **Bundle size — until the LAST consumer migrates.** `vendor-radix-overlay` (32 kB gzip) is a single chunk that loads when any of `Tooltip | Popover | DropdownMenu | Select | ContextMenu` is rendered. Migrating only Tooltip + simple Dropdown does not reduce the gzip cost. `Select` and `ContextMenu` are the hardest to replace (Select has scroll-button behavior, ContextMenu has long-press coordination on touch). Pragmatically: the bundle savings ceiling is real but the path to claim it is long.
- **Test ergonomics** — jsdom does not implement top-layer, `:popover-open`, `overlay`, anchor positioning, or CloseWatcher. Everything has to be Playwright. The existing Tooltip/Popover unit tests use Radix's data-state attributes for assertions; those go away.
- **TypeScript ergonomics** — `CSSProperties` does not yet type `anchorName`, `positionAnchor`, `positionArea`, `positionVisibility`, `positionTryFallbacks`. The POC uses a local intersection type; long-term this needs a `lib.dom.d.ts` augmentation or the React team to ship it.
- **Past institutional knowledge** — `dialogEscapeBackstop`, `FixedDropdownVisibleContext`, `useIsDockPopoverChild`, `primeOnEvent`, AppDialog focus-trap guards all have at least one issue tag in their history (#8001, #8008, #4588, #2828, #3831). A migration re-opens every one of those design questions in the native idiom.

## Recommendation: **HOLD**

Native `[popover]` + CSS Anchor Positioning is mature enough for a greenfield Chromium-only app to use exclusively. It is **not yet a reasonable trade for Daintree** in 2026-Q2:

1. **No bundle win without a full-surface migration.** Tooltip + simple dropdown alone changes nothing in `vendor-radix-overlay`. The win materializes only when Select and ContextMenu also migrate, and both have meaningful behavioral gaps (focus trap, sub-menu coordination, scroll-button affordances).
2. **The Escape coordination gap (Gap #2) is load-bearing.** `dialogEscapeBackstop` is built for Radix's `data-state` signal. Reworking it to coexist with CloseWatcher's capture-phase native handling is the kind of cross-cutting infrastructure change that introduces its own incident class.
3. **Focus-trap is still DIY.** The biggest single thing missing from the platform. Until there's a `popover-focus-trap` attribute or equivalent (no shipped proposal as of Chrome 146), every dropdown migration adds 50–100 LOC of focus management that Radix gives for free.

### When to revisit

Re-open this spike if any of these land in Chromium:

- A native focus-trap affordance on `[popover]` (e.g. `popover="manual" inert` integration, or a dedicated attribute)
- CloseWatcher cancellation that integrates with a stack (`event.preventDefault()` honoring LIFO across popover layers)
- A `position-area` extension for sub-menu placement / keyboard coordination primitives
- Floating UI publishes a "native popover + their middleware" hybrid layer that handles the focus + sub-menu DIY gaps

### What to keep from this spike

- `src/styles/components/native-popover.css` — the documented `overlay`-in-transition pattern is reusable for any future native-popover work
- `NativeTooltip.tsx` — could be promoted to a tooltip variant for cases where Radix is overkill (low-priority hover, dense lists). Currently deferred — the existing tooltip wrapper is the single source of truth.

### What to throw away

- `NativeDropdown.tsx` — focus trap and sub-menu gaps make this not safe for production menu use. Keep for demo until the spike is closed; then delete.
- `src/spikes/NativePopoverSpikeDemo.tsx` and the TroubleshootingTab gate — delete on issue close.

---

**Files added by this spike** (will be removed in a follow-up if the recommendation stands):

- `src/components/ui/NativeTooltip.tsx`
- `src/components/ui/NativeDropdown.tsx`
- `src/styles/components/native-popover.css`
- `src/spikes/NativePopoverSpikeDemo.tsx`
- `docs/spikes/native-popover-2026-05.md` (this memo)

**Files modified by this spike** (will be reverted in a follow-up if the recommendation stands):

- `src/index.css` (+1 line: `@import "./styles/components/native-popover.css"`)
- `src/components/Settings/TroubleshootingTab.tsx` (+1 import, +10-line `<SettingsSection>` block gated on `developerMode`)
