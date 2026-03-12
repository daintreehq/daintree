import { useState, useEffect, useCallback, useRef, type RefObject } from "react";
import { getVerticalScrollState, type VerticalScrollState } from "@/lib/verticalScroll";

export interface UseVerticalScrollShadowsReturn {
  canScrollUp: boolean;
  canScrollDown: boolean;
}

export function useVerticalScrollShadows(
  scrollRef: RefObject<HTMLElement | null>
): UseVerticalScrollShadowsReturn {
  const [state, setState] = useState<VerticalScrollState>({
    isOverflowing: false,
    canScrollUp: false,
    canScrollDown: false,
  });

  const rafRef = useRef<number | null>(null);
  const lastStateRef = useRef(state);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const newState = getVerticalScrollState({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });

    if (
      newState.isOverflowing !== lastStateRef.current.isOverflowing ||
      newState.canScrollUp !== lastStateRef.current.canScrollUp ||
      newState.canScrollDown !== lastStateRef.current.canScrollDown
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

  return {
    canScrollUp: state.canScrollUp,
    canScrollDown: state.canScrollDown,
  };
}
