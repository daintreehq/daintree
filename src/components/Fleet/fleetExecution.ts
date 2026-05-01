import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { terminalClient } from "@/clients";
import { isTerminalFleetEligible } from "@/store/fleetEligibility";
import { replaceRecipeVariables, type RecipeContext } from "@/utils/recipeVariables";
import type { TerminalInstance } from "@shared/types";
import {
  buildFleetBroadcastRecipeContext,
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
  perTarget: Array<{ terminalId: string; status: "fulfilled" | "rejected"; reason?: string }>;
  failedIds: string[];
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

function filterEligibleIds(ids: string[]): string[] {
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
 */
export async function executeFleetBroadcast(
  draft: string,
  targetIds: string[],
  perTargetOverrides?: Record<string, string>
): Promise<FleetExecutionResult> {
  const resolved = resolveSubmissions(draft, targetIds, perTargetOverrides);
  const results: PromiseSettledResult<void>[] = [];

  if (shouldBatchAcrossTargets(resolved)) {
    for (let i = 0; i < resolved.length; i += FLEET_LARGE_PASTE_BATCH_SIZE) {
      const batch = resolved.slice(i, i + FLEET_LARGE_PASTE_BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map((r) => terminalClient.submit(r.terminalId, r.payload))
      );
      for (const r of batchResults) results.push(r);
      if (i + FLEET_LARGE_PASTE_BATCH_SIZE < resolved.length) {
        await yieldToEventLoop();
      }
    }
  } else {
    const all = await Promise.allSettled(
      resolved.map((r) => terminalClient.submit(r.terminalId, r.payload))
    );
    for (const r of all) results.push(r);
  }

  const perTarget: FleetExecutionResult["perTarget"] = results.map((r, i) => ({
    terminalId: resolved[i]!.terminalId,
    status: r.status,
    reason: r.status === "rejected" ? String(r.reason) : undefined,
  }));

  const successCount = results.filter((r) => r.status === "fulfilled").length;
  const failedIds = perTarget.filter((t) => t.status === "rejected").map((t) => t.terminalId);

  return {
    total: results.length,
    successCount,
    failureCount: results.length - successCount,
    perTarget,
    failedIds,
  };
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
  const perTarget: FleetExecutionResult["perTarget"] = results.map((r, i) => ({
    terminalId: collected[i]!,
    status: r.status,
    reason: r.status === "rejected" ? String(r.reason) : undefined,
  }));

  const successCount = results.filter((r) => r.status === "fulfilled").length;
  const failedIds = perTarget.filter((t) => t.status === "rejected").map((t) => t.terminalId);

  return {
    total: results.length,
    successCount,
    failureCount: results.length - successCount,
    perTarget,
    failedIds,
  };
}
