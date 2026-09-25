import { useCallback, useLayoutEffect, useRef } from "react";

interface UseDockLaunchPointerSelectionArgs {
  /** The index actually rendered as selected, whoever last moved it. */
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
}

interface PointerSample {
  clientX: number;
  clientY: number;
  movementX?: number;
  movementY?: number;
}

/**
 * The highlight follows the pointer the moment it moves, and only when it moves.
 *
 * Selection is driven from `pointermove`, never `pointerenter`: a row that slides
 * under a resting cursor — the list scrolling a keyboard selection into view — gets
 * an enter but no genuine move, so it cannot take the selection back from the
 * keyboard (#11919). A move whose coordinates match the last one is the browser
 * re-hit-testing a stationary pointer after a scroll, and is ignored for the same
 * reason.
 *
 * This replaced a velocity-based hover-intent gate that held the highlight back
 * until a sweep decelerated. That technique exists for cascading submenus, where a
 * diagonal path crosses rows on the way to a flyout; a flat palette has no flyout,
 * so the gate only made the highlight trail the pointer.
 */
export function useDockLaunchPointerSelection({
  selectedIndex,
  setSelectedIndex,
}: UseDockLaunchPointerSelectionArgs) {
  const latestRef = useRef({ selectedIndex, setSelectedIndex });
  useLayoutEffect(() => {
    latestRef.current = { selectedIndex, setSelectedIndex };
  }, [selectedIndex, setSelectedIndex]);

  const lastPointRef = useRef<{ x: number; y: number } | null>(null);

  return useCallback((index: number, event: PointerSample) => {
    const last = lastPointRef.current;
    const moved =
      last === null
        ? // No reference point yet: only a move the platform itself reports as
          // movement counts, so the very first synthetic re-hit-test after a
          // scroll cannot select the row it landed on.
          (event.movementX ?? 0) !== 0 || (event.movementY ?? 0) !== 0
        : event.clientX !== last.x || event.clientY !== last.y;
    lastPointRef.current = { x: event.clientX, y: event.clientY };
    if (!moved) return;
    const current = latestRef.current;
    if (current.selectedIndex !== index) current.setSelectedIndex(index);
  }, []);
}
