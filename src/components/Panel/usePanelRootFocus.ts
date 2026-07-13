import { useEffect } from "react";
import { registerPanelFocusHandler } from "./panelFocusRegistry";

/**
 * Give a non-PTY panel real DOM focus whenever it becomes the focused pane.
 *
 * Registering a focus handler is not enough on its own: the registry is only
 * *invoked* by macro-grid Enter and in-group tab switches. Every other path
 * that moves focus — arrow navigation, Cmd+1..9, focusNext/Previous, agent-state
 * cycling, worktree restore — just writes `focusedId`, which paints the selected
 * highlight and stops. TerminalPane has always carried its own reactive effect
 * to close that gap; without an equivalent here, a focused non-PTY panel looks
 * selected while keystrokes keep landing in whatever held the keyboard before
 * (#11133).
 *
 * Focus already inside the panel is left alone — FilePane's search box and a
 * plugin's own inputs are inside the root, so re-focusing it would yank the
 * user out of the surface they're typing in. That also makes "focus is already
 * here" a successful handoff rather than a no-op that reports failure.
 *
 * `getNode` must be referentially stable (or change exactly when the element
 * does): a consumer holding its root in state re-runs both effects when the
 * element commits, which is what lets a late-mounting root still claim focus.
 */
export function usePanelRootFocus(options: {
  id: string;
  isFocused: boolean;
  getNode: () => HTMLElement | null;
  enabled?: boolean;
}): void {
  const { id, isFocused, getNode, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return undefined;
    return registerPanelFocusHandler(id, () => focusPanelRoot(getNode()));
  }, [id, enabled, getNode]);

  useEffect(() => {
    if (!enabled || !isFocused) return;
    focusPanelRoot(getNode());
  }, [id, isFocused, enabled, getNode]);
}

/**
 * Move DOM focus to a panel root, reporting whether the panel ended up owning
 * the keyboard. Verified rather than assumed: focusing into a structurally
 * hidden subtree (the dock's `content-visibility: hidden` parking container)
 * is refused by the browser, and a handler that reported success there would
 * strand focus on nothing.
 */
function focusPanelRoot(node: HTMLElement | null): boolean {
  if (!node) return false;
  if (node.contains(document.activeElement)) return true;
  node.focus({ preventScroll: true });
  return document.activeElement === node;
}
