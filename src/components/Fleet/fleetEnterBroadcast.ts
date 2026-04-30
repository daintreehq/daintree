import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { useFleetBroadcastConfirmStore } from "@/store/fleetBroadcastConfirmStore";
import { logWarn } from "@/utils/logger";
import { getFleetBroadcastWarnings, resolveFleetBroadcastTargetIds } from "./fleetBroadcast";
import { executeFleetBroadcast } from "./fleetExecution";

function describeWarnings(text: string): string[] {
  const w = getFleetBroadcastWarnings(text);
  const reasons: string[] = [];
  if (w.destructive) reasons.push("destructive command detected");
  if (w.overByteLimit) reasons.push("payload exceeds 512 bytes");
  if (w.multiline) reasons.push("multi-line payload");
  return reasons;
}

/**
 * Enter from a focused armed pane fans the draft out to every armed peer
 * (the "broadcast by default" model). Returns true when the broadcast was
 * either dispatched or queued for confirmation — the caller must skip its
 * single-pane send path. Returns false when the pane isn't in a 2+ fleet,
 * leaving the caller to do its normal per-pane submit.
 *
 * Followers stay single-pane on Enter — typing in a follower's input bar
 * is the deliberate "send only here" escape hatch and is not advertised
 * in the UI.
 *
 * Per-target recipe-variable resolution is handled by `executeFleetBroadcast`
 * (worktree path, branch name, issue/PR number). Unresolved variables
 * become empty strings rather than blocking the send — the user already
 * saw the per-target diff in the optional pill popover if they cared.
 */
export function tryFleetBroadcastFromEditor(
  terminalId: string,
  text: string,
  onSent: () => void
): boolean {
  const armed = useFleetArmingStore.getState().armedIds;
  if (!armed.has(terminalId) || armed.size < 2) return false;

  const targets = resolveFleetBroadcastTargetIds();
  if (targets.length === 0) return false;

  const reasons = describeWarnings(text);

  const doSend = async () => {
    try {
      const result = await executeFleetBroadcast(text, targets);
      if (result.failureCount > 0) {
        logWarn("[fleetEnterBroadcast] broadcast had rejections", {
          failureCount: result.failureCount,
          failedIds: result.failedIds,
        });
        useFleetFailureStore.getState().recordFailure(text, result.failedIds);
      } else {
        // A successful broadcast clears any stale failure dot on these
        // targets — the partial-failure state from a prior attempt is
        // now resolved.
        for (const id of targets) useFleetFailureStore.getState().dismissId(id);
      }
      // Subtle audio confirmation that the prompt fanned out. Reuses the
      // existing context-injected sound — semantically a fleet broadcast
      // IS injecting the same context into N agents. SoundService handles
      // dampening/throttling and respects the user's UI-feedback toggle.
      window.electron?.notification?.playUiEvent("context-injected").catch(() => {});
    } finally {
      onSent();
    }
  };

  if (reasons.length > 0) {
    useFleetBroadcastConfirmStore.getState().request({
      text,
      warningReasons: reasons,
      onConfirm: doSend,
    });
    return true;
  }

  void doSend();
  return true;
}
