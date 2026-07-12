import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { isDocumentHidden, revealUntilStable } from "@/services/terminal/revealUntilStable";
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
/**
 * Terminal ids affected by a sidebar/assistant-panel width change on the active
 * worktree: every grid panel on the active worktree plus the assistant's dock
 * terminal. Shared by the toggle-time suppression (suppressSidebarResizes,
 * TTL-based) and the drag-time resize lock (AppLayout's sidebar/assistant
 * divider drag, boolean lockResize). Both reflow `<main flex:1>`, which holds
 * the grid.
 */
export function getSidebarAffectedTerminalIds(): string[] {
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
  return ids;
}

export function suppressSidebarResizes(): void {
  const ids = getSidebarAffectedTerminalIds();
  terminalInstanceService.suppressResizesDuringLayoutTransition(ids, SIDEBAR_TOGGLE_LOCK_MS);
  // Block ResizeObserver-driven grid-width re-renders for the same window.
  // PTY suppression alone leaves the visual grid jittering as `<main flex:1>`
  // reflows every frame against the animating sidebar slot (see #6979).
  lockSidebarLayoutTransition(SIDEBAR_TOGGLE_LOCK_MS);
}

// Ceiling on the wait for the assistant's xterm to attach after its terminal id
// binds. `setTerminal` publishes a RESERVED id synchronously, before addPanel is
// even awaited (#6953), so the id lands well ahead of the panel commit, the
// TerminalPane mount, and xterm's open() — the wait absorbs that provisioning
// latency so the bounded frame loop below only has to cover post-attach layout
// settling. Matches addPanel's own startup attach gate. On timeout the
// obligation stays ARMED: a later binding (or the next show settle) retries it,
// which is strictly better than dropping the repaint the way #11070 did.
const ASSISTANT_ATTACH_SETTLE_TIMEOUT_MS = 2500;

/**
 * Owns the Assistant terminal's post-transition reveal repaint as a durable
 * obligation rather than a one-shot (#11070).
 *
 * The repaint has to fire when the sidebar's slide settles, but on a COLD first
 * open the assistant session is still provisioning at that moment: the help
 * store has no `terminalId`, so the old one-shot returned early and the single
 * authoritative geometry pass was dropped for good — the footer stayed unpainted
 * until some unrelated geometry pass happened to fire (a project switch-back,
 * which is why the bug looked intermittent). The obligation is now retained and
 * discharged once the terminal actually binds AND attaches.
 *
 * Bounded and singular by construction — this is the sole owner of the
 * sidebar-transition reveal trigger, and it must stay that way. HelpPanel must
 * NOT grow a parallel per-frame repaint cascade: a second geometry reconcile
 * racing this one against live PTY output corrupts xterm's line-wrap metadata
 * (#10863). The project-view `app:view-revealed` sweep is a separate trigger
 * domain with its own owner (repaintActiveWorktreeTerminals) — do not call it
 * from here; it repaints every grid terminal on the active worktree.
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
 *
 * The factory is pure — it installs no subscriptions and starts no timers, so a
 * React 19 Strict Mode double-invoke of the lazy initializer is free. Ownership
 * is AppLayout's: the obligation's lifetime is exactly the lifetime of the DOM
 * whose transition produces it.
 */
export interface AssistantRevealCoordinator {
  /** Install the help-store subscription. Returns its disposer. */
  start: () => () => void;
  /**
   * Track assistant visibility. A hide cancels any outstanding obligation at the
   * STATE change, not at the hide animation's end — a terminal that binds while
   * the panel is sliding away must not be repainted into a hidden pane.
   */
  setVisible: (visible: boolean) => void;
  /**
   * The slide settled (or was suppressed entirely). On a show, repaint now if the
   * terminal is paintable; otherwise retain the obligation. On a hide, cancel.
   */
  settleAfterTransition: (isShown: boolean) => void;
}

export function createAssistantRevealCoordinator(): AssistantRevealCoordinator {
  let visible = false;
  let pending = false;
  // Monotonic obligation stamp. Bumped on every hide, every fresh settle, and
  // every re-bind, so an in-flight attach wait or frame loop belonging to a
  // superseded obligation can neither repaint nor clear the current one.
  let generation = 0;
  let inFlight: { id: string; generation: number } | null = null;
  let unsubscribe: (() => void) | null = null;

  const cancel = (): void => {
    pending = false;
    generation++;
    inFlight = null;
  };

  const discharge = (id: string): void => {
    const stamp = generation;
    // Already chasing this exact obligation — a second store edge must not stack
    // a duplicate frame loop on top of it.
    if (inFlight && inFlight.id === id && inFlight.generation === stamp) return;
    inFlight = { id, generation: stamp };

    void (async () => {
      try {
        try {
          await terminalInstanceService.waitForAttachSettled(id, {
            timeoutMs: ASSISTANT_ATTACH_SETTLE_TIMEOUT_MS,
          });
        } catch {
          // Never attached in time. Leave `pending` armed — the next store
          // binding or show settle picks the obligation back up.
          return;
        }
        if (stamp !== generation || !visible) return;

        // repaintForReveal, NOT revealTerminal: the assistant pane keeps the
        // `isVisible` gate on the WebGL reattach (a transform-hidden pane must
        // not accumulate a fleet-wide WebGL want, #10671), and it reports FALSE
        // for a missing instance — so a still-registering terminal keeps
        // retrying instead of banking revealTerminal's "gone → settled" true.
        const painted = await revealUntilStable(
          id,
          (target) => terminalInstanceService.repaintForReveal(target),
          () => stamp !== generation || !visible || isDocumentHidden(),
          "[assistantReveal]"
        );
        if (painted && stamp === generation) pending = false;
      } finally {
        if (inFlight && inFlight.id === id && inFlight.generation === stamp) inFlight = null;
      }
    })();
  };

  return {
    start() {
      unsubscribe?.();
      const dispose = useHelpPanelStore.subscribe((state, prev) => {
        // sessionId as well as terminalId: a reserved id is finalized in place
        // when provisioning resolves, so the id alone can be edge-less on the
        // retry path after an attach-wait timeout.
        if (state.terminalId === prev.terminalId && state.sessionId === prev.sessionId) return;
        if (!state.terminalId || !pending || !visible) return;
        // A re-bind supersedes whatever the previous binding was chasing.
        generation++;
        discharge(state.terminalId);
      });
      unsubscribe = dispose;
      return () => {
        if (unsubscribe !== dispose) return;
        dispose();
        unsubscribe = null;
        cancel();
      };
    },

    setVisible(next) {
      visible = next;
      if (!next) cancel();
    },

    settleAfterTransition(isShown) {
      visible = isShown;
      if (!isShown) {
        cancel();
        return;
      }
      const assistantTerminalId = useHelpPanelStore.getState().terminalId;
      // The happy path — the terminal was already bound and paintable when the
      // slide settled (every open after the first). One pass, obligation over.
      if (assistantTerminalId && terminalInstanceService.repaintForReveal(assistantTerminalId)) {
        cancel();
        return;
      }
      // Either no terminal yet, or the host had no renderable box. Retain the
      // obligation instead of dropping the repaint (#11070).
      generation++;
      pending = true;
      inFlight = null;
      // Already bound but not yet paintable: no store edge is coming, so drive
      // the retry from here rather than waiting for a subscription that will
      // never fire.
      if (assistantTerminalId) discharge(assistantTerminalId);
    },
  };
}
