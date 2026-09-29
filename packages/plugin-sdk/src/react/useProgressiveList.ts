import { startTransition, useEffect, useMemo, useState } from "react";

export interface ProgressiveListOptions {
  /** Items rendered in the commit that first shows the list. Default 30. */
  initial?: number;
  /**
   * Items added per growth step. Omitted, the rest of the list arrives in one
   * transition after the first frame; set it for lists long enough that one
   * transition would still be a long task.
   */
  step?: number;
  /**
   * Restarts the budget when it changes — pass something that changes when the
   * list is reopened or re-queried. A list whose items merely update keeps the
   * budget it has grown to.
   */
  resetKey?: string | number;
  /** An index that must always be rendered, e.g. the keyboard selection. */
  minIndex?: number;
}

export interface ProgressiveListResult<T> {
  /** The prefix of `items` to render now. Stable while the items and limit are unchanged. */
  visible: readonly T[];
  /** True once every item is rendered. */
  isComplete: boolean;
}

const DEFAULT_INITIAL = 30;

/**
 * Render a long list progressively: the first screenful in the commit that
 * shows it, the rest in transitions scheduled after the first frame has
 * painted. Mounting hundreds of rows at once delays the frame the user is
 * waiting for; this lets the visible rows arrive immediately while the rest
 * never block input, because a keystroke interrupts a pending transition.
 *
 * Every item is eventually mounted, so this suits lists of up to a few hundred
 * rows. For thousands, use {@link useVirtualList}, which mounts only the rows
 * in view.
 */
export function useProgressiveList<T>(
  items: readonly T[],
  options: ProgressiveListOptions = {}
): ProgressiveListResult<T> {
  const initial = Math.max(1, options.initial ?? DEFAULT_INITIAL);
  const step = options.step !== undefined && options.step > 0 ? options.step : undefined;
  const resetKey = options.resetKey ?? "";
  const minIndex = options.minIndex ?? -1;
  const total = items.length;

  const [state, setState] = useState({ key: resetKey, limit: initial });
  const limit = state.key === resetKey ? state.limit : initial;
  const effective = Math.min(total, Math.max(limit, minIndex + 1));

  const stateKey = state.key;
  useEffect(() => {
    if (effective >= total) {
      // Record the key even with nothing to grow, so a list that passes
      // through a short result set and returns to a key it once expanded
      // under starts from the initial budget rather than mounting everything.
      if (stateKey !== resetKey) setState({ key: resetKey, limit });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const next = step === undefined ? Number.POSITIVE_INFINITY : limit + step;
    // A frame first so the initial rows paint, then a task so the growth
    // render does not run inside that frame's rAF callbacks.
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => {
        startTransition(() => setState({ key: resetKey, limit: next }));
      }, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
    };
  }, [limit, effective, total, resetKey, stateKey, step]);

  const visible = useMemo(
    () => (effective >= total ? items : items.slice(0, effective)),
    [items, effective, total]
  );
  return { visible, isComplete: effective >= total };
}
