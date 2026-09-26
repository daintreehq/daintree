import { startTransition, useEffect, useState } from "react";

/** Rows a palette paints in the frame that answers the keystroke. */
export const PROGRESSIVE_INITIAL_ROWS = 30;

/**
 * How many rows of a long list to render right now.
 *
 * Opening the command palette mounted all ~240 action rows in the commit that
 * answered the keypress — about 5,000 layout objects, most of them far below
 * the fold — so the palette appeared a frame late. This renders the first
 * screenful immediately and the rest in a transition scheduled after the first
 * frame, so the rows the user can see arrive at once and the remainder never
 * blocks input (a keystroke interrupts the transition).
 *
 * `resetKey` restarts the budget: pass something that changes when the list is
 * reopened or re-queried. The limit always covers `minIndex` so keyboard
 * selection never points past what is rendered.
 */
export function useProgressiveRenderLimit(
  total: number,
  resetKey: string,
  minIndex = -1,
  initial = PROGRESSIVE_INITIAL_ROWS
): number {
  const [state, setState] = useState({ key: resetKey, limit: initial });
  const limit = state.key === resetKey ? state.limit : initial;
  const effective = Math.min(total, Math.max(limit, minIndex + 1));

  const stateKey = state.key;
  useEffect(() => {
    if (limit >= total) {
      // Nothing to expand, but the new key is recorded: otherwise a list that
      // passes through a short result set (a narrow search, or an empty list
      // while closed) and returns to a key it once expanded under would mount
      // every row again in that commit.
      if (stateKey !== resetKey) setState({ key: resetKey, limit: initial });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        startTransition(() => setState({ key: resetKey, limit: Number.POSITIVE_INFINITY }));
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
    };
  }, [limit, total, resetKey, stateKey, initial]);

  return effective;
}
