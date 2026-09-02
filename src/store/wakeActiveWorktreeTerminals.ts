import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { isDocumentHidden, revealUntilStable } from "@/services/terminal/revealUntilStable";
import { useHelpPanelStore, selectSlotTerminalIds } from "@/store/helpPanelStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { logWarn } from "@/utils/logger";
import { getErrorMessage } from "@/utils/errorContext";
import { notifyWarmReactivationComplete } from "@/utils/warmReactivationGate";
import { PERF_MARKS } from "@shared/perf/marks";
import { markSwitch } from "@/utils/switchTrace";

const WAKE_CONCURRENCY = 2;

/**
 * Wake every grid terminal in the active worktree (#7999, #8562).
 *
 * Called on cached `WebContentsView` reactivation (project view activation
 * via Electron 41 `addChildView`). With hibernation removed the renderer
 * stays fully live in the background — the pty-host streams every byte
 * regardless of tier, so the xterm.js buffer is already current on return.
 * The reveal is therefore a repaint + geometry re-fit, not a snapshot pull.
 *
 * Uses `terminalInstanceService.fullWakeForVisibilityRestore(id)` rather
 * than `wake(id)` because the full sequence re-fits geometry that the
 * backgrounded view could not measure — visible panes were otherwise left
 * with stale geometry until the user clicked each pane (#8562). It runs
 * `applyDeferredResize`, `forceXtermReflow`, `handlePostWake`, and
 * `dataBuffer.resumeFlush`. Going through `applyRendererPolicy(VISIBLE)`
 * would no-op on tier equality (the backgrounded view's terminals stay at
 * VISIBLE), so the full-wake method bypasses the policy.
 *
 * The focused panel is moved to slot 0 of the work queue so it gets the
 * first execution slot (interactive responsiveness). The whole queue is
 * drained at concurrency = {@link WAKE_CONCURRENCY} to avoid a CPU spike
 * across large grids, where N concurrent `refresh()` calls on N xterm
 * instances can produce a long-task on the main thread. Putting the focused
 * panel inside the pool — rather than awaiting it standalone first — means
 * a hung wake (IPC stall, oversized incremental restore) on the focused
 * panel doesn't block the other visible panels from refreshing.
 *
 * Dock and trash terminals are excluded — they manage their own visibility.
 */
export async function wakeActiveWorktreeTerminals(): Promise<void> {
  try {
    await wakeActiveWorktreeTerminalsInner();
  } finally {
    // Always release any warm-reactivation paint gate main may be holding for
    // this view (#9679), even on a zero-terminal grid or a thrown fan-out —
    // otherwise the opaque cover lingers until main's hard-timeout fallback.
    notifyWarmReactivationComplete();
  }
}

/**
 * Build the list of grid terminals in the active worktree that a visibility
 * restore or post-reveal repaint should touch — every grid pane plus the
 * persistently-rendered Daintree Assistant. Shared by the wake fan-out and the
 * post-reveal repaint so both target exactly the same set.
 *
 * Dock and trash terminals are excluded — they manage their own visibility.
 */
function collectActiveWorktreeTerminalTargets(): string[] {
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId ?? null;
  const { panelIds, panelsById } = usePanelStore.getState();

  const targets: string[] = [];
  for (const id of panelIds) {
    const panel = panelsById[id];
    if (!panel) continue;
    if ((panel.kind ?? "terminal") !== "terminal") continue;
    if ((panel.worktreeId ?? null) !== activeWorktreeId) continue;
    const location = panel.location ?? "grid";
    if (
      location === "dock" ||
      location === "trash" ||
      location === "overlay" ||
      location === "dialog"
    )
      continue;
    targets.push(id);
  }

  // The Daintree Assistant terminal is a `location: "overlay"` panel and so is
  // excluded by the loop above, but it's rendered persistently in `HelpPanel`
  // (not via the dock popover), so nothing else wakes it on view reactivation.
  // Without this it stays frozen — accumulating headless-mirror output but
  // never syncing its xterm buffer — until a manual resize (#9637). Pull its
  // id straight from the help-panel store and fold it into the same fan-out;
  // the per-terminal methods guard on disposal internally, so a stale id whose
  // panel was cleared on project switch safely misses the lookup.
  for (const assistantId of selectSlotTerminalIds(useHelpPanelStore.getState())) {
    if (panelsById[assistantId] && !targets.includes(assistantId)) {
      targets.push(assistantId);
    }
  }

  return targets;
}

/**
 * Move the focused terminal to slot 0 so it's serviced first — it's the pane the
 * user is reading, so it should wake/repaint before the rest. Mutates in place.
 */
function prioritizeFocusedFirst(targets: string[]): void {
  let focusedIndex = -1;
  for (let i = 0; i < targets.length; i++) {
    const id = targets[i];
    if (id && terminalInstanceService.isFocused(id)) {
      focusedIndex = i;
      break;
    }
  }
  if (focusedIndex > 0) {
    const [focused] = targets.splice(focusedIndex, 1);
    if (focused) {
      targets.unshift(focused);
    }
  }
}

/**
 * Re-assert the service-level focus bit for the store-focused terminal without
 * moving DOM focus. In DOM-mode WebGL fallback, `TerminalInstanceService.setFocused`
 * is the path that restores the single focused WebGL pin; a warm project reveal
 * can otherwise leave the pane on the DOM renderer until the user clicks it.
 */
function reassertFocusedWebGLPin(targets: string[]): void {
  const focusedId = usePanelStore.getState().focusedId;
  if (!focusedId || !targets.includes(focusedId)) return;
  terminalInstanceService.setFocused(focusedId, true);
}

async function wakeActiveWorktreeTerminalsInner(): Promise<void> {
  const targets = collectActiveWorktreeTerminalTargets();

  if (targets.length === 0) return;

  // Slot the focused panel first. It still runs inside the same worker pool, so
  // a hang on the focused panel doesn't block the other visible panels.
  prioritizeFocusedFirst(targets);
  const focusedTarget = targets[0];

  const wakeOne = async (id: string): Promise<void> => {
    try {
      await terminalInstanceService.fullWakeForVisibilityRestore(id);
      if (id === focusedTarget) {
        markSwitch(PERF_MARKS.PROJECT_SWITCH_FOCUSED_PANE_WOKEN, { paneId: id });
      }
    } catch (error) {
      // One broken terminal must not abort the fan-out — the next visible
      // terminal still needs its missed range pulled from the headless mirror.
      // getErrorMessage, not the Error itself: `message` is non-enumerable, so
      // a nested Error serialises to `{}` in the log context and the one line
      // that could explain a wedged terminal says nothing at all (#11776).
      logWarn("[wakeActiveWorktreeTerminals] wake failed", {
        id,
        error: getErrorMessage(error),
      });
    }
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const next = cursor++;
      const id = targets[next];
      if (id) {
        await wakeOne(id);
      }
    }
  };
  const workerCount = Math.min(WAKE_CONCURRENCY, targets.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  markSwitch(PERF_MARKS.PROJECT_SWITCH_ALL_PANES_WOKEN, { paneCount: targets.length });
}

/**
 * Put keyboard focus back on the working terminal when a warm view is revealed
 * and nothing that takes typed input holds focus.
 *
 * Switching away through the toolbar switcher leaves the outgoing document's
 * focus on the switcher pill (Radix returns focus to the trigger on close), and
 * a document can be left on `body` by an unmounted overlay. Neither survives a
 * round trip usefully: the user comes back, types, and the keystrokes land on
 * a button. Focus is only moved off a button or the body — never off an input,
 * a textarea, a combobox, editable content or anything inside an open dialog —
 * and only onto the panel store's focused terminal when that pane is in the
 * active worktree's grid. Returns whether focus was moved.
 */
export function restoreTerminalFocusOnReveal(): boolean {
  const outcome = restoreTerminalFocusOnRevealInner();
  const active = typeof document === "undefined" ? null : document.activeElement;
  markSwitch(PERF_MARKS.PROJECT_SWITCH_FOCUS_RESTORE, {
    outcome,
    activeTag: active?.tagName ?? null,
    activeRole: active?.getAttribute("role") ?? null,
    activeLabel: active?.getAttribute("aria-label") ?? null,
    activeTestId: active?.getAttribute("data-testid") ?? null,
    activeClass: active instanceof HTMLElement ? active.className.toString().slice(0, 60) : null,
  });
  return outcome === "moved";
}

type FocusRestoreOutcome =
  | "moved"
  | "no-document"
  | "already-in-pane"
  | "input-has-focus"
  | "overlay-open"
  | "non-button-focused"
  | "no-terminal";

function restoreTerminalFocusOnRevealInner(): FocusRestoreOutcome {
  if (typeof document === "undefined") return "no-document";
  const targets = collectActiveWorktreeTerminalTargets();
  const { focusedId, previousFocusedId, panelsById } = usePanelStore.getState();
  const isGridTerminal = (id: string | null): id is string =>
    Boolean(id) && (panelsById[id!]?.kind ?? "terminal") === "terminal" && targets.includes(id!);
  // The store's focused pane, else the pane focus last left (a click on the
  // toolbar clears the store's focus), else the first pane in the grid.
  const targetId = isGridTerminal(focusedId)
    ? focusedId
    : isGridTerminal(previousFocusedId)
      ? previousFocusedId
      : (targets.find((id) => isGridTerminal(id)) ?? null);
  if (!targetId) return "no-terminal";

  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    if (active.closest("[data-panel-id]")) return "already-in-pane";
    // The switcher that committed the switch is still mid-close when the view
    // was parked (its exit never got a frame), so its search box can hold
    // focus here; that close is suppressed from bouncing to the pill, and the
    // terminal is where the user expects to type.
    const insideClosingSwitcher = Boolean(
      active.closest('[data-testid="project-switcher-palette"], [aria-label="Project switcher"]')
    );
    const tag = active.tagName;
    const takesInput =
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      active.isContentEditable ||
      active.getAttribute("role") === "combobox" ||
      active.getAttribute("role") === "textbox";
    if (!insideClosingSwitcher) {
      if (takesInput) return "input-has-focus";
      if (active.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) {
        return "overlay-open";
      }
      if (tag !== "BUTTON" && tag !== "BODY") return "non-button-focused";
    }
  }
  terminalInstanceService.focus(targetId);
  return "moved";
}

// At most this many terminals repaint on any one frame so a large grid never
// produces a single long task on the reveal frame.
const REVEAL_CONCURRENCY = 2;

/**
 * Re-run the terminal reveal across every grid agent terminal AFTER the project
 * view has been revealed and focused as the foreground surface (#10362).
 *
 * The wake fan-out in {@link wakeActiveWorktreeTerminals} fires on
 * visibilitychange/resume — while the cached view is still occluded behind the
 * warm anti-flash bridge (#9679), where Chromium culls the paint AND the host
 * can report a zero layout box. For terminals that stayed live across the dwell
 * the byte sync still lands (IPC data isn't culled like a paint), so they only
 * need a repaint. But a terminal hibernated during a long dwell was torn down
 * and could not re-open behind the bridge — it needs a full foreground
 * rehydration, not just a repaint. {@link TerminalInstanceService.revealTerminal}
 * picks the right path per terminal: full open+wake for hibernated/unopened
 * panes, cheap repaint for the rest.
 *
 * A single double-rAF reveal proved unreliable: main fires `app:view-revealed`
 * the moment it detaches the anti-flash bridge, without waiting for the
 * compositor to actually present the foreground frame, so a one-shot repaint can
 * land before the view is paintable (or get undone by xterm's own observers
 * re-firing as the view un-occludes) and there was no retry — leaving panes
 * garbled until clicked. Each terminal now runs through {@link revealUntilStable}
 * (retry-until-paintable + a confirm paint), bounded-concurrency so a large grid
 * stays off the long-task path. This sweep is the SOLE reveal-repaint owner for
 * the Daintree Assistant terminal too — {@link collectActiveWorktreeTerminalTargets}
 * folds its overlay terminal into the target list (#9637). HelpPanel must NOT
 * re-add a parallel per-frame reveal cascade: a second reconcile racing this one
 * against live PTY output corrupts xterm's line-wrap metadata (#10863).
 */
export async function repaintActiveWorktreeTerminals(): Promise<void> {
  const targets = collectActiveWorktreeTerminalTargets();
  if (targets.length === 0) return;

  // A click fixes DOM-mode WebGL fallback because focus pins a single context.
  // Re-establish that pin on reveal without stealing DOM focus from the user.
  reassertFocusedWebGLPin(targets);

  // Reveal the pane the user is reading first — the rest stagger in behind it.
  prioritizeFocusedFirst(targets);

  // Abort the whole sweep if the view is switched away (detached → hidden) at any
  // point: continuing would repaint a now-hidden view, and the switch-back starts
  // a fresh sweep. Latched on the first hidden event, so a rapid hidden→visible
  // flip still abandons this (now superseded) sweep rather than letting a
  // post-await visibility sample miss the transition.
  let aborted = isDocumentHidden();
  const onVisibilityChange = (): void => {
    if (isDocumentHidden()) aborted = true;
  };
  const canListen =
    typeof document !== "undefined" && typeof document.addEventListener === "function";
  if (canListen) document.addEventListener("visibilitychange", onVisibilityChange);

  try {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < targets.length) {
        if (aborted) return;
        const id = targets[cursor++];
        // revealTerminal (not repaintForReveal): this sweep also has to OPEN
        // panes the occluded warm wake could not, and it trusts DOM-truth
        // visibility for the WebGL reattach because the foreground view is
        // confirmed presented. The assistant sidebar-transition owner
        // deliberately uses the other pass — see revealUntilStable's RevealAttempt.
        if (id) {
          await revealUntilStable(
            id,
            (target) => terminalInstanceService.revealTerminal(target),
            () => aborted,
            "[repaintActiveWorktreeTerminals]"
          );
        }
      }
    };
    const workerCount = Math.min(REVEAL_CONCURRENCY, targets.length);
    const workers: Promise<void>[] = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
  } finally {
    if (canListen) document.removeEventListener("visibilitychange", onVisibilityChange);
  }
}
