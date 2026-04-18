import { useState, useEffect, useCallback, useRef, type RefObject } from "react";
import {
  getHorizontalScrollState,
  calculateScrollAmount,
  type HorizontalScrollState,
} from "@/lib/horizontalScroll";

export interface UseHorizontalScrollControlsReturn extends HorizontalScrollState {
  scrollLeft: () => void;
  scrollRight: () => void;
}

export function useHorizontalScrollControls(
  scrollRef: RefObject<HTMLElement | null>
): UseHorizontalScrollControlsReturn {
  const [state, setState] = useState<HorizontalScrollState>({
    isOverflowing: false,
    canScrollLeft: false,
    canScrollRight: false,
  });

  const rafRef = useRef<number | null>(null);
  const lastStateRef = useRef(state);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const newState = getHorizontalScrollState({
      scrollLeft: el.scrollLeft,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    });

    if (
      newState.isOverflowing !== lastStateRef.current.isOverflowing ||
      newState.canScrollLeft !== lastStateRef.current.canScrollLeft ||
      newState.canScrollRight !== lastStateRef.current.canScrollRight
    ) {
      lastStateRef.current = newState;
      setState(newState);
    }
  }, [scrollRef]);

  const throttledUpdate = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      updateScrollState();
    });
  }, [updateScrollState]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    updateScrollState();

    const resizeObserver = new ResizeObserver(throttledUpdate);
    resizeObserver.observe(el);

    const firstChild = el.firstElementChild;
    if (firstChild) {
      resizeObserver.observe(firstChild);
    }

    el.addEventListener("scroll", throttledUpdate, { passive: true });

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      resizeObserver.disconnect();
      el.removeEventListener("scroll", throttledUpdate);
    };
  }, [scrollRef, updateScrollState, throttledUpdate]);

  const scrollLeft = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = calculateScrollAmount(el.clientWidth);
    el.scrollBy({ left: -amount, behavior: "smooth" });
  }, [scrollRef]);

  const scrollRight = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = calculateScrollAmount(el.clientWidth);
    el.scrollBy({ left: amount, behavior: "smooth" });
  }, [scrollRef]);

  return {
    ...state,
    scrollLeft,
    scrollRight,
  };
}
