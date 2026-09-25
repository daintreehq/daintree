import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ListItem, VirtuosoHandle } from "react-virtuoso";
import { useResizeObserverRaf } from "@/hooks/useResizeObserverRaf";

// A row is treated as hidden only once it has fully cleared the viewport edge.
// The 1px tolerance absorbs sub-pixel offset/scroll rounding so a row sitting
// flush against an edge doesn't flicker between "visible" and "hidden".
const VISIBILITY_EPSILON_PX = 1;

interface ScrollIndicatorItem {
  kind: string;
  /** Present on worktree rows; matched against `attentionWorktreeIds`. */
  worktreeId?: string;
}

/** What one edge of the viewport has beyond it. */
export interface HiddenSide {
  /** Worktree rows entirely past this edge. */
  count: number;
  /**
   * How many of those rows need attention — the sidebar's "Attention" bucket,
   * so the pills break down the same number the quick-state bar shows.
   */
  attention: number;
}

const NO_HIDDEN: HiddenSide = { count: 0, attention: 0 };

/**
 * Per-index classification of the list against the viewport, plus the rows a
 * click on each pill should reveal. Computed fresh on every read so a jump
 * always targets the list as it is now, not as it was at the last scroll frame.
 */
interface Classification {
  above: HiddenSide;
  below: HiddenSide;
  /** The hidden row nearest the top edge, and the nearest one needing attention. */
  nearestAbove: number | null;
  nearestAttentionAbove: number | null;
  /** The hidden row nearest the bottom edge, and the nearest one needing attention. */
  nearestBelow: number | null;
  nearestAttentionBelow: number | null;
  /** Rows cut by the top or bottom edge: on screen, but not all of them. */
  clippedAtTop: number | null;
  clippedAtBottom: number | null;
  /**
   * The clipped row already reaches the opposite edge too — a card taller than
   * the viewport. Moving it to that edge would not move the list at all.
   */
  clippedAtTopFillsView: boolean;
  clippedAtBottomFillsView: boolean;
}

interface UseScrollIndicatorParams {
  /**
   * The full flat list backing the Virtuoso surface. Used to count worktree
   * rows (`kind === "row"`) that sit entirely outside the rendered window, and
   * to ignore section headers (`kind === "header"`) when tallying hidden rows.
   */
  items: ReadonlyArray<ScrollIndicatorItem>;
  /**
   * Worktrees in the "Attention" bucket. Kept apart from `items` so an
   * agent changing state does not change the list's identity, which would
   * throw away the measured geometry and blank both pills for a frame.
   */
  attentionWorktreeIds: ReadonlySet<string>;
  /** Used to jump by index, since the row a pill targets is usually unmounted. */
  virtuosoRef: RefObject<Pick<VirtuosoHandle, "scrollToIndex"> | null>;
  /** False under reduced motion: a long smooth scroll is exactly the motion it asks to drop. */
  smoothScroll: boolean;
}

interface UseScrollIndicatorReturn {
  hiddenAbove: HiddenSide;
  hiddenBelow: HiddenSide;
  /**
   * Reveal what the above pill reports: the nearest worktree needing attention when there
   * is one, otherwise the next screenful — never the far end of the list,
   * which throws away the place the person was reading.
   */
  revealAbove: () => void;
  revealBelow: () => void;
  /** Plug into Virtuoso's `scrollerRef` prop. Captures the scrolling element. */
  scrollerRef: (el: HTMLElement | Window | null) => void;
  /** Plug into Virtuoso's `onScroll` prop. */
  handleScroll: () => void;
  /** Plug into Virtuoso's `itemsRendered` prop. Captures per-item geometry. */
  handleItemsRendered: (rendered: ListItem<ScrollIndicatorItem>[]) => void;
}

function sameSide(a: HiddenSide, b: HiddenSide): boolean {
  return a.count === b.count && a.attention === b.attention;
}

function useScrollIndicator({
  items,
  attentionWorktreeIds,
  virtuosoRef,
  smoothScroll,
}: UseScrollIndicatorParams): UseScrollIndicatorReturn {
  const [hiddenAbove, setHiddenAboveState] = useState<HiddenSide>(NO_HIDDEN);
  const [hiddenBelow, setHiddenBelowState] = useState<HiddenSide>(NO_HIDDEN);
  // A fresh object every frame would re-render the sidebar on every scroll
  // frame; only a real change in either number should.
  const setHiddenAbove = useCallback(
    (next: HiddenSide) => setHiddenAboveState((prev) => (sameSide(prev, next) ? prev : next)),
    []
  );
  const setHiddenBelow = useCallback(
    (next: HiddenSide) => setHiddenBelowState((prev) => (sameSide(prev, next) ? prev : next)),
    []
  );
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  // Latest `items` mirrored into a ref so the stable callbacks below always read
  // the current list without taking it as a dependency (which would churn their
  // identity and break the rAF coalescing). Updated in an effect — all readers
  // (Virtuoso callbacks, scroll/resize handlers, the items-changed effect) run
  // after commit, so the ref is current by the time they read it.
  const itemsRef = useRef(items);
  const attentionRef = useRef(attentionWorktreeIds);
  const smoothScrollRef = useRef(smoothScroll);
  useEffect(() => {
    itemsRef.current = items;
    attentionRef.current = attentionWorktreeIds;
    smoothScrollRef.current = smoothScroll;
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

  const classify = useCallback((): Classification | null => {
    const scroller = scrollerElRef.current;
    if (!scroller) return null;

    const items = itemsRef.current;
    const rendered = renderedItemsRef.current;
    // No usable geometry: either nothing has been measured yet, or the cached
    // geometry belongs to a previous list layout. Virtuoso re-fires
    // `itemsRendered` for the current list momentarily, refreshing the tag.
    if (rendered.length === 0 || geometryItemsRef.current !== items) {
      return {
        above: NO_HIDDEN,
        below: NO_HIDDEN,
        nearestAbove: null,
        nearestAttentionAbove: null,
        nearestBelow: null,
        nearestAttentionBelow: null,
        clippedAtTop: null,
        clippedAtBottom: null,
        clippedAtTopFillsView: false,
        clippedAtBottomFillsView: false,
      };
    }

    const { scrollTop, clientHeight } = scroller;
    const viewportTop = scrollTop;
    const viewportBottom = scrollTop + clientHeight;
    const attention = attentionRef.current;

    const firstRenderedIndex = rendered[0]!.index;
    const lastRenderedIndex = rendered[rendered.length - 1]!.index;

    const result: Classification = {
      above: { count: 0, attention: 0 },
      below: { count: 0, attention: 0 },
      nearestAbove: null,
      nearestAttentionAbove: null,
      nearestBelow: null,
      nearestAttentionBelow: null,
      clippedAtTop: null,
      clippedAtBottom: null,
      clippedAtTopFillsView: false,
      clippedAtBottomFillsView: false,
    };

    // Indices only ever increase through these three passes, so "nearest" is
    // the LAST hidden row seen above and the FIRST hidden row seen below.
    const markAbove = (index: number) => {
      const item = items[index]!;
      result.above.count++;
      result.nearestAbove = index;
      if (item.worktreeId !== undefined && attention.has(item.worktreeId)) {
        result.above.attention++;
        result.nearestAttentionAbove = index;
      }
    };
    const markBelow = (index: number) => {
      const item = items[index]!;
      result.below.count++;
      result.nearestBelow ??= index;
      if (item.worktreeId !== undefined && attention.has(item.worktreeId)) {
        result.below.attention++;
        result.nearestAttentionBelow ??= index;
      }
    };

    // Rows that sit entirely outside the rendered window are unmounted, so they
    // carry no geometry — count them straight from the backing list by index.
    for (let i = 0; i < firstRenderedIndex && i < items.length; i++) {
      if (items[i]!.kind === "row") markAbove(i);
    }

    // Rendered rows: classify each against the live viewport using its measured
    // offset/size. A partially-visible row counts as visible (not hidden).
    for (const item of rendered) {
      if (item.data?.kind !== "row" || item.index >= items.length) continue;
      if (item.offset + item.size <= viewportTop + VISIBILITY_EPSILON_PX) {
        markAbove(item.index);
      } else if (item.offset >= viewportBottom - VISIBILITY_EPSILON_PX) {
        markBelow(item.index);
      } else {
        const startsAtOrAboveTop = item.offset <= viewportTop + VISIBILITY_EPSILON_PX;
        const endsAtOrBelowBottom =
          item.offset + item.size >= viewportBottom - VISIBILITY_EPSILON_PX;
        if (item.offset < viewportTop - VISIBILITY_EPSILON_PX) {
          result.clippedAtTop = item.index;
          result.clippedAtTopFillsView = endsAtOrBelowBottom;
        }
        if (
          result.clippedAtBottom === null &&
          item.offset + item.size > viewportBottom + VISIBILITY_EPSILON_PX
        ) {
          result.clippedAtBottom = item.index;
          result.clippedAtBottomFillsView = startsAtOrAboveTop;
        }
      }
    }

    for (let i = lastRenderedIndex + 1; i < items.length; i++) {
      if (items[i]!.kind === "row") markBelow(i);
    }

    return result;
  }, []);

  const updateScrollIndicators = useCallback(() => {
    const result = classify();
    if (!result) return;
    setHiddenAbove(result.above);
    setHiddenBelow(result.below);
  }, [classify, setHiddenAbove, setHiddenBelow]);

  // Recompute when the backing list changes (filter, sort, group toggle). Until
  // Virtuoso re-fires `itemsRendered` with geometry tagged for the new list, the
  // identity guard inside `updateScrollIndicators` yields a conservative 0/0
  // rather than measuring stale offsets against the new layout.
  useEffect(() => {
    updateScrollIndicators();
  }, [items, updateScrollIndicators]);

  // An agent starting or stopping waiting changes what the pills report without
  // anything scrolling, so the set is a recompute trigger of its own.
  useEffect(() => {
    updateScrollIndicators();
  }, [attentionWorktreeIds, updateScrollIndicators]);

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

  const scrollerRef = useCallback(
    (el: HTMLElement | Window | null) => {
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
        setHiddenAbove(NO_HIDDEN);
        setHiddenBelow(NO_HIDDEN);
      }
    },
    [setHiddenAbove, setHiddenBelow]
  );

  // A worktree needing attention is centred, so it lands clear of both pills
  // with its neighbours for context. Without one, it is a page step: the row
  // the edge was cutting through (or, failing that, the nearest hidden one)
  // moves to the opposite edge, so nothing half-read is skipped and everything
  // newly on screen is what came next. A clipped card taller than the view is
  // already at both edges, so aligning it would not move the list; that case
  // scrolls by one viewport instead, which still walks through the card.
  const revealAbove = useCallback(() => {
    const result = classify();
    const virtuoso = virtuosoRef.current;
    const scroller = scrollerElRef.current;
    if (!result || !virtuoso || !scroller) return;
    const behavior = smoothScrollRef.current ? "smooth" : "auto";
    if (result.nearestAttentionAbove !== null) {
      virtuoso.scrollToIndex({ index: result.nearestAttentionAbove, align: "center", behavior });
    } else if (result.clippedAtTopFillsView) {
      scroller.scrollTo({ top: scroller.scrollTop - scroller.clientHeight, behavior });
    } else if (result.nearestAbove !== null) {
      const index = result.clippedAtTop ?? result.nearestAbove;
      virtuoso.scrollToIndex({ index, align: "end", behavior });
    }
  }, [classify, virtuosoRef]);

  const revealBelow = useCallback(() => {
    const result = classify();
    const virtuoso = virtuosoRef.current;
    const scroller = scrollerElRef.current;
    if (!result || !virtuoso || !scroller) return;
    const behavior = smoothScrollRef.current ? "smooth" : "auto";
    if (result.nearestAttentionBelow !== null) {
      virtuoso.scrollToIndex({ index: result.nearestAttentionBelow, align: "center", behavior });
    } else if (result.clippedAtBottomFillsView) {
      scroller.scrollTo({ top: scroller.scrollTop + scroller.clientHeight, behavior });
    } else if (result.nearestBelow !== null) {
      const index = result.clippedAtBottom ?? result.nearestBelow;
      virtuoso.scrollToIndex({ index, align: "start", behavior });
    }
  }, [classify, virtuosoRef]);

  return {
    hiddenAbove,
    hiddenBelow,
    revealAbove,
    revealBelow,
    scrollerRef,
    handleScroll,
    handleItemsRendered,
  };
}

export { useScrollIndicator };
