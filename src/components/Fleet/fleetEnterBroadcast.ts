import { selectFleetMemberCount, useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useFleetRunStore } from "@/store/fleetRunStore";
import { useFleetTargetOverridesStore } from "@/store/fleetTargetOverridesStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { logWarn } from "@/utils/logger";
import { resolveFleetBroadcastTargetIds } from "./fleetBroadcast";
import { getCrossHostTarget, isHostQualifiedTargetId } from "./crossHostFleet";
import { notify } from "@/lib/notify";
import { requestHostsOverview } from "@/components/Hosts/Overview/hostsOverviewRequests";
import {
  executeFleetBroadcast,
  filterEligibleIds,
  findCrossHostContextTargets,
  findCrossHostImageTargets,
  type FleetExecutionResult,
} from "./fleetExecution";
import type { FleetFailureReplay } from "@/store/fleetFailureStore";
import { pluralize } from "@/lib/pluralize";

/** Why a fleet send carrying context to another host's agent didn't go. */
export const CROSS_HOST_CONTEXT_REFUSAL =
  "Not sent: context such as @diff can't reach an agent on another host. The draft is still here.";
/** Why a fleet send carrying an image chip to another host's agent didn't go. */
export const CROSS_HOST_IMAGE_REFUSAL =
  "Not sent: an image can't reach an agent on another host. The draft is still here.";

/** What a fleet send refused for another host's agent would have handed it. */
export type CrossHostRefusal = "context" | "image";

const CROSS_HOST_REFUSAL: Record<CrossHostRefusal, string> = {
  context: CROSS_HOST_CONTEXT_REFUSAL,
  image: CROSS_HOST_IMAGE_REFUSAL,
};

let activeBroadcastController: AbortController | null = null;
// The composer send that owns the draft's cleanup. A newer Enter takes it
// over: the older run settling later must not clear a draft that has since
// been sent, cleared and typed again, or undo the newer send's own cleanup.
let latestEditorSend: object | null = null;

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
 * Exit Fleet, the fleet Trash action, and anything else that empties the fleet
 * withdraws the send still going out to it, as Cancel does: the ribbon and its
 * Cancel button leave with the fleet, so nothing else could stop it. Only the
 * submission is withdrawn; a run already watching its agents carries on.
 */
function cancelWhenFleetEmpties(controller: AbortController): () => void {
  // A newer send aborts this controller before taking over, which stops this
  // watch, so a cancel from here always lands on the send it was made for.
  const cancelIfEmpty = (state: ReturnType<typeof useFleetArmingStore.getState>) => {
    if (selectFleetMemberCount(state) === 0) cancelActiveBroadcast();
  };
  const unsubscribe = useFleetArmingStore.subscribe(cancelIfEmpty);
  const stop = () => {
    unsubscribe();
    controller.signal.removeEventListener("abort", stop);
  };
  controller.signal.addEventListener("abort", stop);
  cancelIfEmpty(useFleetArmingStore.getState());
  return stop;
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
  opts?: { isRetry?: boolean; draftPreview?: string; imagePaths?: readonly string[] }
): Promise<FleetExecutionResult> {
  // A newer broadcast pre-empts the in-flight one — leaving a stale controller
  // would race two runs against the shared progress store. Abort then take over.
  activeBroadcastController?.abort();
  const controller = new AbortController();
  activeBroadcastController = controller;
  const stopWatchingFleet = cancelWhenFleetEmpties(controller);
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
      controller.signal,
      { retry: opts?.isRetry === true, imagePaths: opts?.imagePaths }
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
    stopWatchingFleet();
    if (activeBroadcastController === controller) {
      activeBroadcastController = null;
    }
  }
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

function isFleetMember(id: string): boolean {
  return useFleetArmingStore.getState().armedIds.has(id) || getCrossHostTarget(id) !== null;
}

/** The hosts a broadcast's failures were on, for words a screen reader can act on. */
function failedHostsSuffix(failedHosts: readonly string[]): string {
  return failedHosts.length === 0 ? "" : ` on ${failedHosts.join(" and ")}`;
}

function buildBroadcastAnnouncement(
  result: FleetExecutionResult,
  failedHosts: readonly string[] = []
): string {
  const permanent = result.permanentlyFailedIds.length;
  const transient = result.transientlyFailedIds.length;
  const skipped =
    result.skippedCount > 0
      ? `, ${pluralize(result.skippedCount, "terminal", "terminals")} skipped`
      : "";

  if (result.cancelled) {
    if (result.successCount === 0 && result.failureCount === 0) {
      if (result.skippedCount > 0) {
        return `Broadcast cancelled — ${pluralize(result.skippedCount, "terminal", "terminals")} skipped`;
      }
      return "Broadcast cancelled";
    }
    if (result.failureCount > 0) {
      return `Broadcast cancelled — ${result.successCount} sent, ${describeFailureSplit(permanent, transient)}${failedHostsSuffix(failedHosts)}${skipped}`;
    }
    return `Broadcast cancelled — ${result.successCount} sent${skipped}`;
  }
  if (result.failureCount > 0) {
    return `Broadcast sent to ${result.successCount} — ${describeFailureSplit(permanent, transient)}${failedHostsSuffix(failedHosts)}${skipped}`;
  }
  return `Broadcast sent to ${pluralize(result.successCount, "terminal", "terminals")}${skipped}`;
}

/**
 * What a structured broadcast's outcome does to the fleet: dead targets are
 * disarmed, retryable ones get the failure chip, delivered ones lose any old
 * failure dot, and the result is announced. `replay` is what a retry needs to
 * send each target what this broadcast sent it.
 */
function applyFleetBroadcastOutcome(
  text: string,
  result: FleetExecutionResult,
  replay?: FleetFailureReplay
): void {
  // Read before the dead ones are disarmed: afterwards nothing here knows them.
  const failedRemote = result.failedIds
    .map((id) => getCrossHostTarget(id))
    .filter((target) => target !== null);
  const failedHosts = [...new Set(failedRemote.map((target) => target.hostName))];
  const goneRemote = failedRemote.filter((target) =>
    result.permanentlyFailedIds.includes(target.key)
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
        // Another host's agent leaves by the same call.
        arming.disarmId(id);
        // `executeFleetBroadcast` already calls `clearDirectingState` on
        // every rejected target, so we don't repeat it here.
        useFleetFailureStore.getState().dismissId(id);
      }
    }
    // A target that left the fleet while its submit was out has nothing left
    // to retry against, and the failure store's own watch on the fleet has
    // already run, so it would sit in the banner for good.
    const retryable = result.transientlyFailedIds.filter(isFleetMember);
    if (retryable.length > 0) {
      // The disarm count rides along so the banner can describe THIS
      // broadcast's permanent casualties without consulting the run store
      // (whose run may be superseded by the time the banner renders).
      useFleetFailureStore
        .getState()
        .recordFailure(text, retryable, result.permanentlyFailedIds.length, replay);
    }
    // Successful targets in a partial-failure run still clear their
    // stale failure dots — same logic as the all-success branch below.
    for (const t of result.perTarget) {
      if (t.status === "fulfilled") {
        useFleetFailureStore.getState().dismissId(t.terminalId);
      }
    }
  } else if (!result.cancelled) {
    // A successful broadcast clears any stale failure dot on the targets it
    // reached — the partial-failure state from a prior attempt is now
    // resolved. A pane locked mid-broadcast was skipped, so its dot stays.
    for (const t of result.perTarget) useFleetFailureStore.getState().dismissId(t.terminalId);
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
  useAnnouncerStore.getState().announce(buildBroadcastAnnouncement(result, failedHosts), "polite");
  if (goneRemote.length > 0 && selectFleetMemberCount(useFleetArmingStore.getState()) === 0) {
    notifyFleetEmptied(goneRemote);
  }
  // Subtle audio confirmation that the prompt fanned out. Reuses the
  // existing context-injected sound — semantically a fleet broadcast
  // IS injecting the same context into N agents. SoundService handles
  // dampening/throttling and respects the user's UI-feedback toggle.
  // Skip the chirp on cancel: the announcement is the feedback channel.
  if (!result.cancelled) {
    window.electron?.notification?.playUiEvent("context-injected").catch(() => {});
  }
}

/**
 * The last members were agents on other hosts that are gone, so the ribbon
 * that would have said so went with them: nothing else on screen tells the
 * person why their fleet vanished.
 */
function notifyFleetEmptied(gone: ReadonlyArray<{ title: string; hostName: string }>): void {
  const hosts = [...new Set(gone.map((target) => target.hostName))].join(" and ");
  const who = gone.length === 1 ? `“${gone[0]!.title}” isn't` : `${gone.length} agents aren't`;
  notify({
    type: "error",
    title: `Couldn't reach ${hosts}`,
    message: `${who} running there anymore, so the fleet is empty. Your message comes back when you add agents again.`,
    action: { label: "Hosts overview", onClick: () => void requestHostsOverview() },
  });
}

/**
 * Send a draft to the whole fleet from outside any pane's composer — the
 * ribbon's own field, which is the only place to type when every member is
 * an agent on another host. True when at least one agent took it.
 */
export async function sendDraftToFleet(text: string): Promise<boolean> {
  const targets = filterEligibleIds(resolveFleetBroadcastTargetIds());
  // One agent on another host is still a fleet worth messaging: this field is
  // the only way to reach it from here. A pane here has its own composer.
  const minimum = targets.every(isHostQualifiedTargetId) ? 1 : 2;
  if (text.length === 0 || targets.length < minimum) return false;
  const result = await runManagedFleetBroadcast(text, targets);
  applyFleetBroadcastOutcome(text, result);
  return result.successCount > 0;
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
 *
 * `onDelivered` runs once the broadcast settles having reached at least one
 * target, so the composer can let go of what it sent. A send that reached
 * none — every target excluded or gone, or every write refused — leaves the
 * draft to the user to edit and send again, and so does one a newer Enter
 * pre-empted, whose cleanup is the newer send's.
 *
 * Context tokens expand per agent here (`executeFleetBroadcast`), but an
 * agent on another host can't be given this machine's context: a send that
 * would hand one a token is consumed without going anywhere, and
 * `onRefused` lets the composer say so. Skipping that agent, or
 * editing the token out of its text, lets the send go.
 *
 * `imagePaths` are the draft's image chips, in order. Each agent here gets the
 * ones its own text names as attachments; one on another host can't open a
 * file saved on this machine, so a send handing it one is refused the same way.
 */
export function tryFleetBroadcastFromEditor(
  terminalId: string,
  text: string,
  onDelivered: () => void,
  onRefused?: (reason: CrossHostRefusal) => void,
  imagePaths: readonly string[] = []
): boolean {
  const arming = useFleetArmingStore.getState();
  if (!arming.armedIds.has(terminalId) || selectFleetMemberCount(arming) < 2) return false;

  const targets = resolveFleetBroadcastTargetIds();
  // A locked origin never fans out, whoever calls in; the pane's own send path
  // owns refusing it.
  if (!targets.includes(terminalId)) return false;

  // Snapshot the override + skip state at the moment Enter is pressed so
  // the broadcast submits the user's intent as it stood at press time —
  // a popover-close effect that clears the overrides store mid-send can't
  // mutate what we already captured here. We deliberately do NOT re-read
  // the live store inside `doSend`.
  const overridesState = useFleetTargetOverridesStore.getState();
  const initialOverrides = { ...overridesState.payloadOverrides };
  const initialSkipped = new Set(overridesState.skippedIds);

  // All eligible targets skipped → consume the Enter (so the single-pane
  // send doesn't also fire) without dispatching anything. The draft stays.
  if (targets.every((id) => initialSkipped.has(id))) {
    useAnnouncerStore.getState().announce("Broadcast skipped — all targets excluded", "polite");
    useFleetTargetOverridesStore.getState().clear();
    return true;
  }

  const images = [...imagePaths];
  const included = targets.filter((id) => !initialSkipped.has(id));
  const refusal: CrossHostRefusal | null =
    findCrossHostContextTargets(text, included, initialOverrides).length > 0
      ? "context"
      : findCrossHostImageTargets(text, included, images, initialOverrides).length > 0
        ? "image"
        : null;
  if (refusal) {
    if (onRefused) onRefused(refusal);
    else useAnnouncerStore.getState().announce(CROSS_HOST_REFUSAL[refusal], "polite");
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
    const send = {};
    latestEditorSend = send;
    let delivered = false;
    try {
      // A second Enter while a broadcast is in-flight pre-empts the first;
      // the shared controller lets the ribbon Cancel button abort it too.
      // Run-history recording now happens when the supervised run finalizes
      // (fleetRunStore), so the record carries watch-phase outcomes too.
      const result = await runManagedFleetBroadcast(text, eligibleTargets, overridesArg, {
        imagePaths: images,
      });
      // A cancel can't take back writes that already landed, so a cancelled
      // run that reached anyone still counts as sent.
      delivered = result.successCount > 0;
      applyFleetBroadcastOutcome(text, result, {
        imagePaths: images,
        perTargetOverrides: effectiveOverrides,
      });
    } finally {
      // Per-target overrides are ephemeral per-broadcast (#8691 constraint).
      // Clear them so the next broadcast starts from the resolved defaults.
      // Controller teardown is owned by `runManagedFleetBroadcast`.
      useFleetTargetOverridesStore.getState().clear();
      const owned = latestEditorSend === send;
      if (owned) latestEditorSend = null;
      if (delivered && owned) onDelivered();
    }
  };

  void doSend();
  return true;
}
