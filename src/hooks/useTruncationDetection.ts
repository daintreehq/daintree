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
    const el = entry.target;
    if (!(el instanceof HTMLElement)) continue;
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

/**
 * `text`, when given, is what the element shows: a change re-measures it. Text
 * that changes in place at a fixed width (a block that fills its row) moves no
 * box edge, so the resize observer alone would never report the new overflow.
 */
export function useTruncationDetection(text?: string | number) {
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
    // Initial check, so the first paint is right without waiting on the
    // observer's first delivery.
    stableSetter.current(el.scrollWidth > el.clientWidth + TOLERANCE);
  }, []);

  // The ref callback measured the first text; only a later one needs a read.
  const measuredText = useRef(text);
  useLayoutEffect(() => {
    if (Object.is(measuredText.current, text)) return;
    measuredText.current = text;
    const el = elementRef.current;
    if (el) setIsTruncated(isElementTruncated(el));
  }, [text]);

  // Measure on mount if ResizeObserver isn't available (jsdom / SSR)
  useLayoutEffect(() => {
    const el = elementRef.current;
    if (!el || typeof ResizeObserver !== "undefined") return;
    const truncated = el.scrollWidth > el.clientWidth + TOLERANCE;
    setIsTruncated(truncated);
  }, []);

  return { ref, isTruncated };
}
