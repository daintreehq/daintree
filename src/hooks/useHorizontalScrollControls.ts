import { useState, useEffect, useCallback, useRef, type RefObject } from "react";
import {
  getHorizontalScrollState,
  calculateScrollAmount,
  getWheelHorizontalDelta,
  type HorizontalScrollState,
} from "@/lib/horizontalScroll";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";

export interface UseHorizontalScrollControlsReturn extends HorizontalScrollState {
  scrollLeft: () => void;
  scrollRight: () => void;
}

export interface UseHorizontalScrollControlsOptions {
  /** Let a vertical-only mouse wheel scroll the rail sideways. */
  mapVerticalWheel?: boolean;
}

export function useHorizontalScrollControls(
  scrollRef: RefObject<HTMLElement | null>,
  { mapVerticalWheel = false }: UseHorizontalScrollControlsOptions = {}
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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !mapVerticalWheel) return;

    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      const delta = getWheelHorizontalDelta(event, el.clientWidth);
      if (delta === 0) return;
      event.preventDefault();
      // Instant, not smooth: each notch lands where it points, where a smooth
      // scroll started mid-way through the last one would swallow the delta.
      el.scrollBy({ left: delta, behavior: "instant" });
    };

    // Non-passive so preventDefault can hold the vertical notch on the rail.
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scrollRef, mapVerticalWheel]);

  const scrollLeft = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = calculateScrollAmount(el.clientWidth);
    el.scrollBy({ left: -amount, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [scrollRef]);

  const scrollRight = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const amount = calculateScrollAmount(el.clientWidth);
    el.scrollBy({ left: amount, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [scrollRef]);

  return {
    ...state,
    scrollLeft,
    scrollRight,
  };
}
