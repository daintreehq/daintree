import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { useFleetBroadcastProgressStore } from "@/store/fleetBroadcastProgressStore";
import { terminalClient } from "@/clients";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { isTerminalFleetEligible } from "@/store/fleetEligibility";
import { replaceRecipeVariables, type RecipeContext } from "@/utils/recipeVariables";
import type { TerminalInstance } from "@shared/types";
import {
  buildFleetBroadcastRecipeContext,
  classifyFleetRejectionReason,
  FLEET_LARGE_PASTE_BATCH_SIZE,
  FLEET_LARGE_PASTE_BYTE_THRESHOLD,
  getFleetBroadcastByteLength,
  resolveFleetBroadcastTargetIds,
} from "./fleetBroadcast";

export interface FleetTargetPreview {
  terminalId: string;
  title: string;
  resolvedPayload: string;
  unresolvedVars: string[];
  excluded: boolean;
  exclusionReason?: string;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const panel: any = panelsById[id];

    if (isTerminalFleetEligible(panel)) {
      const ctx = buildFleetBroadcastRecipeContext(id) ?? {};
      const resolved = replaceRecipeVariables(draft, ctx);
      const unresolvedVars = detectUnresolved(draft, ctx);

      previews.push({
        terminalId: id,
        title: (panel as TerminalInstance).title ?? "Agent",
        resolvedPayload: resolved,
        unresolvedVars,
        excluded: false,
      });
    } else {
      previews.push({
        terminalId: id,
        title: panel?.title ?? "Unknown",
        resolvedPayload: draft,
        unresolvedVars: [],
        excluded: true,
        exclusionReason: "Panel no longer eligible",
      });
    }
  }

  return previews;
}

function detectUnresolved(text: string, ctx: RecipeContext): string[] {
  const VARIABLE_PATTERN = /\{\{(\w+)\}\}/gi;
  const unresolved: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  const pattern = new RegExp(VARIABLE_PATTERN.source, VARIABLE_PATTERN.flags);
  while ((match = pattern.exec(text)) !== null) {
    const name = match[1]!.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    const resolved = resolveVariable(name, ctx);
    if (resolved === "") unresolved.push(name);
  }
  return unresolved;
}

/**
 * Drop ids whose backing panel is no longer fleet-eligible (trashed,
 * backgrounded, no PTY, etc.). Exported so the Enter-broadcast confirm
 * path can re-check eligibility at dispatch time — a pane that went
 * away while the confirm dialog was open must not still receive bytes.
 */
export function filterEligibleIds(ids: string[]): string[] {
  const { panelsById } = usePanelStore.getState();
  return ids.filter((id) => isTerminalFleetEligible(panelsById[id]));
}

function resolveVariable(name: string, ctx: RecipeContext): string {
  switch (name) {
    case "issue_number":
      return ctx.issueNumber != null ? `#${ctx.issueNumber}` : "";
    case "pr_number":
      return ctx.prNumber != null ? `#${ctx.prNumber}` : "";
    case "number": {
      const num = ctx.issueNumber ?? ctx.prNumber;
      return num != null ? `#${num}` : "";
    }
    case "worktree_path":
      return ctx.worktreePath ?? "";
    case "branch_name":
      return ctx.branchName ?? "";
    default:
      return "";
  }
}

interface ResolvedSubmission {
  terminalId: string;
  payload: string;
}

function resolveSubmissions(
  draft: string,
  targetIds: string[],
  perTargetOverrides?: Record<string, string>
): ResolvedSubmission[] {
  return targetIds.map((terminalId) => {
    const ctx = buildFleetBroadcastRecipeContext(terminalId) ?? {};
    const baseResolved = replaceRecipeVariables(draft, ctx);
    return {
      terminalId,
      payload: perTargetOverrides?.[terminalId] ?? baseResolved,
    };
  });
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

function yieldToEventLoop(): Promise<void> {
  // setTimeout(0) yields to the browser/renderer event loop so the main
  // thread can render and drain IPC between batches. setImmediate is not
  // reliably exposed in Electron's sandboxed renderer.
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

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
  signal?: AbortSignal
): Promise<FleetExecutionResult> {
  const resolved = resolveSubmissions(draft, targetIds, perTargetOverrides);
  const results: PromiseSettledResult<void>[] = [];
  let dispatchedCount = 0;
  let finalized = false;

  useFleetBroadcastProgressStore.getState().init(resolved.length);

  const buildResult = (cancelled: boolean): FleetExecutionResult => {
    const perTarget: FleetExecutionResult["perTarget"] = results.map((r, i) => {
      if (r.status === "fulfilled") {
        return { terminalId: resolved[i]!.terminalId, status: "fulfilled" };
      }
      const reason = String(r.reason);
      return {
        terminalId: resolved[i]!.terminalId,
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
      useFleetBroadcastProgressStore.getState().finishCancelled();
      finalized = true;
      return buildResult(true);
    }

    if (shouldBatchAcrossTargets(resolved)) {
      for (let i = 0; i < resolved.length; i += FLEET_LARGE_PASTE_BATCH_SIZE) {
        if (signal?.aborted) {
          useFleetBroadcastProgressStore.getState().finishCancelled();
          finalized = true;
          return buildResult(true);
        }
        const batch = resolved.slice(i, i + FLEET_LARGE_PASTE_BATCH_SIZE);
        dispatchedCount += batch.length;
        // Enter `directing` on every target BEFORE submit dispatches —
        // mirrors what xterm onData → onUserInput does for the origin.
        // `notifyEnterPressed` alone would skip `directing` (it only fires
        // the `directing → working` transition when the target is already
        // `directing`), so the user-input call is the load-bearing step
        // that makes the blue indicator render fleet-wide. Real payload
        // (not "") preserves Phase 2 escalation for large pastes — see #3565.
        for (const r of batch) terminalInstanceService.notifyUserInput(r.terminalId, r.payload);
        const batchResults = await Promise.allSettled(
          batch.map((r) => terminalClient.submit(r.terminalId, r.payload))
        );
        for (let j = 0; j < batchResults.length; j += 1) {
          const r = batchResults[j]!;
          results.push(r);
          const terminalId = batch[j]!.terminalId;
          if (r.status === "fulfilled") {
            // Submit landed — close out directing and flip to working.
            // `onEnterPressed` is a no-op if the canonical state machine has
            // already transitioned the terminal to working from PTY echo.
            terminalInstanceService.notifyEnterPressed(terminalId);
          } else {
            // Submit rejected — the PTY never received bytes, so revert
            // the synthetic `directing` we set above rather than leaving
            // it to age out on the 1.5s debounce timer.
            terminalInstanceService.clearDirectingState(terminalId);
          }
        }

        const batchFailures = batchResults.filter((r) => r.status === "rejected").length;
        useFleetBroadcastProgressStore.getState().advance(batch.length, batchFailures);

        if (i + FLEET_LARGE_PASTE_BATCH_SIZE < resolved.length) {
          await yieldToEventLoop();
        }
      }
    } else {
      dispatchedCount = resolved.length;
      // Same ordering rule as the batched path — see comment above.
      for (const r of resolved) terminalInstanceService.notifyUserInput(r.terminalId, r.payload);
      const all = await Promise.allSettled(
        resolved.map((r) => terminalClient.submit(r.terminalId, r.payload))
      );
      for (let j = 0; j < all.length; j += 1) {
        const r = all[j]!;
        results.push(r);
        const terminalId = resolved[j]!.terminalId;
        if (r.status === "fulfilled") {
          terminalInstanceService.notifyEnterPressed(terminalId);
        } else {
          terminalInstanceService.clearDirectingState(terminalId);
        }
      }
      const nonBatchedFailures = all.filter((r) => r.status === "rejected").length;
      useFleetBroadcastProgressStore.getState().advance(resolved.length, nonBatchedFailures);
    }

    return buildResult(signal?.aborted ?? false);
  } finally {
    if (!finalized) {
      useFleetBroadcastProgressStore.getState().finish();
    }
  }
}

/**
 * Literal broadcast for pasted text — routes each target through
 * `terminalClient.submit` so the backend wraps the payload in bracketed paste
 * (`\e[200~…\e[201~`) when the PTY supports it. Skips recipe-variable
 * substitution because paste is a verbatim keyboard event, not a composed
 * prompt template.
 */
export async function broadcastFleetLiteralPaste(
  text: string,
  targetIds?: string[]
): Promise<FleetExecutionResult> {
  const ids = targetIds ? filterEligibleIds(targetIds) : resolveFleetBroadcastTargetIds();
  const submissions: Promise<void>[] = [];
  const collected: string[] = [];

  for (const id of ids) {
    collected.push(id);
    submissions.push(terminalClient.submit(id, text));
  }

  const results = await Promise.allSettled(submissions);
  const perTarget: FleetExecutionResult["perTarget"] = results.map((r, i) => {
    if (r.status === "fulfilled") {
      return { terminalId: collected[i]!, status: "fulfilled" };
    }
    const reason = String(r.reason);
    return {
      terminalId: collected[i]!,
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
    cancelled: false,
    skippedCount: 0,
  };
}
