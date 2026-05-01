import { useFleetArmingStore, isFleetArmEligible } from "@/store/fleetArmingStore";
import { usePanelStore } from "@/store/panelStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import type { RecipeContext } from "@/utils/recipeVariables";

export const FLEET_BROADCAST_HISTORY_KEY = "fleet-broadcast" as const;

/**
 * Build a per-project fleet history key so broadcast history doesn't leak
 * across projects. Falls back to the global key when no project is active.
 */
export function getFleetBroadcastHistoryKey(projectId: string | undefined): string {
  if (!projectId) return FLEET_BROADCAST_HISTORY_KEY;
  return `${FLEET_BROADCAST_HISTORY_KEY}:${projectId}`;
}

/**
 * Bytes in UTF-8 rather than JS string length — keeps accounting honest for
 * multi-byte characters when we compare against the backend's paste buffer.
 */
export const FLEET_CONFIRM_BYTE_THRESHOLD = 512;

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

/**
 * Minimum armed-target count at which the in-flight progress counter renders
 * in the fleet ribbon. Below this threshold the per-pane red-dot failure
 * indicators suffice — small fleets stay uncluttered.
 */
export const FLEET_PROGRESS_VISIBILITY_THRESHOLD = 10;

/**
 * Conservative — flags commands that are usually destructive outside a sandbox.
 * Intentionally does NOT try to be a shell parser. False positives are fine
 * (an extra confirm). False negatives are the real cost.
 */
export const FLEET_DESTRUCTIVE_RE =
  /(\brm\s+(?:-[rRfv]{1,4}\s|-[rRfv]{1,4}[^\s]*\s|--recursive\s|--force\s))|(^|\s)sudo\s|(\bgit\s+clean\s+-[a-z]*f[a-z]*\b)|(\bdrop\s+(?:table|database|schema)\b)|(\btruncate\s+table\b)|(\bchmod\s+-R\s+)|(\bmkfs\b)|(\bdd\s+if=)|(\bforkbomb\b)|(:\(\)\s*\{)/i;

export interface FleetBroadcastWarnings {
  multiline: boolean;
  overByteLimit: boolean;
  destructive: boolean;
}

export function getFleetBroadcastByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).length;
  }
  // Fallback approximation — only hit in non-browser runtimes.
  return text.length;
}

export function getFleetBroadcastWarnings(text: string): FleetBroadcastWarnings {
  return {
    multiline: text.includes("\n"),
    overByteLimit: getFleetBroadcastByteLength(text) > FLEET_CONFIRM_BYTE_THRESHOLD,
    destructive: FLEET_DESTRUCTIVE_RE.test(text),
  };
}

export function needsFleetBroadcastConfirmation(text: string): boolean {
  const w = getFleetBroadcastWarnings(text);
  return w.multiline || w.overByteLimit || w.destructive;
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
    prNumber: worktree.prNumber,
    worktreePath: worktree.path,
    branchName: worktree.branch ?? worktree.name,
  };
}
