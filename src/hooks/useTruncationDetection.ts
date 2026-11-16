import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const TOLERANCE = 1;

type Subscriber = {
  setTruncated: (v: boolean) => void;
  element: HTMLElement;
};

let singleton: {
  observer: ResizeObserver | null;
  subscribers: Map<HTMLElement, Subscriber>;
} | null = null;

function getSingleton() {
  if (!singleton) {
    singleton = { observer: null, subscribers: new Map() };
  }
  return singleton;
}

// Only the elements the observer reported: a resize elsewhere says nothing
// about the other labels, and the callback runs after layout, so reading
// scrollWidth here does not force a reflow.
function checkEntries(entries: ResizeObserverEntry[]) {
  const s = getSingleton();
  for (const entry of entries) {
    const el = entry.target as HTMLElement;
    const sub = s.subscribers.get(el);
    if (!sub) continue;
    if (!el.isConnected) {
      s.subscribers.delete(el);
      s.observer?.unobserve(el);
      continue;
    }
    sub.setTruncated(el.scrollWidth > el.clientWidth + TOLERANCE);
  }
}

export function isElementTruncated(el: HTMLElement, tolerance = TOLERANCE): boolean {
  return el.scrollWidth > el.clientWidth + tolerance;
}

export function useTruncationDetection() {
  const [isTruncated, setIsTruncated] = useState(false);
  const elementRef = useRef<HTMLElement | null>(null);
  const stableSetter = useRef(setIsTruncated);
  useEffect(() => {
    stableSetter.current = setIsTruncated;
  }, [setIsTruncated]);

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
      s.observer = new ResizeObserver(checkEntries);
    }
    if (s.observer) {
      s.observer.observe(el);
    }
    // No synchronous measure here: a newly observed element gets an initial
    // observation, which checkEntries answers without a forced reflow in the
    // commit phase.
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
