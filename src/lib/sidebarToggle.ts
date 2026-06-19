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
 * Release the Assistant terminal's resize lock the instant its width
 * transition settles, then issue one corrective repaint. Wired to the wrapper's
 * transitionend/transitioncancel in AppLayout so the lock clears at the real
 * animation boundary instead of waiting out the dead-man TTL.
 *
 * transitioncancel is the load-bearing caller: a rapid hide→show reverses the
 * width animation mid-flight and fires transitioncancel (never transitionend),
 * so routing only transitionend here would strand the lock and silence every
 * later PTY resize for that terminal session (#10693).
 */
export function releaseAssistantResizeLock(): void {
  const assistantTerminalId = useHelpPanelStore.getState().terminalId;
  if (!assistantTerminalId) return;
  // Unlock BEFORE repainting: repaintForReveal's geometry reconciliation is
  // itself gated by the resize lock, so the single authoritative SIGWINCH it
  // sends would be swallowed if the lock were still armed.
  terminalInstanceService.lockResize(assistantTerminalId, false);
  terminalInstanceService.repaintForReveal(assistantTerminalId);
}
