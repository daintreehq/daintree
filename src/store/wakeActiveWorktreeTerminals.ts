import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useHelpPanelStore } from "@/store/helpPanelStore";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { logWarn } from "@/utils/logger";
import { notifyWarmReactivationComplete } from "@/utils/warmReactivationGate";

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
    if (location === "dock" || location === "trash" || location === "overlay") continue;
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
  const assistantId = useHelpPanelStore.getState().terminalId;
  if (assistantId && panelsById[assistantId] && !targets.includes(assistantId)) {
    targets.push(assistantId);
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

  const wakeOne = async (id: string): Promise<void> => {
    try {
      await terminalInstanceService.fullWakeForVisibilityRestore(id);
    } catch (error) {
      // One broken terminal must not abort the fan-out — the next visible
      // terminal still needs its missed range pulled from the headless mirror.
      logWarn("[wakeActiveWorktreeTerminals] wake failed", { id, error });
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
}

// Upper bound on frames a single terminal will keep retrying its reveal before
// the sweep gives up on it. A warm project-view return that's settling its
// layout needs only a couple of frames; the ceiling just stops a pane that's
// genuinely offscreen/unmeasurable from spinning forever (~10 frames ≈ 160ms).
const MAX_REVEAL_FRAMES = 10;
// At most this many terminals repaint on any one frame so a large grid never
// produces a single long task on the reveal frame.
const REVEAL_CONCURRENCY = 2;
// Paint each pane on two SEPARATE frames once it's paintable. The first paint
// can land in the frame before the compositor swaps the now-foreground project
// view in — or before xterm's own IntersectionObserver re-fires as the view
// un-occludes and momentarily re-pauses the renderer — so it doesn't visually
// stick. The second, a frame later once those observers have settled, is the
// one the user actually sees. This double pass is what turns the previously
// intermittent reveal into a reliable one.
const REVEAL_CONFIRM_PAINTS = 2;

// rAF is paused for a backgrounded/occluded WebContentsView, so its callback can
// never fire there. Race it against a timeout so a worker awaiting a frame can't
// hang the reveal sweep forever (and later resume stale to interleave with the
// next reveal). In the normal foreground case the real frame (~16ms) always wins
// well before the fallback.
const NEXT_FRAME_FALLBACK_MS = 250;

function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(done);
    if (typeof setTimeout === "function") setTimeout(done, NEXT_FRAME_FALLBACK_MS);
  });
}

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Drive a single terminal's reveal to a stable result: retry frame-by-frame
 * until it reports paintable, then paint it {@link REVEAL_CONFIRM_PAINTS} times
 * across separate frames to defeat the compositor/observer present-race that
 * otherwise leaves the first paint un-stuck. Bounded by {@link MAX_REVEAL_FRAMES}.
 */
async function revealUntilStable(id: string, isAborted: () => boolean): Promise<void> {
  let painted = 0;
  for (let frame = 0; frame < MAX_REVEAL_FRAMES && painted < REVEAL_CONFIRM_PAINTS; frame++) {
    // The view may have been switched away (detached → hidden) since the sweep
    // started or during a frame yield. Stop before touching a hidden view — the
    // switch-back starts a fresh sweep. The caller latches the same flag for the
    // worker pool, so a single hidden event abandons the WHOLE sweep, not just
    // this terminal.
    if (isAborted()) return;
    let paintable: boolean;
    try {
      paintable = await terminalInstanceService.revealTerminal(id);
    } catch (error) {
      // One broken terminal must not abort the sweep — the next visible
      // terminal still needs its post-reveal reveal/repaint.
      logWarn("[repaintActiveWorktreeTerminals] reveal failed", { id, error });
      return;
    }
    if (paintable) painted++;
    // Yield a frame between attempts: lets layout/compositor settle before a
    // retry, and spaces the confirm paint out from the first.
    await nextFrame();
  }
}

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
        if (id) await revealUntilStable(id, () => aborted);
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
