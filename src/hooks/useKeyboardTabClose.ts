import { useCallback, useEffect, useRef } from "react";

interface PendingClose<T> {
  closing: T;
  successor: T | undefined;
  closingWasActive: boolean;
}

export interface UseKeyboardTabCloseOptions<T> {
  /** The strip's tabs, in order. */
  ids: readonly T[];
  /** The selected tab, as the host reports it after each commit. */
  activeId: T | null;
  /** Move keyboard focus to one tab. */
  focusTab: (id: T) => void;
  /** Where focus goes when the last tab closes, if the strip survives that. */
  onEmpty?: () => void;
}

/**
 * Delete-to-close for a document tab strip, with focus landing on the right tab
 * once the close has actually happened.
 *
 * A close only asks: a dirty file or a live agent can raise a confirm first, so
 * any amount of time can pass before the tab is gone, and the tab list is
 * rebuilt for many other reasons meanwhile. So the ask records which tab is
 * closing and where focus should go, and the handoff waits for THAT tab to be
 * absent. Closing the selected tab follows the selection the host picks next;
 * closing another tab moves to its neighbour, the following one first.
 *
 * `disarm` stands the handoff down: focus arriving back on the closing tab (a
 * cancelled confirm returning it) or a pointer close, which leaves focus where
 * it was.
 */
export function useKeyboardTabClose<T>({
  ids,
  activeId,
  focusTab,
  onEmpty,
}: UseKeyboardTabCloseOptions<T>) {
  const pendingRef = useRef<PendingClose<T> | null>(null);

  useEffect(() => {
    const pending = pendingRef.current;
    if (!pending || ids.includes(pending.closing)) return;
    pendingRef.current = null;
    if (ids.length === 0) {
      onEmpty?.();
      return;
    }
    const target =
      pending.closingWasActive && activeId !== null && ids.includes(activeId)
        ? activeId
        : pending.successor;
    if (target !== undefined && ids.includes(target)) focusTab(target);
  }, [ids, activeId, focusTab, onEmpty]);

  const armKeyboardClose = useCallback(
    (closing: T) => {
      const index = ids.indexOf(closing);
      if (index === -1) return;
      pendingRef.current = {
        closing,
        successor: ids[index + 1] ?? ids[index - 1],
        closingWasActive: closing === activeId,
      };
    },
    [ids, activeId]
  );

  const disarmKeyboardClose = useCallback((id?: T) => {
    if (id === undefined || pendingRef.current?.closing === id) pendingRef.current = null;
  }, []);

  return { armKeyboardClose, disarmKeyboardClose };
}

/** The keys that close the focused tab in every document tab strip. */
export function isTabCloseKey(key: string): boolean {
  return key === "Delete" || key === "Backspace";
}
