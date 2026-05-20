import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { requestFleetBroadcastConfirmation } from "@/store/fleetBroadcastConfirmStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { logWarn } from "@/utils/logger";
import { getFleetBroadcastWarnings, resolveFleetBroadcastTargetIds } from "./fleetBroadcast";
import { executeFleetBroadcast, type FleetExecutionResult } from "./fleetExecution";

let activeBroadcastController: AbortController | null = null;

/**
 * Abort any in-flight fleet broadcast. Already-dispatched IPC writes can't
 * be revoked; this prevents future batches from firing and signals the
 * progress store + announcer to surface the cancelled outcome.
 */
export function cancelActiveBroadcast(): void {
  activeBroadcastController?.abort();
  useFleetBroadcastProgressStore.getState().cancel();
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function describeFailureSplit(permanent: number, transient: number): string {
  // Both kinds present → call out the user-visible distinction (retryable vs
  // unreachable) so the user can tell the chip-recoverable cases apart from
  // the panes we just auto-disarmed. When only one kind is present, the
  // single "N failed" count suffices.
  if (permanent > 0 && transient > 0) {
    return `${transient} retryable, ${permanent} unreachable`;
  }
  if (permanent > 0) return `${permanent} unreachable`;
  return `${transient} failed`;
}

function buildBroadcastAnnouncement(result: FleetExecutionResult): string {
  const permanent = result.permanentlyFailedIds.length;
  const transient = result.transientlyFailedIds.length;
  const skipped =
    result.skippedCount > 0
      ? `, ${plural(result.skippedCount, "terminal", "terminals")} skipped`
      : "";

  if (result.cancelled) {
    if (result.successCount === 0 && result.failureCount === 0) {
      if (result.skippedCount > 0) {
        return `Broadcast cancelled — ${plural(result.skippedCount, "terminal", "terminals")} skipped`;
      }
      return "Broadcast cancelled";
    }
    if (result.failureCount > 0) {
      return `Broadcast cancelled — ${result.successCount} sent, ${describeFailureSplit(permanent, transient)}${skipped}`;
    }
    return `Broadcast cancelled — ${result.successCount} sent${skipped}`;
  }
  if (result.failureCount > 0) {
    return `Broadcast sent to ${result.successCount} — ${describeFailureSplit(permanent, transient)}`;
  }
  return `Broadcast sent to ${plural(result.successCount, "terminal", "terminals")}`;
}

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
    // A second Enter while a broadcast is in-flight should pre-empt the
    // first — leaving a stale controller would race two runs against the
    // shared progress store. Abort then take over.
    activeBroadcastController?.abort();
    const controller = new AbortController();
    activeBroadcastController = controller;
    try {
      const result = await executeFleetBroadcast(text, targets, undefined, controller.signal);
      if (result.failureCount > 0) {
        logWarn("[fleetEnterBroadcast] broadcast had rejections", {
          failureCount: result.failureCount,
          failedIds: result.failedIds,
          permanentlyFailedIds: result.permanentlyFailedIds,
          transientlyFailedIds: result.transientlyFailedIds,
        });
        if (result.permanentlyFailedIds.length > 0) {
          // Mirror the raw-input path (`applyFleetBroadcastResult`): a dead
          // PTY can't take the broadcast, so disarm it rather than leave the
          // user typing into a gone pane. The failure chip is intentionally
          // NOT recorded for these — `fleetFailureStore`'s `armedIds`
          // subscription would auto-dismiss it the moment we disarm, so the
          // chip would never appear and we'd just thrash the store.
          const arming = useFleetArmingStore.getState();
          for (const id of result.permanentlyFailedIds) {
            arming.disarmId(id);
            // `executeFleetBroadcast` already calls `clearDirectingState` on
            // every rejected target, so we don't repeat it here.
            useFleetFailureStore.getState().dismissId(id);
          }
        }
        if (result.transientlyFailedIds.length > 0) {
          useFleetFailureStore.getState().recordFailure(text, result.transientlyFailedIds);
        }
        // Successful targets in a partial-failure run still clear their
        // stale failure dots — same logic as the all-success branch below.
        for (const t of result.perTarget) {
          if (t.status === "fulfilled") {
            useFleetFailureStore.getState().dismissId(t.terminalId);
          }
        }
      } else if (!result.cancelled) {
        // A successful broadcast clears any stale failure dot on these
        // targets — the partial-failure state from a prior attempt is
        // now resolved.
        for (const id of targets) useFleetFailureStore.getState().dismissId(id);
      } else if (result.successCount > 0) {
        // Partial cancel — dispatched batches that succeeded should clear
        // their old failure dots; targets in skipped batches stay as-is.
        for (const t of result.perTarget) {
          if (t.status === "fulfilled") {
            useFleetFailureStore.getState().dismissId(t.terminalId);
          }
        }
      }
      useAnnouncerStore.getState().announce(buildBroadcastAnnouncement(result), "polite");
      // Subtle audio confirmation that the prompt fanned out. Reuses the
      // existing context-injected sound — semantically a fleet broadcast
      // IS injecting the same context into N agents. SoundService handles
      // dampening/throttling and respects the user's UI-feedback toggle.
      // Skip the chirp on cancel: the announcement is the feedback channel.
      if (!result.cancelled) {
        window.electron?.notification?.playUiEvent("context-injected").catch(() => {});
      }
    } finally {
      if (activeBroadcastController === controller) {
        activeBroadcastController = null;
      }
      onSent();
    }
  };

  if (reasons.length > 0) {
    void requestFleetBroadcastConfirmation({
      text,
      warningReasons: reasons,
    }).then(doSend);
    return true;
  }

  void doSend();
  return true;
}
