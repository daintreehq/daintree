import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { lockSidebarLayoutTransition } from "./layoutTransitionLock";
import { SIDEBAR_TOGGLE_LOCK_MS } from "./terminalLayout";

/**
 * Freeze PTY resize propagation across a sidebar's width transition. Without
 * this gating, the per-frame flex reflow as a sidebar animates causes xterm's
 * ResizeObserver to deliver mid-animation dimensions to the PTY host,
 * producing visible jitter on the panel grid's right edge — and, for the
 * dock-located Assistant terminal, a stuck-narrow xterm when the panel
 * collapses to 0 and back.
 *
 * Suppression covers grid panels on the active worktree (worktree-sidebar
 * transitions) and the Assistant's dock terminal (assistant-panel
 * transitions). Both transitions can be triggered from the same focus-mode
 * gesture, so we lock everything for the same duration.
 */
export function suppressSidebarResizes(): void {
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
  const panelState = usePanelStore.getState();
  const ids: string[] = [];
  for (const id of panelState.panelIds) {
    const panel = panelState.panelsById[id];
    if (panel && panel.location === "grid" && panel.worktreeId === activeWorktreeId) {
      ids.push(panel.id);
    }
  }
  const assistantTerminalId = useHelpPanelStore.getState().terminalId;
  if (assistantTerminalId && panelState.panelsById[assistantTerminalId]) {
    ids.push(assistantTerminalId);
  }
  terminalInstanceService.suppressResizesDuringLayoutTransition(ids, SIDEBAR_TOGGLE_LOCK_MS);
  // Block ResizeObserver-driven grid-width re-renders for the same window.
  // PTY suppression alone leaves the visual grid jittering as `<main flex:1>`
  // reflows every frame against the animating sidebar slot (see #6979).
  lockSidebarLayoutTransition(SIDEBAR_TOGGLE_LOCK_MS);
}

/**
 * Issue one corrective repaint to the Assistant terminal once its width
 * transition has settled. Wired to the wrapper's transitionend in AppLayout so
 * the single authoritative geometry pass fires the instant the animation ends,
 * after the per-frame ResizeObserver storm has been suppressed (#10693).
 *
 * Deliberately does NOT clear the resize lock: repaintForReveal's
 * reconcileGeometryFresh is lock-exempt (it asserts the final cols/rows whether
 * or not the lock is armed), and the suppression lock must stay live so the
 * layout-transition timer's dead-man TTL keeps gating the ResizeObserver
 * debounce tail that fires up to ~50ms after the animation settles. The lock is
 * released on its own schedule by suppressResizesDuringLayoutTransition.
 *
 * Only the settle (transitionend) path repaints — never transitioncancel: a
 * rapid hide→show fires cancel at an intermediate animating width, and
 * repainting there would assert a transient wrong column count. The cancel is
 * harmlessly ignored because the suppression timer still owns the unlock and
 * the subsequent show's transitionend issues the correct repaint.
 */
export function repaintAssistantAfterTransition(): void {
  const assistantTerminalId = useHelpPanelStore.getState().terminalId;
  if (!assistantTerminalId) return;
  terminalInstanceService.repaintForReveal(assistantTerminalId);
}
