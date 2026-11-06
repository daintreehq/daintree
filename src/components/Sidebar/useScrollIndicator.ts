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
  /**
   * How many report something broken that no agent is asking about (conflict,
   * failing CI, failed setup, failed sign-in), and the worst tone among them.
   */
  problem: number;
  problemTone: "error" | "warning" | null;
}

const NO_HIDDEN: HiddenSide = { count: 0, attention: 0, problem: 0, problemTone: null };

/** How much of each edge of the scroller a pill's band currently covers. */
export interface BandInsets {
  top: number;
  bottom: number;
}

// What one wheel "line" scrolls by when a band forwards a line-mode wheel
// event. Matches Chromium's own per-line scroll step.
const WHEEL_LINE_PX = 40;

// A list shorter than this many band heights has no room to give two of them
// up and still show a row between, so the pills step aside instead.
const MIN_VIEWPORT_IN_BANDS = 3;

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
  nearestProblemAbove: number | null;
  /** The hidden row nearest the bottom edge, and the nearest one needing attention. */
  nearestBelow: number | null;
  nearestAttentionBelow: number | null;
  nearestProblemBelow: number | null;
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

function emptyClassification(): Classification {
  return {
    above: { ...NO_HIDDEN },
    below: { ...NO_HIDDEN },
    nearestAbove: null,
    nearestAttentionAbove: null,
    nearestProblemAbove: null,
    nearestBelow: null,
    nearestAttentionBelow: null,
    nearestProblemBelow: null,
    clippedAtTop: null,
    clippedAtBottom: null,
    clippedAtTopFillsView: false,
    clippedAtBottomFillsView: false,
  };
}

function worseTone(
  current: "error" | "warning" | null,
  next: "error" | "warning"
): "error" | "warning" {
  return current === "error" || next === "error" ? "error" : "warning";
}

const NO_PROBLEMS: ReadonlyMap<string, "error" | "warning"> = new Map();

/** Classifies the list against one viewport, given as content offsets. */
function classifyBetween(
  items: ReadonlyArray<ScrollIndicatorItem>,
  rendered: ReadonlyArray<ListItem<ScrollIndicatorItem>>,
  attention: ReadonlySet<string>,
  problems: ReadonlyMap<string, "error" | "warning">,
  viewportTop: number,
  viewportBottom: number
): Classification {
  const firstRenderedIndex = rendered[0]!.index;
  const lastRenderedIndex = rendered[rendered.length - 1]!.index;
  const result = emptyClassification();

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
    // A row already counted as waiting is not counted again: one row, one flag.
    const waiting = item.worktreeId !== undefined && attention.has(item.worktreeId);
    const tone =
      item.worktreeId !== undefined && !waiting ? problems.get(item.worktreeId) : undefined;
    if (tone) {
      result.above.problem++;
      result.above.problemTone = worseTone(result.above.problemTone, tone);
      result.nearestProblemAbove = index;
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
    // A row already counted as waiting is not counted again: one row, one flag.
    const waiting = item.worktreeId !== undefined && attention.has(item.worktreeId);
    const tone =
      item.worktreeId !== undefined && !waiting ? problems.get(item.worktreeId) : undefined;
    if (tone) {
      result.below.problem++;
      result.below.problemTone = worseTone(result.below.problemTone, tone);
      result.nearestProblemBelow ??= index;
    }
  };

  // Rows that sit entirely outside the rendered window are unmounted, so they
  // carry no geometry — count them straight from the backing list by index.
  for (let i = 0; i < firstRenderedIndex && i < items.length; i++) {
    if (items[i]!.kind === "row") markAbove(i);
  }

  // Rendered rows: classify each against the viewport using its measured
  // offset/size. A partially-visible row counts as visible (not hidden).
  for (const item of rendered) {
    if (item.data?.kind !== "row" || item.index >= items.length) continue;
    if (item.offset + item.size <= viewportTop + VISIBILITY_EPSILON_PX) {
      markAbove(item.index);
    } else if (item.offset >= viewportBottom - VISIBILITY_EPSILON_PX) {
      markBelow(item.index);
    } else {
      const startsAtOrAboveTop = item.offset <= viewportTop + VISIBILITY_EPSILON_PX;
      const endsAtOrBelowBottom = item.offset + item.size >= viewportBottom - VISIBILITY_EPSILON_PX;
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
  /** Worktrees reporting a problem, by tone. Kept apart from `items` likewise. */
  problemWorktreeTones?: ReadonlyMap<string, "error" | "warning">;
  /** Used to jump by index, since the row a pill targets is usually unmounted. */
  virtuosoRef: RefObject<Pick<VirtuosoHandle, "scrollToIndex"> | null>;
  /** False under reduced motion: a long smooth scroll is exactly the motion it asks to drop. */
  smoothScroll: boolean;
  /**
   * Height of the opaque band each pill sits in. A shown band is the list's
   * edge on that side: rows behind it count as hidden, and a reveal parks its
   * row clear of it. 0 (the default) measures against the bare scroller.
   */
  bandHeightPx?: number;
  /** True while a drag is in flight: both pills and their bands step aside. */
  paused?: boolean;
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
  /** The edges a shown band covers, for the scroller's `scroll-padding`. */
  bandInsets: BandInsets;
  /**
   * Plug into each band's `onWheel`. The band covers the list rather than
   * sitting inside it, so a wheel over it would otherwise scroll nothing.
   */
  handleBandWheel: (event: Pick<WheelEvent, "deltaY" | "deltaMode" | "ctrlKey">) => void;
  /** Plug into Virtuoso's `scrollerRef` prop. Captures the scrolling element. */
  scrollerRef: (el: HTMLElement | Window | null) => void;
  /** Plug into Virtuoso's `onScroll` prop. */
  handleScroll: () => void;
  /** Plug into Virtuoso's `itemsRendered` prop. Captures per-item geometry. */
  handleItemsRendered: (rendered: ListItem<ScrollIndicatorItem>[]) => void;
}

// The space between the bands when both are up, so a step through a card
// taller than the view shows what was behind the far band next, not past it.
// Always positive: `classify` drops the bands from a list too short for them.
function pageStep(scroller: HTMLElement, band: number): number {
  return scroller.clientHeight - 2 * band;
}

function sameSide(a: HiddenSide, b: HiddenSide): boolean {
  return (
    a.count === b.count &&
    a.attention === b.attention &&
    a.problem === b.problem &&
    a.problemTone === b.problemTone
  );
}

function useScrollIndicator({
  items,
  attentionWorktreeIds,
  problemWorktreeTones = NO_PROBLEMS,
  virtuosoRef,
  smoothScroll,
  bandHeightPx = 0,
  paused = false,
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
  const problemsRef = useRef(problemWorktreeTones);
  const smoothScrollRef = useRef(smoothScroll);
  const bandHeightRef = useRef(bandHeightPx);
  const pausedRef = useRef(paused);
  useEffect(() => {
    itemsRef.current = items;
    attentionRef.current = attentionWorktreeIds;
    problemsRef.current = problemWorktreeTones;
    smoothScrollRef.current = smoothScroll;
    bandHeightRef.current = bandHeightPx;
    pausedRef.current = paused;
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
    // Paused, or no usable geometry: either nothing has been measured yet, or
    // the cached geometry belongs to a previous list layout. Virtuoso re-fires
    // `itemsRendered` for the current list momentarily, refreshing the tag.
    if (pausedRef.current || rendered.length === 0 || geometryItemsRef.current !== items) {
      return emptyClassification();
    }

    const { scrollTop, clientHeight } = scroller;
    const band = bandHeightRef.current;
    if (band > 0 && clientHeight < band * MIN_VIEWPORT_IN_BANDS) return emptyClassification();
    const attention = attentionRef.current;
    const problems = problemsRef.current;
    const physical = classifyBetween(
      items,
      rendered,
      attention,
      problems,
      scrollTop,
      scrollTop + clientHeight
    );

    // Two passes, so a band can never hold itself open. Whether an edge gets
    // a band is decided against the bare scroller; only what the pills report
    // and reveal is measured inside the bands. Fed back, a short first row
    // sitting wholly behind the top band would keep that band up even with
    // the list scrolled to the very top.
    const top = physical.above.count > 0 ? band : 0;
    const bottom = physical.below.count > 0 ? band : 0;
    if (top === 0 && bottom === 0) return physical;
    return classifyBetween(
      items,
      rendered,
      attention,
      problems,
      scrollTop + top,
      scrollTop + clientHeight - bottom
    );
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
  }, [attentionWorktreeIds, problemWorktreeTones, updateScrollIndicators]);

  useEffect(() => {
    updateScrollIndicators();
  }, [bandHeightPx, paused, updateScrollIndicators]);

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

  // A worktree needing attention is centred, so it lands clear of both bands
  // with its neighbours for context (a card taller than the space between
  // them can't be). Without one, it is a page step: the row the edge was
  // cutting through (or, failing that, the nearest hidden one) moves to the
  // opposite edge, so nothing half-read is skipped and everything newly on
  // screen is what came next. That edge will carry a band once the list has
  // moved, since the step itself hides rows behind it, so the row is parked a
  // band's height in from it. A clipped card taller than the view is already
  // at both edges, so aligning it would not move the list; that case scrolls
  // by the space between the bands instead, which still walks through it.
  const revealAbove = useCallback(() => {
    const result = classify();
    const virtuoso = virtuosoRef.current;
    const scroller = scrollerElRef.current;
    if (!result || !virtuoso || !scroller) return;
    const behavior = smoothScrollRef.current ? "smooth" : "auto";
    const band = bandHeightRef.current;
    const nearestFlaggedAbove = result.nearestAttentionAbove ?? result.nearestProblemAbove;
    if (nearestFlaggedAbove !== null) {
      virtuoso.scrollToIndex({ index: nearestFlaggedAbove, align: "center", behavior });
    } else if (result.clippedAtTopFillsView) {
      scroller.scrollTo({ top: scroller.scrollTop - pageStep(scroller, band), behavior });
    } else if (result.nearestAbove !== null) {
      const index = result.clippedAtTop ?? result.nearestAbove;
      virtuoso.scrollToIndex({ index, align: "end", offset: band, behavior });
    }
  }, [classify, virtuosoRef]);

  const revealBelow = useCallback(() => {
    const result = classify();
    const virtuoso = virtuosoRef.current;
    const scroller = scrollerElRef.current;
    if (!result || !virtuoso || !scroller) return;
    const behavior = smoothScrollRef.current ? "smooth" : "auto";
    const band = bandHeightRef.current;
    const nearestFlaggedBelow = result.nearestAttentionBelow ?? result.nearestProblemBelow;
    if (nearestFlaggedBelow !== null) {
      virtuoso.scrollToIndex({ index: nearestFlaggedBelow, align: "center", behavior });
    } else if (result.clippedAtBottomFillsView) {
      scroller.scrollTo({ top: scroller.scrollTop + pageStep(scroller, band), behavior });
    } else if (result.nearestBelow !== null) {
      const index = result.clippedAtBottom ?? result.nearestBelow;
      virtuoso.scrollToIndex({ index, align: "start", offset: -band, behavior });
    }
  }, [classify, virtuosoRef]);

  const handleBandWheel = useCallback(
    (event: Pick<WheelEvent, "deltaY" | "deltaMode" | "ctrlKey">) => {
      const scroller = scrollerElRef.current;
      // Ctrl+wheel is a zoom gesture (and a trackpad pinch), never a scroll.
      if (!scroller || event.ctrlKey || event.deltaY === 0) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? WHEEL_LINE_PX
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scroller.clientHeight
            : 1;
      scroller.scrollBy({ top: event.deltaY * unit });
    },
    []
  );

  // A pill shows exactly when its edge has a row wholly past the bare
  // scroller, which is exactly when `classify` gave that edge a band.
  const bandInsets: BandInsets = {
    top: hiddenAbove.count > 0 ? bandHeightPx : 0,
    bottom: hiddenBelow.count > 0 ? bandHeightPx : 0,
  };

  return {
    hiddenAbove,
    hiddenBelow,
    revealAbove,
    revealBelow,
    bandInsets,
    handleBandWheel,
    scrollerRef,
    handleScroll,
    handleItemsRendered,
  };
}

export { useScrollIndicator };
