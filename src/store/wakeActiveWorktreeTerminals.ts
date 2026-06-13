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
 * via Electron 41 `addChildView`). The pty-host headless mirror keeps
 * receiving every byte regardless of tier, so the authoritative buffer is
 * always current — but the renderer's xterm.js buffer accumulates only what
 * arrives over the active stream. After the view returns, the missed range
 * needs to be pulled from the headless mirror via the `wake-terminal` IPC
 * and applied via `restoreFromSerialized`.
 *
 * Uses `terminalInstanceService.fullWakeForVisibilityRestore(id)` rather
 * than `wake(id)` because `wake()` only triggers buffer restore +
 * xterm.refresh — visible panes were left with stale geometry and missing
 * recent output until the user clicked each pane (#8562). The full sequence
 * also runs `applyDeferredResize`, `forceXtermReflow`, `handlePostWake`, and
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

const REPAINT_CHUNK = 2;

function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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
 * `revealTerminal` can fit + full-refresh (and, for the rehydration case, pull
 * from the headless mirror), so the sweep is spread across frames in small
 * chunks to keep a large grid from producing one long task on the reveal frame.
 */
export async function repaintActiveWorktreeTerminals(): Promise<void> {
  const targets = collectActiveWorktreeTerminalTargets();
  if (targets.length === 0) return;

  // Reveal the pane the user is reading first — the rest stagger in behind it.
  prioritizeFocusedFirst(targets);

  for (let i = 0; i < targets.length; i += REPAINT_CHUNK) {
    const chunk: Promise<void>[] = [];
    for (let j = i; j < Math.min(i + REPAINT_CHUNK, targets.length); j++) {
      const id = targets[j];
      if (!id) continue;
      chunk.push(
        terminalInstanceService.revealTerminal(id).catch((error: unknown) => {
          // One broken terminal must not abort the sweep — the next visible
          // terminal still needs its post-reveal reveal/repaint.
          logWarn("[repaintActiveWorktreeTerminals] reveal failed", { id, error });
        })
      );
    }
    await Promise.all(chunk);
    if (i + REPAINT_CHUNK < targets.length) {
      await nextFrame();
    }
  }
}
