import { terminalInstanceService } from "@/services/terminal/TerminalInstanceService";
import { isDocumentHidden, revealUntilStable } from "@/services/terminal/revealUntilStable";
import { useHelpPanelStore, selectActiveSlot, selectSlotTerminalIds } from "@/store/helpPanelStore";
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
 * TTL-based), the drag-time resize lock (AppLayout's sidebar/assistant divider
 * drag, boolean lockResize), and the diagnostics dock's height transition
 * (signalDiagnosticsDockLayoutChange, #12264). All of them reflow
 * `<main flex:1>`, which holds the grid — the affected set is the same whether
 * the row loses width or height.
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
  // Every lane (#12108): a background assistant's xterm is still mounted and
  // still needs its resizes suppressed during the transition.
  for (const assistantTerminalId of selectSlotTerminalIds(useHelpPanelStore.getState())) {
    if (panelState.panelsById[assistantTerminalId]) ids.push(assistantTerminalId);
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
// A timed-out attach waiter is deregistered, so a single wait would silently
// abandon a terminal that attaches a moment after the deadline. Re-arm the wait
// a bounded number of times (~7.5s total) — long enough to cover a slow cold
// agent spawn, short enough that a genuinely dead binding stops costing frames.
const ASSISTANT_ATTACH_WAIT_ATTEMPTS = 3;

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

    const isStale = (): boolean => stamp !== generation || !visible;

    void (async () => {
      try {
        // waitForAttachSettled resolves IMMEDIATELY when the terminal is already
        // attached (the warm open, every time after the first) and otherwise
        // parks on the attach notification. It REJECTS on timeout, and a
        // timed-out waiter is deregistered — so a terminal that attaches just
        // after the deadline would never wake us again, and with the sidebar
        // still open no further settle or store edge is coming. That is #11070
        // with a longer fuse, so the wait is retried rather than abandoned.
        let attached = false;
        for (let attempt = 0; attempt < ASSISTANT_ATTACH_WAIT_ATTEMPTS; attempt++) {
          if (isStale()) return;
          try {
            await terminalInstanceService.waitForAttachSettled(id, {
              timeoutMs: ASSISTANT_ATTACH_SETTLE_TIMEOUT_MS,
            });
            attached = true;
            break;
          } catch {
            // Timed out — fall through and re-arm the wait (it resolves at once
            // if the attach landed in the gap).
          }
        }
        // Out of patience. Leave `pending` armed so a later re-bind or a fresh
        // show settle can still pick the obligation up.
        if (!attached || isStale()) return;

        // repaintForReveal, NOT revealTerminal: the assistant pane keeps the
        // `isVisible` gate on the WebGL reattach (a transform-hidden pane must
        // not accumulate a fleet-wide WebGL want, #10671), and it reports FALSE
        // for a missing instance — so a still-registering terminal keeps
        // retrying instead of banking revealTerminal's "gone → settled" true.
        const painted = await revealUntilStable(
          id,
          (target) => terminalInstanceService.repaintForReveal(target),
          () => isStale() || isDocumentHidden(),
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
        // The ACTIVE lane only (#12108): a reveal repaints what is on screen,
        // and a background lane has no visible geometry to correct. Switching
        // tabs runs its own fit, so nothing is dropped by ignoring siblings.
        const next = selectActiveSlot(state);
        const previous = selectActiveSlot(prev);
        // sessionId as well as terminalId: a reserved id is finalized in place
        // when provisioning resolves, so the id alone can be edge-less on the
        // retry path after an attach-wait timeout.
        if (next.terminalId === previous.terminalId && next.sessionId === previous.sessionId) {
          return;
        }
        if (!next.terminalId || !pending || !visible) return;
        // A re-bind supersedes whatever the previous binding was chasing.
        generation++;
        discharge(next.terminalId);
      });
      // Deliberately NOT cancelled on app:view-cached. Yielding the obligation to
      // the switch-back sweep looks tempting, but that sweep only covers the
      // assistant once BOTH its terminalId and its registered panel exist
      // (collectActiveWorktreeTerminalTargets) — so a view cached while the
      // session is still provisioning would hand the repaint to an owner that
      // never takes it, and #11070 returns. A discharge that lands in a
      // backgrounded view is merely wasted (repaintForReveal still gates on
      // DOM-truth dims, and with no opts it keeps the isVisible WebGL gate,
      // #10671), and the switch-back sweep repaints the terminal again anyway.
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
      // Every settle opens a FRESH obligation that supersedes the last.
      generation++;
      pending = true;
      inFlight = null;

      const assistantTerminalId = selectActiveSlot(useHelpPanelStore.getState()).terminalId;
      // No terminal yet (the cold first open — the #11070 case). Hold the
      // obligation; the help-store subscription discharges it once one binds.
      if (!assistantTerminalId) return;

      // Bound already: drive the discharge from here, because no null→bound
      // store edge is coming to trigger it. Everything routes through the same
      // attach-gated, confirm-painted path — a bare synchronous repaintForReveal
      // would be a weaker pass than the loop (it has no isAttaching guard, so it
      // can report a paint that the terminal's own post-attach fit then
      // supersedes) and banking it would retire the obligation on one unstuck
      // paint. The warm case costs nothing extra: waitForAttachSettled resolves
      // immediately for an already-attached terminal.
      discharge(assistantTerminalId);
    },
  };
}
