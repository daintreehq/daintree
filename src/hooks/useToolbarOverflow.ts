import { useState, useRef, useLayoutEffect, useCallback } from "react";
import type { ToolbarButtonPriority, AnyToolbarButtonId } from "@shared/types/toolbar";
import { TOOLBAR_BUTTON_PRIORITIES } from "@shared/types/toolbar";

// Restore is intentionally harder than remove: once an item is hidden, the
// container must grow past its width plus this buffer before we surface it
// again. Asymmetry kills the boundary flip-flop that symmetric thresholds
// produce when clientWidth jitters by 1px at fractional zoom.
const RESTORE_HYSTERESIS_BUFFER = 16;
const DEFAULT_ITEM_WIDTH = 36;
// `toolbar-divider w-px h-5 mx-1` until a real one has been measured.
const DEFAULT_DIVIDER_WIDTH = 9;

export interface OverflowResult {
  visibleIds: AnyToolbarButtonId[];
  overflowIds: AnyToolbarButtonId[];
}

/**
 * What the row spends between items, on top of the items themselves. The
 * buttons are laid out with a flex gap, and a divider — itself a flex child,
 * so it costs a second gap — sits at every group boundary of the VISIBLE
 * sequence. Budgeting the item widths alone under-counts the row by the sum
 * of these, and at small deficits that under-count is the whole deficit: the
 * engine decides everything fits, the row's overflow-hidden clips the last
 * button, and no `…` trigger appears to say where it went.
 */
export interface OverflowLayout {
  gap: number;
  dividerWidth: number;
  resolveGroup?: (id: AnyToolbarButtonId) => string;
}

const NO_LAYOUT: OverflowLayout = { gap: 0, dividerWidth: 0 };

function footprint(
  visible: readonly AnyToolbarButtonId[],
  itemWidths: Map<string, number>,
  layout: OverflowLayout
): number {
  let total = 0;
  for (let i = 0; i < visible.length; i++) {
    total += itemWidths.get(visible[i]!) ?? DEFAULT_ITEM_WIDTH;
    if (i === 0) continue;
    total += layout.gap;
    if (
      layout.resolveGroup &&
      layout.resolveGroup(visible[i - 1]!) !== layout.resolveGroup(visible[i]!)
    ) {
      total += layout.dividerWidth + layout.gap;
    }
  }
  return total;
}

/**
 * Pure function: given a container width, item widths map, ordered item IDs,
 * and priorities, compute which items are visible vs overflowed.
 *
 * Items are removed lowest-priority-first (highest number). Within the same
 * priority, items later in the array are removed first.
 *
 * `pinnedIds` are immune to overflow — they always land in `visibleIds` and
 * their widths are excluded from the budget calculation, so non-pinned items
 * absorb all width pressure. Used for hardware-privacy indicators (e.g. an
 * active mic recording) where presence must remain stable regardless of
 * container width.
 */
export function computeOverflow(
  containerWidth: number,
  itemWidths: Map<string, number>,
  orderedIds: AnyToolbarButtonId[],
  priorities: Record<string, ToolbarButtonPriority>,
  pinnedIds?: ReadonlySet<AnyToolbarButtonId>,
  layout: OverflowLayout = NO_LAYOUT
): OverflowResult {
  if (orderedIds.length === 0) {
    return { visibleIds: [], overflowIds: [] };
  }

  const hasPinned = pinnedIds !== undefined && pinnedIds.size > 0;
  // Pinned items are never removed, but they still take real DOM space: the
  // footprint below counts them, so removable items absorb all the pressure.
  const removableIds = hasPinned ? orderedIds.filter((id) => !pinnedIds.has(id)) : orderedIds;

  if (footprint(orderedIds, itemWidths, layout) <= containerWidth) {
    return { visibleIds: [...orderedIds], overflowIds: [] };
  }

  // Sort removable items by priority descending (lowest priority = highest number
  // = removed first), then by reverse position (later items removed first within
  // same priority). Pinned items are excluded from removal entirely. The index
  // within removableIds preserves relative order, which is all the tiebreak needs.
  const sortedForRemoval = removableIds
    .map((id, index) => ({ id, index, priority: priorities[id] ?? 3 }))
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.index - a.index;
    });

  // The `…` trigger costs nothing here: it is the row's sibling, not its
  // child, so its appearance shrinks the row, the ResizeObserver reports the
  // new width, and the next pass budgets against it — hysteresis keeps that
  // second pass from oscillating.
  const overflowSet = new Set<AnyToolbarButtonId>();
  let visibleIds = [...orderedIds];

  for (const item of sortedForRemoval) {
    // Re-measured after every eviction rather than decremented: removing a
    // button can also remove a divider, when it was the last of its group.
    if (footprint(visibleIds, itemWidths, layout) <= containerWidth) break;
    overflowSet.add(item.id);
    visibleIds = visibleIds.filter((id) => id !== item.id);
  }

  const overflowIds = orderedIds.filter((id) => overflowSet.has(id));

  return { visibleIds, overflowIds };
}

/**
 * Stateful wrapper around `computeOverflow` that applies asymmetric
 * hysteresis to prevent boundary oscillation.
 *
 * Shrinking direction: always recompute — items are removed immediately when
 * they no longer fit. Growing direction: only restore an overflowed item once
 * the container clears `previousWidth + smallestOverflowedItemWidth +
 * RESTORE_HYSTERESIS_BUFFER`; below that, the previous result sticks.
 *
 * `previousResult` is `null` on the first call. If there is no current
 * overflow, the guard is a no-op and the pure result is returned.
 *
 * `pinnedIds` are forwarded to `computeOverflow` — pinned items never appear
 * in `overflowIds` regardless of container width.
 */
export function computeGuardedOverflow(
  containerWidth: number,
  itemWidths: Map<string, number>,
  orderedIds: AnyToolbarButtonId[],
  priorities: Record<string, ToolbarButtonPriority>,
  previousWidth: number,
  previousResult: OverflowResult | null,
  pinnedIds?: ReadonlySet<AnyToolbarButtonId>,
  layout: OverflowLayout = NO_LAYOUT
): OverflowResult {
  const fresh = computeOverflow(
    containerWidth,
    itemWidths,
    orderedIds,
    priorities,
    pinnedIds,
    layout
  );

  if (previousResult === null || previousResult.overflowIds.length === 0) {
    return fresh;
  }

  if (containerWidth <= previousWidth) {
    return fresh;
  }

  // If the ID set changed (item activated/deactivated), the previous result
  // references buttons that no longer exist. Don't hold a stale snapshot.
  const orderedSet = new Set<string>(orderedIds);
  for (const id of previousResult.overflowIds) {
    if (!orderedSet.has(id)) return fresh;
  }
  for (const id of previousResult.visibleIds) {
    if (!orderedSet.has(id)) return fresh;
  }

  // Growing with items currently in overflow — gate the restoration.
  // The reduce starts at +Infinity but is only reached when overflowIds is
  // non-empty (guarded above), so the result is always a real item width.
  const smallestOverflowedItemWidth = previousResult.overflowIds.reduce<number>((min, id) => {
    const w = itemWidths.get(id) ?? DEFAULT_ITEM_WIDTH;
    return w < min ? w : min;
  }, Number.POSITIVE_INFINITY);

  // Restoring an item also restores the gap in front of it.
  const restoreThreshold =
    previousWidth + smallestOverflowedItemWidth + layout.gap + RESTORE_HYSTERESIS_BUFFER;

  if (containerWidth >= restoreThreshold) {
    return fresh;
  }

  return previousResult;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function useToolbarOverflow(
  leftContainerRef: React.RefObject<HTMLDivElement | null>,
  rightContainerRef: React.RefObject<HTMLDivElement | null>,
  leftIds: AnyToolbarButtonId[],
  rightIds: AnyToolbarButtonId[],
  pinnedIds?: ReadonlySet<AnyToolbarButtonId>,
  resolveGroup?: (id: AnyToolbarButtonId) => string
): {
  leftVisible: AnyToolbarButtonId[];
  leftOverflow: AnyToolbarButtonId[];
  rightVisible: AnyToolbarButtonId[];
  rightOverflow: AnyToolbarButtonId[];
} {
  const [leftResult, setLeftResult] = useState<OverflowResult>({
    visibleIds: leftIds,
    overflowIds: [],
  });
  const [rightResult, setRightResult] = useState<OverflowResult>({
    visibleIds: rightIds,
    overflowIds: [],
  });

  const leftWidthsRef = useRef<Map<string, number>>(new Map());
  const rightWidthsRef = useRef<Map<string, number>>(new Map());
  const rafRef = useRef<number>(0);

  // Asymmetric-hysteresis state: the last container width that produced the
  // currently-displayed result, and the result itself. Updated only on
  // accepted state changes so the anchor doesn't drift on stable ticks.
  const leftPrevWidthRef = useRef<number>(0);
  const rightPrevWidthRef = useRef<number>(0);
  const leftPrevResultRef = useRef<OverflowResult | null>(null);
  const rightPrevResultRef = useRef<OverflowResult | null>(null);

  // Pending fractional widths captured from ResizeObserver entries before the
  // rAF fires. Zero means "no pending entry — read from the DOM instead."
  const leftPendingWidthRef = useRef<number>(0);
  const rightPendingWidthRef = useRef<number>(0);

  // Read once a divider exists and kept: a row with no visible group boundary
  // right now still needs to know what one would cost when eviction changes
  // the visible sequence.
  const dividerWidthRef = useRef<number>(DEFAULT_DIVIDER_WIDTH);

  const measureLayout = useCallback(
    (container: HTMLElement): OverflowLayout => {
      const gap = parseFloat(getComputedStyle(container).columnGap) || 0;
      const divider = container.querySelector<HTMLElement>(".toolbar-divider");
      if (divider) {
        const style = getComputedStyle(divider);
        const width =
          divider.getBoundingClientRect().width +
          (parseFloat(style.marginLeft) || 0) +
          (parseFloat(style.marginRight) || 0);
        if (width > 0) dividerWidthRef.current = width;
      }
      return { gap, dividerWidth: dividerWidthRef.current, resolveGroup };
    },
    [resolveGroup]
  );

  const measureItems = useCallback((container: HTMLElement, widthsCache: Map<string, number>) => {
    const elements = container.querySelectorAll<HTMLElement>("[data-toolbar-button-id]");
    for (const el of elements) {
      const id = el.getAttribute("data-toolbar-button-id");
      if (id) {
        const width = el.offsetWidth;
        // Only update cache if element is visible (hidden elements report 0)
        if (width > 0) {
          widthsCache.set(id, width);
        }
      }
    }
  }, []);

  const recalculate = useCallback(() => {
    const leftContainer = leftContainerRef.current;
    const rightContainer = rightContainerRef.current;

    if (leftContainer) {
      measureItems(leftContainer, leftWidthsRef.current);
      const pending = leftPendingWidthRef.current;
      leftPendingWidthRef.current = 0;
      const containerWidth = pending > 0 ? pending : leftContainer.getBoundingClientRect().width;
      const result = computeGuardedOverflow(
        containerWidth,
        leftWidthsRef.current,
        leftIds,
        TOOLBAR_BUTTON_PRIORITIES,
        leftPrevWidthRef.current,
        leftPrevResultRef.current,
        pinnedIds,
        measureLayout(leftContainer)
      );
      // Ref writes inside the updater are safe under concurrent rendering:
      // `containerWidth` and `result` are captured in the enclosing closure,
      // so a re-invoked updater writes the same values (idempotent).
      setLeftResult((prev) => {
        if (
          arraysEqual(prev.visibleIds, result.visibleIds) &&
          arraysEqual(prev.overflowIds, result.overflowIds)
        ) {
          return prev;
        }
        leftPrevWidthRef.current = containerWidth;
        leftPrevResultRef.current = result;
        return result;
      });
    }

    if (rightContainer) {
      measureItems(rightContainer, rightWidthsRef.current);
      const pending = rightPendingWidthRef.current;
      rightPendingWidthRef.current = 0;
      const containerWidth = pending > 0 ? pending : rightContainer.getBoundingClientRect().width;
      const result = computeGuardedOverflow(
        containerWidth,
        rightWidthsRef.current,
        rightIds,
        TOOLBAR_BUTTON_PRIORITIES,
        rightPrevWidthRef.current,
        rightPrevResultRef.current,
        pinnedIds,
        measureLayout(rightContainer)
      );
      setRightResult((prev) => {
        if (
          arraysEqual(prev.visibleIds, result.visibleIds) &&
          arraysEqual(prev.overflowIds, result.overflowIds)
        ) {
          return prev;
        }
        rightPrevWidthRef.current = containerWidth;
        rightPrevResultRef.current = result;
        return result;
      });
    }
  }, [
    leftContainerRef,
    rightContainerRef,
    leftIds,
    rightIds,
    pinnedIds,
    measureItems,
    measureLayout,
  ]);

  useLayoutEffect(() => {
    const leftContainer = leftContainerRef.current;
    const rightContainer = rightContainerRef.current;

    // Initial measurement
    recalculate();

    const observer = new ResizeObserver((entries) => {
      // Capture fractional widths before scheduling the rAF — clientWidth's
      // integer rounding is the source of the 1px jitter at fractional zoom.
      for (const entry of entries) {
        const inlineSize = entry.contentBoxSize?.[0]?.inlineSize;
        if (typeof inlineSize !== "number") continue;
        if (entry.target === leftContainer) {
          leftPendingWidthRef.current = inlineSize;
        } else if (entry.target === rightContainer) {
          rightPendingWidthRef.current = inlineSize;
        }
      }
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(recalculate);
    });

    if (leftContainer) observer.observe(leftContainer);
    if (rightContainer) observer.observe(rightContainer);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, [leftContainerRef, rightContainerRef, recalculate]);

  // Re-measure when the ID lists change (e.g. items become available/unavailable)
  useLayoutEffect(() => {
    recalculate();
  }, [leftIds, rightIds, recalculate]);

  return {
    leftVisible: leftResult.visibleIds,
    leftOverflow: leftResult.overflowIds,
    rightVisible: rightResult.visibleIds,
    rightOverflow: rightResult.overflowIds,
  };
}
