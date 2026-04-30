import { useEffect, useRef, useState } from "react";
import { hydrateAppState, type HydrationOptions } from "../../utils/stateHydration";
import { isElectronAvailable } from "../useElectron";
import { setStartupQuietPeriod } from "@/lib/notify";
import { logError } from "@/utils/logger";
import { usePanelStore } from "@/store";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useDiagnosticsStore, useFocusStore, useActionMruStore } from "@/store";

export function useAppHydration(enabled = true) {
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
          beginHydrationBatch,
          flushHydrationBatch,
        });

        // Pick an initial focused panel now that hydration is done. The legacy
        // path set focus opportunistically inside `panelStore.addPanel` on every
        // grid panel, ending on whichever was added last. The batched path skips
        // that set (it would defeat the batch), so `focusedId` would otherwise be
        // null after hydration — breaking any action keyed off the focused panel.
        const panelState = usePanelStore.getState();
        const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId;
        if (panelState.focusedId === null && panelState.panelIds.length > 0) {
          const firstGridPanelId = panelState.panelIds.find((panelId) => {
            const panel = panelState.panelsById[panelId];
            return (
              panel &&
              panel.location === "grid" &&
              (panel.worktreeId ?? null) === (activeWorktreeId ?? null)
            );
          });
          if (firstGridPanelId) {
            panelState.setFocused(firstGridPanelId);
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
    beginHydrationBatch,
    flushHydrationBatch,
  ]);

  return { isStateLoaded };
}
