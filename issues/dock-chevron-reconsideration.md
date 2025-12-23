# Reconsider left/right chevrons in the dock

## Summary
The dock (`src/components/Layout/ContentDock.tsx`) currently reserves persistent space for left/right scroll chevrons. This reduces room for docked panels even when scrolling is not necessary (the common case). This spec proposes making chevrons conditional: only show them when the dock content actually overflows horizontally (and ideally only show the chevron(s) for directions that can scroll).

This document also explores an optional “progressive compaction” approach (items shrink toward icon-only) but recommends starting with the simpler conditional chevrons.

## Current State (as of today)
- Dock appears when `isTerminalDockVisible` in `src/components/Layout/AppLayout.tsx`.
- Dock contents are horizontally scrollable via `overflow-x-auto` on the scroll container.
- Chevrons are always rendered in `src/components/Layout/ContentDock.tsx` and sit outside the scroll container, consuming layout space even when not needed.
- Dock items (`src/components/Layout/DockedTerminalItem.tsx`) already have some natural shrink behavior, but enforce minimum readable content (e.g. title min width) and cap at `max-w-[280px]`, so overflow is common once a few panels exist.

## Problem
- Persistent chevrons reduce the available width for docked panels in the “normal” state (few docked panels).
- The dock already supports trackpad/mousewheel horizontal scroll; chevrons are mainly needed when overflow exists and the user doesn’t discover/hasn’t got horizontal scrolling.
- When overflow does not exist, chevrons provide no value but still add visual + spatial clutter.

## Goals
- Do not reserve space for chevrons unless scrolling is possible/necessary.
- Keep the dock readable in the common case (a few docked panels).
- Preserve existing behavior: drag/drop reorder, right-click context menu on dock, and popover preview on dock items.
- Maintain accessibility: keyboard users should not lose functionality; buttons must have appropriate `aria-*` when present.

## Non-goals
- Redesign dock item content (title/activity/state) in the first iteration.
- Add new dependencies.
- Change panel persistence, worktree filtering, or terminal/dock state management.

## Proposed UX (recommended)
### Visibility rules
- Determine whether the dock scroll container is horizontally overflowed:
  - `isOverflowing = scrollWidth > clientWidth + 1`
- Show chevrons only when overflow exists.
- Additionally, only show a chevron when it can do something:
  - `canScrollLeft = scrollLeft > 0`
  - `canScrollRight = scrollLeft + clientWidth < scrollWidth - 1`

### Interaction
- Clicking left/right chevron scrolls the dock by a “page” amount:
  - `scrollAmount = clamp(200, clientWidth * 0.8, 600)` (exact numbers can be tuned)
  - Scroll uses `behavior: "smooth"` (current behavior).
- When the user scrolls horizontally (trackpad/wheel), chevrons update to reflect scroll position.

### Layout strategy
Two viable approaches; both satisfy “only show when needed”:

1) Conditional render in-flow (simplest)
- Only render chevron button elements when needed.
- Trade-off: when overflow begins/ends (e.g. window resize), the dock layout shifts because buttons appear/disappear.

2) Overlay chevrons (best UX; recommended if easy)
- Wrap the scroll container in a `relative` container.
- Render chevrons as `absolute` overlays on the left/right edges of the scroll region (optionally with subtle gradient/fade).
- Benefits:
  - No reserved space in the common case.
  - No layout shift when chevrons appear/disappear.
- Trade-offs:
  - Edge hitboxes might interfere with dragging near edges; mitigate with small hitboxes and/or only showing on hover/overflow.

## Optional UX exploration: progressive compaction (defer)
If reducing horizontal scrolling becomes a goal later, introduce a compaction strategy that gradually reduces how much each dock item shows:

### Proposed compaction tiers
- Tier A (default): icon + title (+ activity for active items) (current).
- Tier B (tight): icon + truncated title, hide activity by default (maybe only show on hover).
- Tier C (compact): icon-only with tooltip for title; keep state indicator.

### Trigger
- Based on available width per item: `availableWidth / itemCount`.
- Or based on overflow state: if overflowing, enter Tier B; if still overflowing after Tier B, enter Tier C.

### Risks
- Requires careful a11y/tooltips, hover/keyboard parity, and might conflict with drag affordances.
- More visual/behavioral complexity than conditional chevrons.

Recommendation: implement conditional chevrons first; evaluate compaction only if overflow remains painful.

## Technical Design (recommended approach)
### Where to implement
- Primary: `src/components/Layout/ContentDock.tsx`
- New helper/hook (optional but recommended to keep `ContentDock` small):
  - `src/hooks/ui/useHorizontalScrollControls.ts` (new)

### IPC / persistence
- None. This is a purely presentational change in the renderer and does not require IPC, persistence, or store changes.

### State to track
For the scroll container element:
- `isOverflowing`
- `canScrollLeft`
- `canScrollRight`

### Update mechanism
Use a combination of:
- `ResizeObserver` (or window resize) to recompute overflow when the dock/container width changes.
- `scroll` event listener to update `canScrollLeft/right` as the user scrolls.

Implementation notes:
- Use `requestAnimationFrame` throttling for scroll updates to avoid excessive `setState`.
- Only call `setState` when computed values actually change (prevents unnecessary renders).
- Preserve the existing `combinedRef` pattern in `ContentDock` (it exists to avoid ref churn and ResizeObserver loops with dnd-kit).

### Suggested pure utility (enables node-env tests)
Create a small helper:
```ts
export function getHorizontalScrollState(metrics: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}) {
  const epsilon = 1;
  const isOverflowing = metrics.scrollWidth > metrics.clientWidth + epsilon;
  const canScrollLeft = isOverflowing && metrics.scrollLeft > epsilon;
  const canScrollRight =
    isOverflowing && metrics.scrollLeft + metrics.clientWidth < metrics.scrollWidth - epsilon;
  return { isOverflowing, canScrollLeft, canScrollRight };
}
```
Place the helper in `src/lib/horizontalScroll.ts` (or similar) and unit-test it in `src/lib/__tests__/horizontalScrollState.test.ts` so it runs in the existing `environment: "node"` Vitest configuration (no jsdom needed).

## Implementation Guide (step-by-step)
1) Add scroll state tracking
- In `ContentDock`, after `scrollContainerRef` is set, compute initial scroll state.
- Add a `scroll` event listener on the scroll container to recompute state.
- Add a `ResizeObserver` on the scroll container (or its parent wrapper) to recompute state on layout changes.

2) Render chevrons conditionally
- Replace always-rendered chevron buttons with conditional rendering based on state:
  - If `!isOverflowing`, render none.
  - If `canScrollLeft`, render left chevron.
  - If `canScrollRight`, render right chevron.
- If using the overlay strategy:
  - Put the scroll container inside a `relative` wrapper.
  - Add `absolute left-0` and `absolute right-0` chevrons with small padding.
  - Optional: add a subtle gradient background so it reads as “scroll affordance”.

3) Adjust scroll increments
- Replace fixed `200` with a function of container width (still clamped).
- Keep `behavior: "smooth"`.

4) QA and regression checks
- Verify these behaviors with:
  - 0 docked panels (dock hidden by AppLayout; no change).
  - 1–3 docked panels (no chevrons; more room for items).
  - Many docked panels (chevrons appear; only relevant direction shown).
  - Resize the window from wide → narrow → wide (chevrons appear/disappear correctly).
  - Drag/drop reorder still works, including near the edges.
  - Right-click context menu on dock background still works (no overlay intercept).

### Task breakdown (PR checklist)
- Update `src/components/Layout/ContentDock.tsx` to compute overflow + directional scroll state.
- (Optional) Add `src/hooks/ui/useHorizontalScrollControls.ts` + `getHorizontalScrollState` helper.
- Render chevrons conditionally (in-flow or overlay strategy).
- Tune scroll step sizing (fixed 200 → width-based clamp).
- Add unit tests for `getHorizontalScrollState` (pure logic, node env).
- Manual QA pass for drag/drop + context menu + resize.

## Acceptance Criteria
- When docked panels fit within the available dock width, no chevron buttons are visible and no chevron space is reserved.
- When docked panels overflow, chevrons appear and enable scrolling:
  - Left chevron appears only after the user is not at the far-left.
  - Right chevron appears only when there is content offscreen to the right.
- The change does not break:
  - Dock item click-to-preview behavior.
  - Drag-and-drop reorder.
  - Dock context menu (New Agent).
  - Waiting/Trash containers layout and interaction.

## Risks / Edge Cases
- Overlay approach can block drag near edges if hitboxes are large; keep them small and only show when needed.
- Scroll metrics can be off by fractional pixels; use a small epsilon.
- Updates must be throttled to avoid re-render loops (especially with ResizeObserver).
