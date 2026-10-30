import { yieldToScheduler } from "@/lib/schedulerYield";
import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { terminalClient } from "@/clients";
import {
  peek as peekTerminalService,
  with as withTerminalService,
} from "@/services/terminal/terminalInstanceServiceAccessor";
import { isTerminalFleetBroadcastTarget, isTerminalFleetEligible } from "@/store/fleetEligibility";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { isPtyPanel } from "@shared/types/panel";
import { replaceRecipeVariables, detectUnresolvedVariables } from "@/utils/recipeVariables";
import {
  buildFleetBroadcastRecipeContext,
  classifyFleetRejectionReason,
  FLEET_LARGE_PASTE_BATCH_SIZE,
  FLEET_LARGE_PASTE_BYTE_THRESHOLD,
  getFleetBroadcastByteLength,
} from "./fleetBroadcast";
import {
  getArmedCrossHostTargets,
  isCrossHostTargetId,
  isHostQualifiedTargetId,
  submitCrossHostTarget,
} from "./crossHostFleet";
import {
  expandDraftContext,
  listDraftContextTokens,
  shareContextReferenceResolutions,
} from "@/components/Terminal/draftContextExpansion";

export interface FleetTargetPreview {
  terminalId: string;
  title: string;
  resolvedPayload: string;
  unresolvedVars: string[];
  excluded: boolean;
  exclusionReason?: string;
  /** Left out because the person locked the pane's input, not because it broke. */
  inputLocked?: boolean;
  /** Where this agent's `@diff` is taken at send; absent for an agent on another host. */
  contextCwd?: string;
  /** An agent on another host, which can't be handed this machine's context. */
  crossHost?: boolean;
}

export interface FleetExecutionResult {
  total: number;
  successCount: number;
  failureCount: number;
  /**
   * Per-target outcome. `kind` is set only for rejected entries — callers
   * use it to disarm permanent failures (dead PTYs) versus surface a
   * transient retry chip. See `classifyFleetRejectionReason`.
   */
  perTarget: Array<{
    terminalId: string;
    status: "fulfilled" | "rejected";
    reason?: string;
    kind?: "permanent" | "transient";
  }>;
  failedIds: string[];
  /** Subset of `failedIds` whose rejection classified as permanent. */
  permanentlyFailedIds: string[];
  /** Subset of `failedIds` whose rejection classified as transient (retryable). */
  transientlyFailedIds: string[];
  cancelled: boolean;
  skippedCount: number;
}

/**
 * Build per-target previews for the current armed set.
 * Returns one entry per armed terminal (ordered by armOrder), with resolved
 * payload and exclusion status for terminals that are no longer eligible.
 */
export function buildFleetTargetPreviews(draft: string): FleetTargetPreview[] {
  const { armOrder, armedIds } = useFleetArmingStore.getState();
  const { panelsById } = usePanelStore.getState();
  const previews: FleetTargetPreview[] = [];

  for (const id of armOrder) {
    if (!armedIds.has(id)) continue;
    const panel = getNarrowPanel(panelsById, id);

    if (isTerminalFleetBroadcastTarget(panel)) {
      const ctx = buildFleetBroadcastRecipeContext(id) ?? {};
      const resolved = replaceRecipeVariables(draft, ctx);
      const unresolvedVars = detectUnresolvedVariables(draft, ctx);

      previews.push({
        terminalId: id,
        title: panel.title ?? "Agent",
        resolvedPayload: resolved,
        unresolvedVars,
        excluded: false,
        contextCwd: panel.cwd,
      });
    } else {
      const inputLocked = isTerminalFleetEligible(panel);
      previews.push({
        terminalId: id,
        title: panel?.title ?? "Unknown",
        resolvedPayload: draft,
        unresolvedVars: [],
        excluded: true,
        exclusionReason: inputLocked ? "Input locked" : "Panel no longer eligible",
        ...(inputLocked ? { inputLocked: true } : {}),
      });
    }
  }

  // Another host's agent has no panel here and no worktree to resolve
  // variables against, so its preview is the draft as typed.
  for (const target of getArmedCrossHostTargets()) {
    previews.push({
      terminalId: target.key,
      title: `${target.title} · ${target.hostName}`,
      resolvedPayload: draft,
      unresolvedVars: [],
      excluded: false,
      crossHost: true,
    });
  }

  return previews;
}

/**
 * The agents on other hosts whose text in this send still carries a context
 * token. Nothing here can expand one for them, and sent as typed it would
 * mean something other than what every agent here gets, so a send that
 * includes any of them can't go.
 */
export function findCrossHostContextTargets(
  draft: string,
  targetIds: readonly string[],
  perTargetOverrides?: Record<string, string>
): string[] {
  return targetIds.filter(
    (id) =>
      isHostQualifiedTargetId(id) &&
      listDraftContextTokens(perTargetOverrides?.[id] ?? draft).length > 0
  );
}

/**
 * Drop ids whose backing panel is no longer fleet-eligible (trashed,
 * backgrounded, no PTY, etc.) or whose input is locked. Exported so the Enter-broadcast confirm
 * path can re-check eligibility at dispatch time — a pane that went
 * away while the confirm dialog was open must not still receive bytes.
 */
export function filterEligibleIds(ids: string[]): string[] {
  const { panelsById } = usePanelStore.getState();
  // Another host's agent stays eligible while it is armed; the host refuses a dead one.
  return ids.filter(
    (id) =>
      isCrossHostTargetId(id) || isTerminalFleetBroadcastTarget(getNarrowPanel(panelsById, id))
  );
}

/**
 * Local submits go through this view's terminal client; another host's go over
 * its link, where a retry reuses the opId of a submit the host never confirmed.
 */
function submitTarget(terminalId: string, payload: string, retry: boolean): Promise<void> {
  return isCrossHostTargetId(terminalId)
    ? submitCrossHostTarget(terminalId, payload, { retry })
    : terminalClient.submit(terminalId, payload);
}

function noteUserInput(terminalId: string, payload: string): void {
  if (!isCrossHostTargetId(terminalId))
    withTerminalService((service) => service.notifyUserInput(terminalId, payload), terminalId);
}

function noteSubmitted(terminalId: string): void {
  if (!isCrossHostTargetId(terminalId)) peekTerminalService()?.notifyEnterPressed(terminalId);
}

function noteRejected(terminalId: string): void {
  if (!isCrossHostTargetId(terminalId))
    withTerminalService((service) => service.clearDirectingState(terminalId), terminalId);
}

interface ResolvedSubmission {
  terminalId: string;
  payload: string;
  /** What the user wrote for this target, before its recipe variables were filled. */
  authored: string;
}

function resolveSubmissions(
  draft: string,
  targetIds: string[],
  perTargetOverrides?: Record<string, string>
): ResolvedSubmission[] {
  return targetIds.map((terminalId) => {
    // Another host's agent has no worktree here to resolve against: it gets the draft as typed,
    // which is what its preview shows.
    const baseResolved = isCrossHostTargetId(terminalId)
      ? draft
      : replaceRecipeVariables(draft, buildFleetBroadcastRecipeContext(terminalId) ?? {});
    const override = perTargetOverrides?.[terminalId];
    return {
      terminalId,
      payload: override ?? baseResolved,
      authored: override ?? draft,
    };
  });
}

/**
 * Each agent here gets the context its own text names, from itself: `@diff`
 * from its own working directory, `@terminal` and `@selection` from its own
 * screen, as a send from its own composer would. Plugin context is asked for
 * once and handed to every agent alike.
 */
async function expandSubmissionContext(
  submissions: ResolvedSubmission[]
): Promise<ResolvedSubmission[]> {
  const resolveReferences = shareContextReferenceResolutions();
  const { panelsById } = usePanelStore.getState();
  return Promise.all(
    submissions.map(async (submission) => {
      if (!carriesLocalContext(submission)) return submission;
      const panel = getNarrowPanel(panelsById, submission.terminalId);
      const cwd = panel && isPtyPanel(panel) ? panel.cwd : "";
      const payload = await expandDraftContext(submission.payload, {
        terminalId: submission.terminalId,
        cwd,
        resolveReferences,
      });
      return { ...submission, payload };
    })
  );
}

function carriesLocalContext(submission: ResolvedSubmission): boolean {
  return (
    !isCrossHostTargetId(submission.terminalId) &&
    listDraftContextTokens(submission.payload).length > 0
  );
}

// A send that landed is one its terminal's dictations can be cleaned up
// against, noted as it lands so a slower target can't put it behind a later
// send. Another host's agent keeps its own.
function submitAndNote(submission: ResolvedSubmission, retry: boolean): Promise<void> {
  const sentAt = Date.now();
  return submitTarget(submission.terminalId, submission.payload, retry).then(() => {
    if (isCrossHostTargetId(submission.terminalId)) return;
    useTerminalInputStore
      .getState()
      .recordSentPrompt(submission.terminalId, submission.authored, sentAt);
  });
}

// Callers filter locked panes when they pick targets, but a pane locked while a
// broadcast waits its turn or between large-paste batches must still get nothing.
function isLocalTargetLocked(terminalId: string): boolean {
  if (isCrossHostTargetId(terminalId)) return false;
  const panel = getNarrowPanel(usePanelStore.getState().panelsById, terminalId);
  return panel !== undefined && isPtyPanel(panel) && panel.isInputLocked === true;
}

function shouldBatchAcrossTargets(resolved: ResolvedSubmission[]): boolean {
  if (resolved.length <= FLEET_LARGE_PASTE_BATCH_SIZE) return false;
  for (const r of resolved) {
    if (getFleetBroadcastByteLength(r.payload) >= FLEET_LARGE_PASTE_BYTE_THRESHOLD) {
      return true;
    }
  }
  return false;
}

// The progress store follows one broadcast. A newer one aborts and takes it
// over, so a superseded run settling later leaves it alone.
let latestRun = 0;

/**
 * Execute a fleet broadcast to the given target IDs with per-target payload
 * overrides. Returns structured results including which targets failed for
 * retry-failed functionality.
 *
 * Targets with payloads at or above `FLEET_LARGE_PASTE_BYTE_THRESHOLD`
 * (100 KB) are fanned out in batches of `FLEET_LARGE_PASTE_BATCH_SIZE` with a
 * `setTimeout(0)` yield between batches. Keeps the renderer responsive when a
 * large paste would otherwise block the main thread for hundreds of ms.
 *
 * Per-target rejections (EPIPE/EBADF from a PTY that died mid-write) are
 * absorbed by `Promise.allSettled` and reported as rejected entries in
 * `perTarget` / `failedIds`. The caller decides whether to surface them.
 *
 * Cancellation is cooperative: `signal` is checked at inter-batch
 * boundaries (and once before the non-batched path's allSettled completes).
 * Already-dispatched IPC writes cannot be revoked — the result reports
 * what actually fired and marks `cancelled: true` plus a `skippedCount` of
 * targets in unstarted batches.
 */
export async function executeFleetBroadcast(
  draft: string,
  targetIds: string[],
  perTargetOverrides?: Record<string, string>,
  signal?: AbortSignal,
  options: { retry?: boolean } = {}
): Promise<FleetExecutionResult> {
  const retry = options.retry === true;
  const run = ++latestRun;
  const progress = () => (run === latestRun ? useFleetBroadcastProgressStore.getState() : null);
  let resolved = resolveSubmissions(draft, targetIds, perTargetOverrides);
  // Targets that stopped being fleet recipients while their context was read.
  let leftFleet: ReadonlySet<string> | null = null;
  const canDispatch = (r: ResolvedSubmission) =>
    !isLocalTargetLocked(r.terminalId) && !leftFleet?.has(r.terminalId);
  const results: PromiseSettledResult<void>[] = [];
  // Parallel to `results`: what was actually sent, since a pane locked
  // mid-broadcast drops out of its batch.
  const dispatched: ResolvedSubmission[] = [];
  let dispatchedCount = 0;
  let finalized = false;

  progress()?.init(resolved.length);

  const buildResult = (cancelled: boolean): FleetExecutionResult => {
    const perTarget: FleetExecutionResult["perTarget"] = results.map((r, i) => {
      if (r.status === "fulfilled") {
        return { terminalId: dispatched[i]!.terminalId, status: "fulfilled" };
      }
      const reason = String(r.reason);
      return {
        terminalId: dispatched[i]!.terminalId,
        status: "rejected",
        reason,
        kind: classifyFleetRejectionReason(reason),
      };
    });
    const successCount = results.filter((r) => r.status === "fulfilled").length;
    const failedIds: string[] = [];
    const permanentlyFailedIds: string[] = [];
    const transientlyFailedIds: string[] = [];
    for (const t of perTarget) {
      if (t.status !== "rejected") continue;
      failedIds.push(t.terminalId);
      if (t.kind === "transient") transientlyFailedIds.push(t.terminalId);
      else permanentlyFailedIds.push(t.terminalId);
    }
    return {
      total: results.length,
      successCount,
      failureCount: results.length - successCount,
      perTarget,
      failedIds,
      permanentlyFailedIds,
      transientlyFailedIds,
      cancelled,
      skippedCount: Math.max(0, resolved.length - dispatchedCount),
    };
  };

  try {
    if (signal?.aborted) {
      progress()?.finishCancelled();
      finalized = true;
      return buildResult(true);
    }

    if (resolved.some(carriesLocalContext)) {
      // A `@diff` fetch or a plugin is a wait that Cancel, or a newer send,
      // can land in before anything has gone out.
      resolved = await expandSubmissionContext(resolved);
      if (signal?.aborted) {
        progress()?.finishCancelled();
        finalized = true;
        return buildResult(true);
      }
      const ids = resolved.map((r) => r.terminalId);
      const eligible = new Set(filterEligibleIds(ids));
      leftFleet = new Set(ids.filter((id) => !eligible.has(id)));
    }

    if (shouldBatchAcrossTargets(resolved)) {
      for (let i = 0; i < resolved.length; i += FLEET_LARGE_PASTE_BATCH_SIZE) {
        if (signal?.aborted) {
          progress()?.finishCancelled();
          finalized = true;
          return buildResult(true);
        }
        const slice = resolved.slice(i, i + FLEET_LARGE_PASTE_BATCH_SIZE);
        const batch = slice.filter(canDispatch);
        dispatchedCount += batch.length;
        // Enter `directing` on every target BEFORE submit dispatches —
        // mirrors what xterm onData → onUserInput does for the origin.
        // `notifyEnterPressed` alone would skip `directing` (it only fires
        // the `directing → working` transition when the target is already
        // `directing`), so the user-input call is the load-bearing step
        // that makes the blue indicator render fleet-wide. Real payload
        // (not "") preserves Phase 2 escalation for large pastes — see #3565.
        for (const r of batch) noteUserInput(r.terminalId, r.payload);
        const batchResults = await Promise.allSettled(batch.map((r) => submitAndNote(r, retry)));
        for (let j = 0; j < batchResults.length; j += 1) {
          const r = batchResults[j]!;
          results.push(r);
          dispatched.push(batch[j]!);
          const terminalId = batch[j]!.terminalId;
          if (r.status === "fulfilled") {
            // Submit landed — close out directing and flip to working.
            // `onEnterPressed` is a no-op if the canonical state machine has
            // already transitioned the terminal to working from PTY echo.
            noteSubmitted(terminalId);
          } else {
            // Submit rejected — the PTY never received bytes, so revert
            // the synthetic `directing` we set above rather than leaving
            // it to age out on the 1.5s debounce timer.
            noteRejected(terminalId);
          }
        }

        const batchFailures = batchResults.filter((r) => r.status === "rejected").length;
        progress()?.advance(slice.length, batchFailures);

        if (i + FLEET_LARGE_PASTE_BATCH_SIZE < resolved.length) {
          await yieldToScheduler();
        }
      }
    } else {
      const batch = resolved.filter(canDispatch);
      dispatchedCount = batch.length;
      // Same ordering rule as the batched path — see comment above.
      for (const r of batch) noteUserInput(r.terminalId, r.payload);
      const all = await Promise.allSettled(batch.map((r) => submitAndNote(r, retry)));
      for (let j = 0; j < all.length; j += 1) {
        const r = all[j]!;
        results.push(r);
        dispatched.push(batch[j]!);
        const terminalId = batch[j]!.terminalId;
        if (r.status === "fulfilled") {
          noteSubmitted(terminalId);
        } else {
          noteRejected(terminalId);
        }
      }
      const nonBatchedFailures = all.filter((r) => r.status === "rejected").length;
      progress()?.advance(resolved.length, nonBatchedFailures);
    }

    return buildResult(signal?.aborted ?? false);
  } finally {
    if (!finalized) {
      progress()?.finish();
    }
  }
}
