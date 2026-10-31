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
 * The agents on other hosts whose text in this send still names one of the
 * draft's image chips. The image was saved on this machine, so its path means
 * nothing over there, and sent as text it can't become an attachment either.
 */
export function findCrossHostImageTargets(
  draft: string,
  targetIds: readonly string[],
  imagePaths: readonly string[],
  perTargetOverrides?: Record<string, string>
): string[] {
  if (imagePaths.length === 0) return [];
  return targetIds.filter(
    (id) =>
      isHostQualifiedTargetId(id) &&
      imagePaths.some((path) => (perTargetOverrides?.[id] ?? draft).includes(path))
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
 * Local submits go through this view's terminal client, carrying the images
 * the target's text names so each can go as an attachment (#12792); another
 * host's go over its link, where a retry reuses the opId of a submit the host
 * never confirmed. An image path never goes there: the send is refused first.
 */
function submitTarget(submission: ResolvedSubmission, retry: boolean): Promise<void> {
  const { terminalId, payload, imagePaths } = submission;
  if (isHostQualifiedTargetId(terminalId)) {
    if (imagePaths.length > 0) {
      return Promise.reject(new Error("An image can't reach an agent on another host"));
    }
    return submitCrossHostTarget(terminalId, payload, { retry });
  }
  return imagePaths.length > 0
    ? terminalClient.submitWithImages(terminalId, payload, [...imagePaths])
    : terminalClient.submit(terminalId, payload);
}

function noteUserInput(terminalId: string, payload: string): void {
  if (!isHostQualifiedTargetId(terminalId))
    withTerminalService((service) => service.notifyUserInput(terminalId, payload), terminalId);
}

function noteSubmitted(terminalId: string): void {
  if (!isHostQualifiedTargetId(terminalId)) peekTerminalService()?.notifyEnterPressed(terminalId);
}

function noteRejected(terminalId: string): void {
  if (!isHostQualifiedTargetId(terminalId))
    withTerminalService((service) => service.clearDirectingState(terminalId), terminalId);
}

interface ResolvedSubmission {
  terminalId: string;
  payload: string;
  /** What the user wrote for this target, before its recipe variables were filled. */
  authored: string;
  /** The draft's image chips this target's own text still names, in order. */
  imagePaths: readonly string[];
}

function resolveSubmissions(
  draft: string,
  targetIds: string[],
  perTargetOverrides: Record<string, string> | undefined,
  imagePaths: readonly string[]
): ResolvedSubmission[] {
  return targetIds.map((terminalId) => {
    // Another host's agent has no worktree here to resolve against: it gets the draft as typed,
    // which is what its preview shows.
    const baseResolved = isHostQualifiedTargetId(terminalId)
      ? draft
      : replaceRecipeVariables(draft, buildFleetBroadcastRecipeContext(terminalId) ?? {});
    const override = perTargetOverrides?.[terminalId];
    const authored = override ?? draft;
    return {
      terminalId,
      payload: override ?? baseResolved,
      authored,
      // Read from what the user wrote, not the expanded payload: a diff that
      // happens to mention the path doesn't make it an attachment.
      imagePaths: imagePaths.filter((path) => authored.includes(path)),
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
    !isHostQualifiedTargetId(submission.terminalId) &&
    listDraftContextTokens(submission.payload).length > 0
  );
}

// A send that landed is one its terminal's dictations can be cleaned up
// against, noted as it lands so a slower target can't put it behind a later
// send. Another host's agent keeps its own.
function submitAndNote(submission: ResolvedSubmission, retry: boolean): Promise<void> {
  const sentAt = Date.now();
  return submitTarget(submission, retry).then(() => {
    if (isHostQualifiedTargetId(submission.terminalId)) return;
    useTerminalInputStore
      .getState()
      .recordSentPrompt(submission.terminalId, submission.authored, sentAt);
  });
}

/**
 * Callers pick targets from the fleet as it stood when the send began, but a
 * context read or a large paste's batches leave time for that to change. A
 * target that has since left the fleet (disarmed, Exit Fleet, the fleet's panes
 * trashed) gets nothing that hasn't gone out yet, nor does a pane that was
 * locked, docked, backgrounded or lost its PTY. Another host's agent exists
 * here only while it is armed, so once it leaves there is nowhere left to send
 * it, and its key must never reach this view's terminals.
 */
function isStillRecipient(terminalId: string): boolean {
  if (isHostQualifiedTargetId(terminalId)) return isCrossHostTargetId(terminalId);
  return (
    useFleetArmingStore.getState().armedIds.has(terminalId) &&
    isTerminalFleetBroadcastTarget(getNarrowPanel(usePanelStore.getState().panelsById, terminalId))
  );
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
 * Cancellation is cooperative: `signal` is checked after context expansion
 * and at inter-batch boundaries (and once before the non-batched path's
 * allSettled completes). Already-dispatched IPC writes cannot be revoked — the
 * result reports what actually fired and marks `cancelled: true` plus a
 * `skippedCount` of targets in unstarted batches.
 *
 * Only fleet members are sent to: each target is checked again right before
 * its submit, and one that has left the fleet or stopped being a broadcast
 * target since is counted in `skippedCount`, neither sent nor failed.
 *
 * `imagePaths` are the composer's image chips: each local target is given the
 * ones its own text still names, as a single-pane send of that text would be.
 */
export async function executeFleetBroadcast(
  draft: string,
  targetIds: string[],
  perTargetOverrides?: Record<string, string>,
  signal?: AbortSignal,
  options: { retry?: boolean; imagePaths?: readonly string[] } = {}
): Promise<FleetExecutionResult> {
  const retry = options.retry === true;
  const run = ++latestRun;
  const progress = () => (run === latestRun ? useFleetBroadcastProgressStore.getState() : null);
  let resolved = resolveSubmissions(
    draft,
    targetIds,
    perTargetOverrides,
    options.imagePaths ?? []
  );
  // Checked right before each submit, so a target that stops being a recipient
  // while its context is read or between batches is skipped, never sent.
  const canDispatch = (r: ResolvedSubmission) => isStillRecipient(r.terminalId);
  const results: PromiseSettledResult<void>[] = [];
  // Parallel to `results`: what was actually sent, since a target that stops
  // being a recipient mid-broadcast drops out of its batch.
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
