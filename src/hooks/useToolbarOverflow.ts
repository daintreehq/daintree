import { useState, useRef, useLayoutEffect, useCallback } from "react";
import type { ToolbarButtonId, ToolbarButtonPriority } from "@shared/types/toolbar";
import { TOOLBAR_BUTTON_PRIORITIES } from "@shared/types/toolbar";

const OVERFLOW_TRIGGER_WIDTH = 36;
const HYSTERESIS_BUFFER = 8;
const DEFAULT_ITEM_WIDTH = 36;

export interface OverflowResult {
  visibleIds: ToolbarButtonId[];
  overflowIds: ToolbarButtonId[];
}

/**
 * Pure function: given a container width, item widths map, ordered item IDs,
 * and priorities, compute which items are visible vs overflowed.
 *
 * Items are removed lowest-priority-first (highest number). Within the same
 * priority, items later in the array are removed first.
 */
export function computeOverflow(
  containerWidth: number,
  itemWidths: Map<string, number>,
  orderedIds: ToolbarButtonId[],
  priorities: Record<ToolbarButtonId, ToolbarButtonPriority>
): OverflowResult {
  if (orderedIds.length === 0) {
    return { visibleIds: [], overflowIds: [] };
  }

  const totalWidth = orderedIds.reduce(
    (sum, id) => sum + (itemWidths.get(id) ?? DEFAULT_ITEM_WIDTH),
    0
  );

  if (totalWidth <= containerWidth) {
    return { visibleIds: [...orderedIds], overflowIds: [] };
  }

  // Sort by priority descending (lowest priority = highest number = removed first),
  // then by reverse position (later items removed first within same priority)
  const sortedForRemoval = orderedIds
    .map((id, index) => ({ id, index, priority: priorities[id] ?? 3 }))
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.index - a.index;
    });

  const overflowSet = new Set<ToolbarButtonId>();
  let currentWidth = totalWidth;
  const targetWidth = containerWidth - OVERFLOW_TRIGGER_WIDTH - HYSTERESIS_BUFFER;

  for (const item of sortedForRemoval) {
    if (currentWidth <= targetWidth) break;
    overflowSet.add(item.id);
    currentWidth -= itemWidths.get(item.id) ?? DEFAULT_ITEM_WIDTH;
  }

  const visibleIds = orderedIds.filter((id) => !overflowSet.has(id));
  const overflowIds = orderedIds.filter((id) => overflowSet.has(id));

  return { visibleIds, overflowIds };
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function useToolbarOverflow(
  leftContainerRef: React.RefObject<HTMLDivElement | null>,
  rightContainerRef: React.RefObject<HTMLDivElement | null>,
  leftIds: ToolbarButtonId[],
  rightIds: ToolbarButtonId[]
): {
  leftVisible: ToolbarButtonId[];
  leftOverflow: ToolbarButtonId[];
  rightVisible: ToolbarButtonId[];
  rightOverflow: ToolbarButtonId[];
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
      const containerWidth = leftContainer.clientWidth;
      const result = computeOverflow(
        containerWidth,
        leftWidthsRef.current,
        leftIds,
        TOOLBAR_BUTTON_PRIORITIES
      );
      setLeftResult((prev) => {
        if (
          arraysEqual(prev.visibleIds, result.visibleIds) &&
          arraysEqual(prev.overflowIds, result.overflowIds)
        ) {
          return prev;
        }
        return result;
      });
    }

    if (rightContainer) {
      measureItems(rightContainer, rightWidthsRef.current);
      const containerWidth = rightContainer.clientWidth;
      const result = computeOverflow(
        containerWidth,
        rightWidthsRef.current,
        rightIds,
        TOOLBAR_BUTTON_PRIORITIES
      );
      setRightResult((prev) => {
        if (
          arraysEqual(prev.visibleIds, result.visibleIds) &&
          arraysEqual(prev.overflowIds, result.overflowIds)
        ) {
          return prev;
        }
        return result;
      });
    }
  }, [leftContainerRef, rightContainerRef, leftIds, rightIds, measureItems]);

  useLayoutEffect(() => {
    const leftContainer = leftContainerRef.current;
    const rightContainer = rightContainerRef.current;

    // Initial measurement
    recalculate();

    const observer = new ResizeObserver(() => {
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
