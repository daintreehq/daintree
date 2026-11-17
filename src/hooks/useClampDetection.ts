import { useLayoutEffect, useRef, useState } from "react";

/**
 * Whether a `line-clamp-*` element is hiding lines. `useTruncationDetection`
 * measures width only, and a line clamp overflows downward.
 */
export function useClampDetection<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });
  return [ref, clamped] as const;
}
