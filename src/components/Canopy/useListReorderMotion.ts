import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { UI_ENTER_DURATION, UI_ENTER_EASING } from "@/lib/animationUtils";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";

const ROW_SELECTOR = "[data-canopy-card]";

/**
 * Glides the list's rows from where they were to where a re-rank put them
 * (FLIP: measure, invert, play), so the eye can follow a row that moved instead
 * of finding the list rearranged. `orderKey` changes when the order does; rows
 * are told apart by their element id. Skipped under reduced motion and
 * performance mode, where the rows simply land.
 */
export function useListReorderMotion(
  containerRef: RefObject<HTMLElement | null>,
  orderKey: string
): void {
  const topsRef = useRef<Map<string, number>>(new Map());
  // A list that has just mounted lands as it is: an order settled before its
  // first frame (an open ranking what was read while closed) is not a move.
  const armedRef = useRef(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      armedRef.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const rows = Array.from(container.querySelectorAll<HTMLElement>(ROW_SELECTOR));
    const previous = topsRef.current;
    const next = new Map<string, number>();
    for (const row of rows) next.set(row.id, row.offsetTop);
    topsRef.current = next;
    if (!armedRef.current || previous.size === 0 || prefersReducedMotion()) return;

    const moved: HTMLElement[] = [];
    for (const row of rows) {
      const before = previous.get(row.id);
      const after = next.get(row.id);
      if (before === undefined || after === undefined || before === after) continue;
      row.style.transition = "none";
      row.style.transform = `translateY(${before - after}px)`;
      moved.push(row);
    }
    if (moved.length === 0) return;
    // Commit the inverted positions before letting them go.
    void container.offsetHeight;
    for (const row of moved) {
      row.style.transition = `transform ${UI_ENTER_DURATION}ms ${UI_ENTER_EASING}`;
      row.style.transform = "";
    }
    const release = () => {
      for (const row of moved) {
        row.style.transition = "";
        row.style.transform = "";
      }
    };
    const settle = window.setTimeout(release, UI_ENTER_DURATION);
    // A re-rank mid-glide lands these rows where they belong before the next
    // glide measures them, rather than leaving the old transition on them.
    return () => {
      window.clearTimeout(settle);
      release();
    };
  }, [containerRef, orderKey]);
}
