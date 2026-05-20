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
import {
  getFleetBroadcastDestructiveMatch,
  getFleetBroadcastWarnings,
  needsFleetBroadcastConfirmation,
  resolveFleetBroadcastTargetIds,
} from "./fleetBroadcast";
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
      excluded: p.excluded,
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
 *
 * Recipe-variable expansion can also push a safe-looking draft past the
 * 512-byte threshold or surface a destructive substring not in the source
 * draft. `needsFleetBroadcastConfirmation` re-checks the resolved per-
 * target payloads so the confirm gate sees what each pane will actually
 * receive, not just the source text.
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
  // We deliberately do NOT re-read the live store inside `doSend`: when
  // the divergence ConfirmDialog mounts it traps focus, which causes
  // Radix to close the popover, which triggers the popover's
  // useEffect-on-close to call `useFleetTargetOverridesStore.clear()`.
  // A live re-read at resolve time would therefore see an empty store
  // and silently submit the resolved defaults — exactly the D2
  // silent-fallback anti-pattern #7880 / CLAUDE.md forbids. The snapshot
  // also matches what the user reviewed in the dialog body, so the
  // submitted content equals the reviewed content by construction.
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

  // Build the previews snapshot for the confirm dialog body. The live
  // preview store rebuilds reactively on every keystroke; freeze a copy
  // now so the dialog body doesn't change under the user mid-read.
  const livePreviews = useFleetResolutionPreviewStore.getState().previews;
  const previews: FleetTargetPreview[] =
    livePreviews.length > 0 ? livePreviews : buildFleetTargetPreviews(text);

  const reasons = describeWarnings(text);
  const destructiveMatch = getFleetBroadcastDestructiveMatch(text);

  // Resolved-payload gate: recipe-variable expansion can push a safe-
  // looking draft past the 512-byte threshold or surface a destructive
  // substring per-target. Re-check against the resolved fan-out so the
  // confirm reflects what each pane will actually receive.
  const resolvedPayloads = previews.filter((p) => !p.excluded).map((p) => p.resolvedPayload);
  const requiresWarningConfirm = needsFleetBroadcastConfirmation(text, resolvedPayloads);

  // Divergence is scoped to live armed targets: a stale override for a
  // terminal that has since disarmed must not force a spurious confirm
  // dialog. Same for skips against terminals no longer in `targets`.
  const liveSet = new Set(targets);
  const hasOverrides = Object.keys(initialOverrides).some((id) => liveSet.has(id));
  const hasSkips = Array.from(initialSkipped).some((id) => liveSet.has(id));
  const hasUnresolved = previews.some(
    (p) => !p.excluded && liveSet.has(p.terminalId) && p.unresolvedVars.length > 0
  );
  const divergent = hasOverrides || hasSkips || hasUnresolved;

  const doSend = async () => {
    // Filter the snapshot against the live armed set so terminals that
    // disarmed during the confirm pause aren't included. We use the
    // snapshot's `initialSkipped` rather than a live re-read for the
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

    // A second Enter while a broadcast is in-flight should pre-empt the
    // first — leaving a stale controller would race two runs against the
    // shared progress store. Abort then take over.
    activeBroadcastController?.abort();
    const controller = new AbortController();
    activeBroadcastController = controller;
    try {
      const result = await executeFleetBroadcast(
        text,
        effectiveTargets,
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
        for (const id of effectiveTargets) useFleetFailureStore.getState().dismissId(id);
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

  if (requiresWarningConfirm || divergent) {
    void requestFleetBroadcastConfirmation({
      text,
      warningReasons: reasons,
      divergence: divergent
        ? {
            targets: buildDivergenceTargets(previews, initialOverrides, initialSkipped),
          }
        : undefined,
      destructiveMatch,
    }).then(doSend);
    return true;
  }

  void doSend();
  return true;
}
