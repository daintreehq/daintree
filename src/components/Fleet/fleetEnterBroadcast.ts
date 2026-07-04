import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useFleetRunStore } from "@/store/fleetRunStore";
import { useFleetTargetOverridesStore } from "@/store/fleetTargetOverridesStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { logWarn } from "@/utils/logger";
import { resolveFleetBroadcastTargetIds } from "./fleetBroadcast";
import {
  executeFleetBroadcast,
  filterEligibleIds,
  type FleetExecutionResult,
} from "./fleetExecution";

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

/**
 * Run a fleet broadcast through the shared single-flight controller so it
 * participates in the same coordination as the Enter path: a newer broadcast
 * pre-empts an older one (they share `fleetBroadcastProgressStore`, which only
 * tracks one run), and `cancelActiveBroadcast` (the ribbon Cancel button) can
 * abort it. Callers own their own result handling; this manages the controller
 * lifecycle, the cooperative `signal`, and the supervised-run record in
 * `fleetRunStore` (which owns the post-submit `watching` phase and the durable
 * run-history append at finalize — see #10930).
 */
export async function runManagedFleetBroadcast(
  draft: string,
  targetIds: string[],
  perTargetOverrides?: Record<string, string>,
  opts?: { isRetry?: boolean; draftPreview?: string }
): Promise<FleetExecutionResult> {
  // A newer broadcast pre-empts the in-flight one — leaving a stale controller
  // would race two runs against the shared progress store. Abort then take over.
  activeBroadcastController?.abort();
  const controller = new AbortController();
  activeBroadcastController = controller;
  // Zero-target dispatches (every pane went ineligible between snapshot and
  // send) are structural no-ops — don't mint a run record for them.
  // `draftPreview` lets the retry path (empty draft, payload in overrides)
  // still label its run with the literal being replayed.
  const runId =
    targetIds.length > 0
      ? useFleetRunStore.getState().beginRun(targetIds, {
          draft: opts?.draftPreview ?? draft,
          isRetry: opts?.isRetry,
        })
      : null;
  try {
    const result = await executeFleetBroadcast(
      draft,
      targetIds,
      perTargetOverrides,
      controller.signal
    );
    if (runId !== null) {
      useFleetRunStore.getState().applySubmissionResult(runId, result);
    }
    return result;
  } catch (error) {
    // executeFleetBroadcast absorbs per-target rejections via allSettled, so a
    // throw is an unexpected crash — finalize the run rather than leaving it
    // pinned at `submitting` with no terminal record.
    if (runId !== null) {
      useFleetRunStore.getState().applySubmissionResult(runId, {
        total: 0,
        successCount: 0,
        failureCount: 0,
        perTarget: [],
        failedIds: [],
        permanentlyFailedIds: [],
        transientlyFailedIds: [],
        cancelled: false,
        skippedCount: targetIds.length,
      });
    }
    throw error;
  } finally {
    if (activeBroadcastController === controller) {
      activeBroadcastController = null;
    }
  }
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

/**
 * Enter from a focused armed pane fans the draft out to every armed peer
 * (the "broadcast by default" model). Returns true when the broadcast was
 * either dispatched or absorbed because every armed target was
 * user-skipped — the caller must skip its single-pane send path. Returns
 * false when the pane isn't in a 2+ fleet, leaving the caller to do its
 * normal per-pane submit.
 *
 * Followers stay single-pane on Enter — typing in a follower's input bar
 * is the deliberate "send only here" escape hatch and is not advertised
 * in the UI.
 *
 * Submit just submits: once a fleet is armed there is no confirmation
 * step. This matches the raw-terminal broadcast path
 * (`broadcastFleetRawInput`), which has always fanned out without a
 * confirm — arming is the opt-in consent boundary, and broadcast awareness
 * lives in the top-bar fleet indicator (ribbon flash via
 * `noteBroadcastCommit`), not a blocking dialog. Destructive payloads,
 * large pastes, multi-line text, and per-target overrides/skips all fan
 * out immediately; the per-target overrides set in the drafting popover
 * are still honored via the snapshot taken below.
 *
 * Per-target recipe-variable resolution and override application happen in
 * `executeFleetBroadcast`.
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

  // Snapshot the override + skip state at the moment Enter is pressed so
  // the broadcast submits the user's intent as it stood at press time —
  // a popover-close effect that clears the overrides store mid-send can't
  // mutate what we already captured here. We deliberately do NOT re-read
  // the live store inside `doSend`.
  const overridesState = useFleetTargetOverridesStore.getState();
  const initialOverrides = { ...overridesState.payloadOverrides };
  const initialSkipped = new Set(overridesState.skippedIds);

  // All eligible targets skipped → consume the Enter (so the single-pane
  // send doesn't also fire) without dispatching anything. Clear the
  // overrides store and signal the caller so the input bar doesn't stay
  // in a half-submitted state.
  if (targets.every((id) => initialSkipped.has(id))) {
    useAnnouncerStore.getState().announce("Broadcast skipped — all targets excluded", "polite");
    useFleetTargetOverridesStore.getState().clear();
    onSent();
    return true;
  }

  const doSend = async () => {
    // Filter the snapshot against the live armed set so terminals that
    // disarmed between Enter-press and dispatch aren't included. We use
    // the snapshot's `initialSkipped` rather than a live re-read for the
    // reason in the comment above the snapshot.
    const liveArmedSet = new Set(resolveFleetBroadcastTargetIds());
    const effectiveTargets = targets.filter(
      (id) => !initialSkipped.has(id) && liveArmedSet.has(id)
    );

    if (effectiveTargets.length === 0) {
      try {
        useAnnouncerStore
          .getState()
          .announce("Broadcast skipped — no eligible targets remain", "polite");
      } finally {
        useFleetTargetOverridesStore.getState().clear();
        onSent();
      }
      return;
    }

    const effectiveOverrides: Record<string, string> = {};
    for (const id of effectiveTargets) {
      if (id in initialOverrides) {
        effectiveOverrides[id] = initialOverrides[id]!;
      }
    }
    const overridesArg =
      Object.keys(effectiveOverrides).length > 0 ? effectiveOverrides : undefined;

    // Re-check eligibility at dispatch time. Panes that disarmed,
    // trashed, or lost their PTY between Enter-press and dispatch must
    // not still receive bytes just because the snapshot marked them
    // eligible. `effectiveTargets` already filtered against
    // `resolveFleetBroadcastTargetIds()`; re-run the panel-eligibility
    // filter so disposed PTYs are dropped too.
    const eligibleTargets = filterEligibleIds(effectiveTargets);
    try {
      // A second Enter while a broadcast is in-flight pre-empts the first;
      // the shared controller lets the ribbon Cancel button abort it too.
      // Run-history recording now happens when the supervised run finalizes
      // (fleetRunStore), so the record carries watch-phase outcomes too.
      const result = await runManagedFleetBroadcast(text, eligibleTargets, overridesArg);
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
          // The disarm count rides along so the banner can describe THIS
          // broadcast's permanent casualties without consulting the run store
          // (whose run may be superseded by the time the banner renders).
          useFleetFailureStore
            .getState()
            .recordFailure(text, result.transientlyFailedIds, result.permanentlyFailedIds.length);
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
        for (const id of eligibleTargets) useFleetFailureStore.getState().dismissId(id);
        // Fire the ribbon's one-shot commit flash, matching the raw-input
        // path (`broadcastFleetRawInput`). The structured path's analog of
        // "committed bytes" is a non-cancelled, fully-successful fan-out.
        useFleetArmingStore.getState().noteBroadcastCommit();
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
      // Per-target overrides are ephemeral per-broadcast (#8691 constraint).
      // Clear them so the next broadcast starts from the resolved defaults.
      // Controller teardown is owned by `runManagedFleetBroadcast`.
      useFleetTargetOverridesStore.getState().clear();
      onSent();
    }
  };

  void doSend();
  return true;
}
