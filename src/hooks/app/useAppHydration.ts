import { useEffect, useRef, useState } from "react";
import { hydrateAppState, type HydrationOptions } from "../../utils/stateHydration";
import { isElectronAvailable } from "../useElectron";
import { setStartupQuietPeriod } from "@/lib/notify";
import { logError } from "@/utils/logger";
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

export function useAppHydration(
  enabled: boolean = true,
  prefetchedHydrateResult?: HydrateResult | null
) {
  const [isStateLoaded, setIsStateLoaded] = useState(false);
  const hasRestoredState = useRef(false);

  const addPanel = usePanelStore((s) => s.addPanel);
  const setReconnectError = usePanelStore((s) => s.setReconnectError);
  const hydrateTabGroups = usePanelStore((s) => s.hydrateTabGroups);
  const restoreTerminalOrder = usePanelStore((s) => s.restoreTerminalOrder);
  const hydrateMru = usePanelStore((s) => s.hydrateMru);
  const beginHydrationBatch = usePanelStore((s) => s.beginHydrationBatch);
  const flushHydrationBatch = usePanelStore((s) => s.flushHydrationBatch);
  const setActiveWorktree = useWorktreeSelectionStore((s) => s.setActiveWorktree);
  const loadRecipes = useRecipeStore((s) => s.loadRecipes);
  const openDiagnosticsDock = useDiagnosticsStore((s) => s.openDock);
  const setFocusMode = useFocusStore((s) => s.setFocusMode);
  const hydrateActionMru = useActionMruStore((s) => s.hydrateActionMru);
  const hydrateActionPrefs = useActionPrefsStore((s) => s.hydrateActionPrefs);

  useEffect(() => {
    if (!isElectronAvailable() || hasRestoredState.current || !enabled) {
      return;
    }

    hasRestoredState.current = true;

    const restoreState = async () => {
      try {
        await hydrateAppState({
          addPanel: ((opts: Record<string, unknown>) =>
            addPanel({ ...opts, bypassLimits: true } as Parameters<
              typeof addPanel
            >[0])) as HydrationOptions["addPanel"],
          setActiveWorktree,
          loadRecipes,
          openDiagnosticsDock,
          setFocusMode,
          setReconnectError,
          hydrateTabGroups,
          restoreTerminalOrder,
          hydrateMru,
          hydrateActionMru,
          hydrateActionPrefs,
          beginHydrationBatch,
          flushHydrationBatch,
          prefetchedHydrateResult: prefetchedHydrateResult ?? undefined,
        });

        // Pick an initial focused panel now that hydration is done. The legacy
        // path set focus opportunistically inside `panelStore.addPanel` on every
        // grid panel, ending on whichever was added last. The batched path skips
        // that set (it would defeat the batch), so `focusedId` would otherwise be
        // null after hydration — breaking any action keyed off the focused panel.
        //
        // Two correctness fixes vs. the pre-#9933 implementation:
        //  1. `pickBootFocusPanelId` selects by highest `lastActiveAt` so the
        //     active worktree's most-recently-focused panel wins, falling back
        //     to first-in-`panelIds`-order for snapshots with no recency data.
        //  2. The pick routes through `setBootFocus` (bare focus commit, no
        //     `stampLastActive`) and is wrapped in `suppressMruRecording` so
        //     the orchestrator's MRU subscription doesn't re-prepend the boot
        //     pick to `mruList`. The orchestrator's `trackTerminalFocus` and
        //     `selectWorktree({ source: "focus" })` subscriptions still fire
        //     — `lastFocusedTerminalByWorktree` is runtime-only and needs the
        //     boot pick to seed it for future worktree switches to restore
        //     last-focus (#9512).
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
      } catch (error) {
        logError("Failed to restore app state", error);
      } finally {
        setIsStateLoaded(true);
        setStartupQuietPeriod(5000);
      }
    };

    restoreState();
  }, [
    enabled,
    prefetchedHydrateResult,
    addPanel,
    setActiveWorktree,
    loadRecipes,
    openDiagnosticsDock,
    setFocusMode,
    setReconnectError,
    hydrateTabGroups,
    restoreTerminalOrder,
    hydrateMru,
    hydrateActionMru,
    hydrateActionPrefs,
    beginHydrationBatch,
    flushHydrationBatch,
  ]);

  return { isStateLoaded };
}
