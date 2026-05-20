import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { logWarn } from "@/utils/logger";

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
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId ?? null;
  const { panelIds, panelsById } = usePanelStore.getState();

  const targets: string[] = [];
  for (const id of panelIds) {
    const panel = panelsById[id];
    if (!panel) continue;
    if ((panel.kind ?? "terminal") !== "terminal") continue;
    if ((panel.worktreeId ?? null) !== activeWorktreeId) continue;
    const location = panel.location ?? "grid";
    if (location === "dock" || location === "trash") continue;
    targets.push(id);
  }

  if (targets.length === 0) return;

  // Move the focused panel to slot 0 so it gets the first execution slot.
  // It still runs inside the same worker pool, so a hang on the focused
  // panel doesn't block the other visible panels.
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
