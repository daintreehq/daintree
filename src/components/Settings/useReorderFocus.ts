import { useCallback, useEffect, useRef, useState } from "react";
import { armTooltipFocusSuppression } from "@/lib/tooltipFocusSuppression";

export type ReorderDirection = "up" | "down";

/**
 * Keyboard reordering for the settings list editors. The arrow a move was made
 * with does not reliably keep focus through the re-render: in a list keyed by
 * position it now belongs to the item that swapped in, and in one keyed by id
 * React may relocate its row, which blurs it in Chromium. So once the move has
 * rendered, focus goes to the moved item's arrow for the same direction.
 *
 * That arrow is always still there to take it: at the end of the list it is
 * unavailable through `aria-disabled`, never native `disabled`, which would
 * drop focus on `document.body` and, if the press repeats, let it fall to the
 * opposite arrow and move the item straight back.
 */
export function useReorderFocus() {
  const arrows = useRef(new Map<string, HTMLButtonElement>());
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (pending === null) return;
    setPending(null);
    const target = arrows.current.get(pending);
    // A list disabled as a whole while the move rendered has nothing to hold focus.
    if (!target?.isConnected || target.disabled || target === document.activeElement) return;
    // The row moved out from under a pointer press; following it with focus is
    // not hovering it, so its tooltip stays shut.
    armTooltipFocusSuppression();
    target.focus();
  }, [pending]);

  const registerArrow = useCallback(
    (key: string, direction: ReorderDirection) => (el: HTMLButtonElement | null) => {
      const slot = `${key}:${direction}`;
      if (el) arrows.current.set(slot, el);
      else arrows.current.delete(slot);
    },
    []
  );

  /** Focus `key`'s arrow for `direction` once the move has rendered. */
  const focusMoved = useCallback(
    (key: string, direction: ReorderDirection) => setPending(`${key}:${direction}`),
    []
  );

  return { registerArrow, focusMoved };
}
