import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import {
  requestFleetBroadcastConfirmation,
  type PendingFleetBroadcastTarget,
} from "@/store/fleetBroadcastConfirmStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useFleetResolutionPreviewStore } from "@/store/fleetResolutionPreviewStore";
import { useFleetTargetOverridesStore } from "@/store/fleetTargetOverridesStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { logWarn } from "@/utils/logger";
import { getFleetBroadcastWarnings, resolveFleetBroadcastTargetIds } from "./fleetBroadcast";
import {
  buildFleetTargetPreviews,
  executeFleetBroadcast,
  type FleetExecutionResult,
  type FleetTargetPreview,
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

function buildDivergenceTargets(
  previews: FleetTargetPreview[],
  payloadOverrides: Record<string, string>,
  skippedIds: Set<string>
): PendingFleetBroadcastTarget[] {
  return previews.map((p) => {
    const override = payloadOverrides[p.terminalId];
    const overridden = override !== undefined;
    return {
      terminalId: p.terminalId,
      title: p.title,
      payload: overridden ? override : p.resolvedPayload,
      overridden,
      skipped: skippedIds.has(p.terminalId),
      unresolvedVars: p.unresolvedVars,
    };
  });
}

/**
 * Enter from a focused armed pane fans the draft out to every armed peer
 * (the "broadcast by default" model). Returns true when the broadcast was
 * either dispatched, queued for confirmation, or absorbed because every
 * armed target was user-skipped — the caller must skip its single-pane
 * send path. Returns false when the pane isn't in a 2+ fleet, leaving the
 * caller to do its normal per-pane submit.
 *
 * Followers stay single-pane on Enter — typing in a follower's input bar
 * is the deliberate "send only here" escape hatch and is not advertised
 * in the UI.
 *
 * Per-target recipe-variable resolution happens in `executeFleetBroadcast`.
 * The drafting popover lets the user override any single target's payload
 * or skip a target outright. Both forms of divergence (plus unresolved
 * variables) route through a confirm dialog before dispatch so the user
 * sees the actual per-target content — the silent-fallback comment that
 * used to live here is gone because we no longer silently fall back.
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

  // Snapshot the override + skip state at the moment Enter is pressed.
  // `doSend` will re-read inside the callback so any edits made while a
  // confirm is open take effect, but the divergence check + dialog body
  // need a stable view to render against.
  const overridesState = useFleetTargetOverridesStore.getState();
  const initialOverrides = { ...overridesState.payloadOverrides };
  const initialSkipped = new Set(overridesState.skippedIds);

  // All eligible targets skipped → consume the Enter (so the single-pane
  // send doesn't also fire) without dispatching anything. The popover
  // already shows every row as skipped so the cause is self-evident; just
  // announce for screen readers and bail.
  if (targets.every((id) => initialSkipped.has(id))) {
    useAnnouncerStore.getState().announce("Broadcast skipped — all targets excluded", "polite");
    onSent();
    return true;
  }

  // Build the previews snapshot for the confirm dialog body. The live
  // preview store rebuilds reactively on every keystroke; freeze a copy
  // now so the dialog body doesn't change under the user mid-read.
  const livePreviews = useFleetResolutionPreviewStore.getState().previews;
  const previews: FleetTargetPreview[] =
    livePreviews.length > 0 ? livePreviews : buildFleetTargetPreviews(text);

  const reasons = describeWarnings(text);

  const hasOverrides = Object.keys(initialOverrides).length > 0;
  const hasSkips = initialSkipped.size > 0;
  const hasUnresolved = previews.some((p) => !p.excluded && p.unresolvedVars.length > 0);
  const divergent = hasOverrides || hasSkips || hasUnresolved;

  const doSend = async () => {
    // Stale-closure trap (lesson #5087): re-read the overrides store inside
    // the async callback so edits made while a confirm dialog is open
    // actually take effect. Reading from the outer scope would silently
    // drop late edits.
    const liveOverrides = useFleetTargetOverridesStore.getState();
    const livePayloadOverrides = { ...liveOverrides.payloadOverrides };
    const liveSkipped = liveOverrides.skippedIds;

    // Re-resolve targets at execution time so terminals that disarmed
    // during the confirm pause aren't included.
    const liveTargets = resolveFleetBroadcastTargetIds().filter((id) => !liveSkipped.has(id));
    if (liveTargets.length === 0) {
      useAnnouncerStore
        .getState()
        .announce("Broadcast skipped — no eligible targets remain", "polite");
      return;
    }

    // Strip overrides for terminals that are no longer in the live target
    // set (skipped during confirm, or disarmed) so we don't pass dead-key
    // overrides into executeFleetBroadcast.
    const effectiveOverrides: Record<string, string> = {};
    for (const id of liveTargets) {
      if (id in livePayloadOverrides) {
        effectiveOverrides[id] = livePayloadOverrides[id]!;
      }
    }
    const overridesArg =
      Object.keys(effectiveOverrides).length > 0 ? effectiveOverrides : undefined;

    // A second Enter while a broadcast is in-flight should pre-empt the
    // first — leaving a stale controller would race two runs against the
    // shared progress store. Abort then take over.
    activeBroadcastController?.abort();
    const controller = new AbortController();
    activeBroadcastController = controller;
    try {
      const result = await executeFleetBroadcast(
        text,
        liveTargets,
        overridesArg,
        controller.signal
      );
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
        for (const id of liveTargets) useFleetFailureStore.getState().dismissId(id);
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
      // Per-target overrides are ephemeral per-broadcast (#8691 constraint).
      // Clear them so the next broadcast starts from the resolved defaults.
      useFleetTargetOverridesStore.getState().clear();
      onSent();
    }
  };

  if (reasons.length > 0 || divergent) {
    void requestFleetBroadcastConfirmation({
      text,
      warningReasons: reasons,
      divergence: divergent
        ? {
            targets: buildDivergenceTargets(previews, initialOverrides, initialSkipped),
          }
        : undefined,
    }).then(doSend);
    return true;
  }

  void doSend();
  return true;
}
