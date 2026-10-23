import { hydrateAppState, type HydrationOptions } from "./index";
import { usePanelStore } from "@/store";
import { suppressMruRecording, useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useRecipeStore } from "@/store/recipeStore";
import {
  useDiagnosticsStore,
  useFocusStore,
  useActionMruStore,
  useActionPrefsStore,
} from "@/store";
import type { HydrateResult } from "@shared/types/ipc/app";

// Minimal shape the picker needs from a hydrated panel. We only read
// `location` and `worktreeId` to filter, and `lastActiveAt` to rank. The
// full `PanelInstance` is wider (kind, agentState, …) but irrelevant here
// — keeping the surface narrow makes the helper trivially testable.
type BootFocusCandidate = {
  location?: string;
  worktreeId?: string;
  lastActiveAt?: number;
};

/**
 * Pick the active worktree's grid panel to focus on boot (#9933).
 *
 * The batched hydration path skips the per-addPanel focus set (it would
 * defeat the batch), so `focusedId` would otherwise be null after
 * hydration — breaking any action keyed off the focused panel.
 *
 * Selection rule:
 * - Iterate `panelIds` in order (so the fallback for snapshots with no
 *   `lastActiveAt` is the first eligible panel, matching legacy behavior).
 * - Among eligible panels (grid, matching worktreeId), prefer the one
 *   with the highest valid `lastActiveAt` (mirrors the per-worktree
 *   `maxLastActiveAtByWorktree` map built in `panelRestorePhase.ts`,
 *   which already uses `Number.isFinite && > 0` to reject zero/NaN
 *   stamps). Returning the panel-with-max wins regardless of insertion
 *   order so a worktree's most-recently-active panel — not an
 *   arbitrary older one — is the boot focus.
 * - When no panel has a valid timestamp (legacy snapshot), the first
 *   eligible panel is returned.
 * - Returns `null` when there are no eligible panels (no grid panels on
 *   the active worktree).
 *
 * Note: this picker does NOT call `setFocused` — the caller is
 * responsible for routing the result through `setBootFocus` inside a
 * `suppressMruRecording(true)/finally(false)` window.
 */
export function pickBootFocusPanelId(
  panelIds: readonly string[],
  panelsById: Readonly<Record<string, BootFocusCandidate | undefined>>,
  activeWorktreeId: string | null | undefined
): string | null {
  const targetWorktreeId = activeWorktreeId ?? null;
  let firstEligibleId: string | null = null;
  let bestId: string | null = null;
  let bestLastActiveAt = -1;

  for (const panelId of panelIds) {
    const panel = panelsById[panelId];
    if (!panel) continue;
    if (panel.location !== "grid") continue;
    if ((panel.worktreeId ?? null) !== targetWorktreeId) continue;
    if (firstEligibleId === null) firstEligibleId = panelId;
    const ts = panel.lastActiveAt;
    if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
    if (ts > bestLastActiveAt) {
      bestLastActiveAt = ts;
      bestId = panelId;
    }
  }

  return bestId ?? firstEligibleId;
}

/**
 * Restore this view's project — panels, tab groups, worktree selection and
 * the boot focus — from main's saved state. Boot runs it once with the
 * prefetched payload; a view that dropped to the picker and is reopened on
 * the same project runs it again with a fresh `appClient.hydrate()`, since
 * main reuses that view rather than cold-starting one (#14179).
 */
export async function restoreViewState(prefetchedHydrateResult?: HydrateResult): Promise<void> {
  const panelStore = usePanelStore.getState();
  type AddPanelOptions = Parameters<typeof panelStore.addPanel>[0];
  await hydrateAppState({
    addPanel: ((opts: Record<string, unknown>) =>
      panelStore.addPanel({
        ...opts,
        bypassLimits: true,
      } as AddPanelOptions)) as HydrationOptions["addPanel"],
    setActiveWorktree: useWorktreeSelectionStore.getState().setActiveWorktree,
    loadRecipes: useRecipeStore.getState().loadRecipes,
    openDiagnosticsDock: useDiagnosticsStore.getState().openDock,
    setFocusMode: useFocusStore.getState().setFocusMode,
    setReconnectError: panelStore.setReconnectError,
    hydrateTabGroups: panelStore.hydrateTabGroups,
    restoreTerminalOrder: panelStore.restoreTerminalOrder,
    hydrateMru: panelStore.hydrateMru,
    hydrateActionMru: useActionMruStore.getState().hydrateActionMru,
    hydrateActionPrefs: useActionPrefsStore.getState().hydrateActionPrefs,
    beginHydrationBatch: panelStore.beginHydrationBatch,
    flushHydrationBatch: panelStore.flushHydrationBatch,
    prefetchedHydrateResult,
  });

  // The batched restore skips addPanel's opportunistic focus, so pick one now:
  // the active worktree's most recently focused panel, committed without
  // stamping MRU (#9933).
  const panelState = usePanelStore.getState();
  const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
  if (panelState.focusedId === null && panelState.panelIds.length > 0) {
    const selectedId = pickBootFocusPanelId(
      panelState.panelIds,
      panelState.panelsById,
      activeWorktreeId
    );
    if (selectedId) {
      try {
        suppressMruRecording(true);
        panelState.setBootFocus(selectedId);
      } finally {
        suppressMruRecording(false);
      }
    }
  }
}
