import { useFleetArmingStore } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { terminalClient } from "@/clients";
import { replaceRecipeVariables, type RecipeContext } from "@/utils/recipeVariables";
import { buildFleetBroadcastRecipeContext, resolveFleetBroadcastTargetIds } from "./fleetBroadcast";

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
    const panel = panelsById[id];
    if (!panel || panel.location === "trash" || panel.location === "background") {
      previews.push({
        terminalId: id,
        title: panel?.title ?? "Unknown",
        resolvedPayload: draft,
        unresolvedVars: [],
        excluded: true,
        exclusionReason: "Panel no longer eligible",
      });
      continue;
    }

    const ctx = buildFleetBroadcastRecipeContext(id);
    const resolved = ctx ? replaceRecipeVariables(draft, ctx) : draft;
    const unresolvedVars = ctx ? detectUnresolved(draft, ctx) : [];

    previews.push({
      terminalId: id,
      title: panel.title ?? "Agent",
      resolvedPayload: resolved,
      unresolvedVars,
      excluded: false,
    });
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

/**
 * Execute a fleet broadcast to the given target IDs with per-target payload
 * overrides. Returns structured results including which targets failed for
 * retry-failed functionality.
 */
export async function executeFleetBroadcast(
  draft: string,
  targetIds: string[],
  perTargetOverrides?: Record<string, string>
): Promise<FleetExecutionResult> {
  const submissions: Promise<void>[] = [];
  const ids: string[] = [];

  for (const terminalId of targetIds) {
    const ctx = buildFleetBroadcastRecipeContext(terminalId) ?? {};
    const baseResolved = replaceRecipeVariables(draft, ctx);
    const payload = perTargetOverrides?.[terminalId] ?? baseResolved;
    ids.push(terminalId);
    submissions.push(terminalClient.submit(terminalId, payload));
  }

  const results = await Promise.allSettled(submissions);
  const perTarget: FleetExecutionResult["perTarget"] = results.map((r, i) => ({
    terminalId: ids[i]!,
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
 * Fire-and-forget fan-out of a raw terminal byte sequence to each target via
 * the MessagePort write path. Used by the live keystroke capture — keys like
 * Enter (`\r`), Backspace (`\x7f`), or arrow-key CSI sequences go straight to
 * the PTY without recipe-variable substitution or bracketed-paste wrapping.
 *
 * Targets are re-resolved fresh when omitted so trashed/exited terminals drop
 * out silently between keystrokes.
 */
export function broadcastFleetKeySequence(sequence: string, targetIds?: string[]): void {
  const ids = targetIds ?? resolveFleetBroadcastTargetIds();
  for (const id of ids) {
    terminalClient.write(id, sequence);
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
  const ids = targetIds ?? resolveFleetBroadcastTargetIds();
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
