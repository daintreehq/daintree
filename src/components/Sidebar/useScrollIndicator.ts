import { useCallback, useEffect, useRef, useState } from "react";
import type { ListItem } from "react-virtuoso";
import { useResizeObserverRaf } from "@/hooks/useResizeObserverRaf";

// A row is treated as hidden only once it has fully cleared the viewport edge.
// The 1px tolerance absorbs sub-pixel offset/scroll rounding so a row sitting
// flush against an edge doesn't flicker between "visible" and "hidden".
const VISIBILITY_EPSILON_PX = 1;

interface ScrollIndicatorItem {
  kind: string;
}

interface UseScrollIndicatorParams {
  /**
   * The full flat list backing the Virtuoso surface. Used to count worktree
   * rows (`kind === "row"`) that sit entirely outside the rendered window, and
   * to ignore section headers (`kind === "header"`) when tallying hidden rows.
   */
  items: ReadonlyArray<ScrollIndicatorItem>;
}

interface UseScrollIndicatorReturn {
  hiddenAbove: number;
  hiddenBelow: number;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  /** Plug into Virtuoso's `scrollerRef` prop. Captures the scrolling element. */
  scrollerRef: (el: HTMLElement | Window | null) => void;
  /** Plug into Virtuoso's `onScroll` prop. */
  handleScroll: () => void;
  /** Plug into Virtuoso's `itemsRendered` prop. Captures per-item geometry. */
  handleItemsRendered: (rendered: ListItem<ScrollIndicatorItem>[]) => void;
}

function useScrollIndicator({ items }: UseScrollIndicatorParams): UseScrollIndicatorReturn {
  const [hiddenAbove, setHiddenAbove] = useState(0);
  const [hiddenBelow, setHiddenBelow] = useState(0);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  // Latest `items` mirrored into a ref so the stable callbacks below always read
  // the current list without taking it as a dependency (which would churn their
  // identity and break the rAF coalescing). Updated in an effect — all readers
  // (Virtuoso callbacks, scroll/resize handlers, the items-changed effect) run
  // after commit, so the ref is current by the time they read it.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });
  // Latest per-item geometry from Virtuoso's `itemsRendered`. Held in a ref (not
  // state) because `itemsRendered` only fires when the rendered set changes —
  // intra-overscan scrolls reuse this cached geometry via `handleScroll`, so it
  // must be readable without forcing a re-render.
  const renderedItemsRef = useRef<ListItem<ScrollIndicatorItem>[]>([]);
  // The exact `items` array the cached geometry was measured against. After a
  // filter/sort/group change the offsets/indices describe a different layout, so
  // geometry whose tag no longer matches the live list is treated as absent.
  // This identity check is ordering-independent: it never discards geometry that
  // Virtuoso just refreshed for the current list, and never trusts geometry left
  // over from a previous one — no reliance on effect-vs-callback timing.
  const geometryItemsRef = useRef<ReadonlyArray<ScrollIndicatorItem> | null>(null);
  // rAF-coalesce Virtuoso scroll callbacks into a single in-flight frame so a
  // burst of scroll events triggers one layout read, not one per event (issue
  // #9580). The ResizeObserver path already throttles via `useResizeObserverRaf`.
  const scrollRafIdRef = useRef<number | null>(null);

  const updateScrollIndicators = useCallback(() => {
    const scroller = scrollerElRef.current;
    if (!scroller) return;

    const items = itemsRef.current;
    const rendered = renderedItemsRef.current;
    // No usable geometry: either nothing has been measured yet, or the cached
    // geometry belongs to a previous list layout. Virtuoso re-fires
    // `itemsRendered` for the current list momentarily, refreshing the tag.
    if (rendered.length === 0 || geometryItemsRef.current !== items) {
      setHiddenAbove(0);
      setHiddenBelow(0);
      return;
    }

    const { scrollTop, clientHeight } = scroller;
    const viewportTop = scrollTop;
    const viewportBottom = scrollTop + clientHeight;

    const firstRenderedIndex = rendered[0]!.index;
    const lastRenderedIndex = rendered[rendered.length - 1]!.index;

    let above = 0;
    let below = 0;

    // Rows that sit entirely outside the rendered window are unmounted, so they
    // carry no geometry — count them straight from the backing list by index.
    for (let i = 0; i < firstRenderedIndex && i < items.length; i++) {
      if (items[i]!.kind === "row") above++;
    }
    for (let i = lastRenderedIndex + 1; i < items.length; i++) {
      if (items[i]!.kind === "row") below++;
    }

    // Rendered rows: classify each against the live viewport using its measured
    // offset/size. A partially-visible row counts as visible (not hidden).
    for (const item of rendered) {
      if (item.data?.kind !== "row") continue;
      if (item.offset + item.size <= viewportTop + VISIBILITY_EPSILON_PX) {
        above++;
      } else if (item.offset >= viewportBottom - VISIBILITY_EPSILON_PX) {
        below++;
      }
    }

    setHiddenAbove(above);
    setHiddenBelow(below);
  }, []);

  // Recompute when the backing list changes (filter, sort, group toggle). Until
  // Virtuoso re-fires `itemsRendered` with geometry tagged for the new list, the
  // identity guard inside `updateScrollIndicators` yields a conservative 0/0
  // rather than measuring stale offsets against the new layout.
  useEffect(() => {
    updateScrollIndicators();
  }, [items, updateScrollIndicators]);

  useResizeObserverRaf(scrollerEl, () => updateScrollIndicators());

  // Cancel any pending re-position frame on unmount so the coalesced callback
  // never reads a detached scroller or sets state after teardown.
  useEffect(
    () => () => {
      if (scrollRafIdRef.current !== null) {
        cancelAnimationFrame(scrollRafIdRef.current);
        scrollRafIdRef.current = null;
      }
    },
    []
  );

  const handleScroll = useCallback(() => {
    if (scrollRafIdRef.current !== null) return;
    scrollRafIdRef.current = requestAnimationFrame(() => {
      scrollRafIdRef.current = null;
      updateScrollIndicators();
    });
  }, [updateScrollIndicators]);

  const handleItemsRendered = useCallback(
    (rendered: ListItem<ScrollIndicatorItem>[]) => {
      renderedItemsRef.current = rendered;
      // Tag the geometry with the list it was measured against so a later
      // recompute can tell whether it still applies.
      geometryItemsRef.current = itemsRef.current;
      updateScrollIndicators();
    },
    [updateScrollIndicators]
  );

  const scrollerRef = useCallback((el: HTMLElement | Window | null) => {
    // Virtuoso forwards either the scroller element or window. We only support
    // element scrolling here (the sidebar is always an in-container scroller).
    const next = el instanceof HTMLElement ? el : null;
    scrollerElRef.current = next;
    setScrollerEl(next);
    // When Virtuoso unmounts (filter clears to an empty state), reset the
    // indicator counts so stale "5 above" badges don't briefly remain over
    // the empty state placeholder, and drop any pending scroll frame that
    // would otherwise read the now-detached scroller and stale geometry.
    if (next === null) {
      if (scrollRafIdRef.current !== null) {
        cancelAnimationFrame(scrollRafIdRef.current);
        scrollRafIdRef.current = null;
      }
      renderedItemsRef.current = [];
      geometryItemsRef.current = null;
      setHiddenAbove(0);
      setHiddenBelow(0);
    }
  }, []);

  const scrollToTop = useCallback(() => {
    scrollerElRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const scrollToBottom = useCallback(() => {
    const scroller = scrollerElRef.current;
    if (scroller) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    }
  }, []);

  return {
    hiddenAbove,
    hiddenBelow,
    scrollToTop,
    scrollToBottom,
    scrollerRef,
    handleScroll,
    handleItemsRendered,
  };
}

export { useScrollIndicator };
