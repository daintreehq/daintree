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

  // Pending is its own flag rather than "has a frame id": a frame callback that
  // runs before requestAnimationFrame returns would otherwise leave its stale id
  // behind and block every later update.
  const framePendingRef = useRef(false);
  const throttledUpdate = useCallback(() => {
    if (framePendingRef.current) return;
    framePendingRef.current = true;
    rafRef.current = requestAnimationFrame(() => {
      framePendingRef.current = false;
      rafRef.current = null;
      updateScrollState();
    });
  }, [updateScrollState]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    // Scheduled, not read here: a synchronous scrollHeight read in the mount
    // effect forced a layout of a surface still settling in its opening
    // commit (the launcher's popover paid ~10ms for it before first paint).
    // The shadows are not needed for that first frame.
    throttledUpdate();

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
      framePendingRef.current = false;
      resizeObserver.disconnect();
      el.removeEventListener("scroll", throttledUpdate);
    };
  }, [scrollRef, updateScrollState, throttledUpdate]);

  return {
    canScrollUp: state.canScrollUp,
    canScrollDown: state.canScrollDown,
  };
}
