import { useEffect, useRef } from "react";

// Detects the cold-title gap by comparing the forge number to its
// previous-render value via a ref; the lag (ref written in effect, no
// re-render) is what keeps the gap true across the 400ms suppression window
// (#8079). Replacing the ref with state breaks that lag and flashes the #NNN
// fallback. Isolated here so the render-time ref read doesn't force the badge
// components themselves out of compiler memoization; the compiler never
// caches values derived from ref.current, so the lag survives compilation.
export function useColdNumberGap(num: number, title: string | undefined, enabled = true): boolean {
  // The render-time `prev.current` read below is intentional (it's the whole
  // mechanism). Opt this hook out of the React Compiler so the read is a
  // deliberate non-reactive value rather than a "Cannot access refs during
  // render" compile error.
  "use no memo";
  const prev = useRef<number | undefined>(undefined);
  const gap = enabled && !title && num !== prev.current;
  useEffect(() => {
    prev.current = num;
  }, [num]);
  return gap;
}
