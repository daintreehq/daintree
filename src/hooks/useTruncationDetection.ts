import { useCallback, useLayoutEffect, useRef, useState } from "react";

const TOLERANCE = 1;

type Subscriber = {
  setTruncated: (v: boolean) => void;
  element: HTMLElement;
};

let singleton: {
  observer: ResizeObserver | null;
  subscribers: Map<HTMLElement, Subscriber>;
  rafId: number | null;
} | null = null;

function getSingleton() {
  if (!singleton) {
    singleton = { observer: null, subscribers: new Map(), rafId: null };
  }
  return singleton;
}

function scheduleCheck() {
  const s = getSingleton();
  if (s.rafId !== null) return;
  s.rafId = requestAnimationFrame(() => {
    s.rafId = null;
    for (const [el, sub] of s.subscribers) {
      if (!el.isConnected) {
        s.subscribers.delete(el);
        continue;
      }
      const truncated = el.scrollWidth > el.clientWidth + TOLERANCE;
      sub.setTruncated(truncated);
    }
  });
}

export function isElementTruncated(el: HTMLElement, tolerance = TOLERANCE): boolean {
  return el.scrollWidth > el.clientWidth + tolerance;
}

export function useTruncationDetection() {
  const [isTruncated, setIsTruncated] = useState(false);
  const elementRef = useRef<HTMLElement | null>(null);
  const stableSetter = useRef(setIsTruncated);
  stableSetter.current = setIsTruncated;

  const ref = useCallback((el: HTMLElement | null) => {
    const s = getSingleton();
    // Unregister previous element
    const prev = elementRef.current;
    if (prev && s.subscribers.has(prev)) {
      s.observer?.unobserve(prev);
      s.subscribers.delete(prev);
    }

    elementRef.current = el;

    if (!el) {
      if (s.subscribers.size === 0 && s.observer) {
        s.observer.disconnect();
        s.observer = null;
      }
      return;
    }

    s.subscribers.set(el, { setTruncated: (v) => stableSetter.current(v), element: el });

    if (!s.observer && typeof ResizeObserver !== "undefined") {
      s.observer = new ResizeObserver(() => scheduleCheck());
    }
    if (s.observer) {
      s.observer.observe(el);
    }
    // Initial check (layout-dependent; useLayoutEffect ensures after render)
    const truncated = el.scrollWidth > el.clientWidth + TOLERANCE;
    stableSetter.current(truncated);
  }, []);

  // Measure on mount if ResizeObserver isn't available (jsdom / SSR)
  useLayoutEffect(() => {
    const el = elementRef.current;
    if (!el || typeof ResizeObserver !== "undefined") return;
    const truncated = el.scrollWidth > el.clientWidth + TOLERANCE;
    setIsTruncated(truncated);
  }, []);

  return { ref, isTruncated };
}
