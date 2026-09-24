import { useLayoutEffect, useState } from "react";

/**
 * For a notice that an action inside it removes from a worktree card: when it
 * unmounts while one of its controls holds focus, hand focus to the card's own
 * keyboard target instead of letting it fall to <body>. Focus that has already
 * moved elsewhere is left alone. Layout cleanup runs before React detaches the
 * node, so the containment check still sees the focused control.
 *
 * Returns a callback ref for the notice's root element.
 */
export function useCardFocusHandoff<T extends HTMLElement>(): (node: T | null) => void {
  const [root, setRoot] = useState<T | null>(null);

  useLayoutEffect(() => {
    if (!root) return;
    return () => {
      if (!root.contains(document.activeElement)) return;
      const row = root.closest("[data-worktree-row]");
      const target =
        row?.querySelector<HTMLElement>("[data-card-select-overlay]") ??
        root.closest<HTMLElement>('[role="gridcell"]');
      target?.focus({ preventScroll: true });
    };
  }, [root]);

  return setRoot;
}
