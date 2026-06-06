import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import type { RecipeContext } from "@/utils/recipeVariables";

export const FLEET_BROADCAST_HISTORY_KEY = "fleet-broadcast" as const;

/**
 * Errno codes that mean the target PTY is permanently gone — the renderer
 * should auto-disarm so the user isn't typing into a dead pane. Other
 * failures still surface the failure chip but leave the arming alone.
 *
 * Shared by both fleet broadcast paths:
 *   - Raw-input (`fleetRawInputBroadcast`) reads `result.error.code` from the
 *     `broadcast-write-result` IPC payload.
 *   - Structured-submit (`fleetExecution.buildResult`) extracts the code from
 *     the rejection's stringified message — Electron's structured-clone serialization strips
 *     `NodeJS.ErrnoException.code`, so `handleTerminalSubmit` embeds the code
 *     as a leading `"CODE: …"` token in the thrown error's message.
 */
export const PERMANENT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "EPIPE",
  "EIO",
  "EBADF",
  "ECONNRESET",
  "ENOTCONN",
  "ENXIO",
  "EINVAL",
]);

/**
 * Classify a stringified rejection reason from `terminalClient.submit` as a
 * permanent (dead-PTY) failure or a transient one. Permanent failures
 * auto-disarm the target; transient failures surface a retryable chip.
 *
 * Submit path note: classification leans on the errno token the IPC handler
 * embeds in the message (`handleTerminalSubmit` prefixes its dead-PTY
 * AppErrors with `"EBADF: …"` / `"EPIPE: …"` because Electron's
 * structured-clone error serialization strips `.code`). An unknown reason
 * is treated as **transient** — submit rejections can come from many
 * sources (infra hiccup, IPC framework error) where the user's retry is
 * the right recovery. Wrongly disarming on a transient infra blip would
 * silently drop fleet membership, which is the worse failure mode here.
 * Contrast with the raw-input path: a missing `.code` there means a
 * single keystroke that's not meaningful to replay, so it disarms on
 * unknown (see `applyFleetBroadcastResult`).
 */
export function classifyFleetRejectionReason(
  reason: string | undefined
): "permanent" | "transient" {
  if (!reason) return "transient";
  for (const code of PERMANENT_FAILURE_CODES) {
    if (reason.includes(code)) return "permanent";
  }
  return "transient";
}

/**
 * Build a per-project fleet history key so broadcast history doesn't leak
 * across projects. Falls back to the global key when no project is active.
 */
export function getFleetBroadcastHistoryKey(projectId: string | undefined): string {
  if (!projectId) return FLEET_BROADCAST_HISTORY_KEY;
  return `${FLEET_BROADCAST_HISTORY_KEY}:${projectId}`;
}

/**
 * Payloads at or above this size trigger cross-target batching so the IPC
 * fan-out doesn't block the renderer for multi-hundred-ms stretches when a
 * large paste hits N armed terminals at once. 100 KB matches documented
 * V8 string-allocation pressure points for synchronous broadcast paths.
 */
export const FLEET_LARGE_PASTE_BYTE_THRESHOLD = 102_400;

/**
 * Maximum targets serviced in a single batch. The remaining targets wait on
 * the next event-loop turn via `setTimeout(0)` so the main thread can render
 * and drain IPC between groups.
 */
export const FLEET_LARGE_PASTE_BATCH_SIZE = 5;

export function getFleetBroadcastByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  // Fallback approximation — only hit in non-browser runtimes.
  return text.length;
}

/**
 * Re-evaluate arming set against live panel state so we never submit to a
 * trashed, backgrounded, or exited terminal that was armed earlier.
 * Preserves the `armOrder` ordering from fleetArmingStore.
 */
export function resolveFleetBroadcastTargetIds(): string[] {
  const { armOrder, armedIds } = useFleetArmingStore.getState();
  if (armedIds.size === 0) return [];
  const { panelsById } = usePanelStore.getState();
  const out: string[] = [];
  for (const id of armOrder) {
    if (!armedIds.has(id)) continue;
    const panel = panelsById[id];
    if (isFleetArmEligible(panel)) out.push(id);
  }
  return out;
}

export function buildFleetBroadcastRecipeContext(terminalId: string): RecipeContext | null {
  const panel = usePanelStore.getState().panelsById[terminalId];
  if (!panel) return null;
  const worktreeId = panel.worktreeId;
  if (!worktreeId) return null;
  let worktree;
  try {
    worktree = getCurrentViewStore().getState().worktrees.get(worktreeId);
  } catch {
    // WorktreeViewStore not initialized — renderer not fully mounted.
    return null;
  }
  if (!worktree) return null;
  return {
    issueNumber: worktree.issueNumber,
    prNumber: worktree.linked?.pr?.ref.number,
    worktreePath: worktree.path,
    branchName: worktree.branch ?? worktree.name,
  };
}
