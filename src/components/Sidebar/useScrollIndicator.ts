import { useCallback, useEffect, useRef, useState } from "react";
import { useResizeObserverRaf } from "@/hooks/useResizeObserverRaf";

interface UseScrollIndicatorParams {
  itemCount: number;
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
}

function useScrollIndicator({ itemCount }: UseScrollIndicatorParams): UseScrollIndicatorReturn {
  const [hiddenAbove, setHiddenAbove] = useState(0);
  const [hiddenBelow, setHiddenBelow] = useState(0);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);

  const updateScrollIndicators = useCallback(() => {
    const scroller = scrollerElRef.current;
    if (!scroller) return;

    const { scrollTop, scrollHeight, clientHeight } = scroller;

    if (scrollHeight <= clientHeight + 1) {
      setHiddenAbove(0);
      setHiddenBelow(0);
      return;
    }

    const scrollableHeight = scrollHeight - clientHeight;
    if (scrollableHeight <= 0) {
      setHiddenAbove(0);
      setHiddenBelow(0);
      return;
    }

    const scrollFraction = Math.min(1, Math.max(0, scrollTop / scrollableHeight));
    const visibleFraction = clientHeight / scrollHeight;
    const approxVisible = Math.max(1, Math.round(itemCount * visibleFraction));
    const totalHidden = Math.max(0, itemCount - approxVisible);

    const above = Math.round(totalHidden * scrollFraction);
    const below = totalHidden - above;

    setHiddenAbove(above);
    setHiddenBelow(below);
  }, [itemCount]);

  useEffect(() => {
    updateScrollIndicators();
  }, [updateScrollIndicators, itemCount]);

  useResizeObserverRaf(scrollerEl, () => updateScrollIndicators());

  const handleScroll = useCallback(() => {
    updateScrollIndicators();
  }, [updateScrollIndicators]);

  const scrollerRef = useCallback((el: HTMLElement | Window | null) => {
    // Virtuoso forwards either the scroller element or window. We only support
    // element scrolling here (the sidebar is always an in-container scroller).
    const next = el instanceof HTMLElement ? el : null;
    scrollerElRef.current = next;
    setScrollerEl(next);
    // When Virtuoso unmounts (filter clears to an empty state), reset the
    // indicator counts so stale "5 above" badges don't briefly remain over
    // the empty state placeholder.
    if (next === null) {
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

  return { hiddenAbove, hiddenBelow, scrollToTop, scrollToBottom, scrollerRef, handleScroll };
}

export { useScrollIndicator };
