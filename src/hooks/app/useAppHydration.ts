import { useEffect, useRef, useState } from "react";
import { hydrateAppState, type HydrationOptions } from "../../utils/stateHydration";
import { isElectronAvailable } from "../useElectron";
import { setStartupQuietPeriod } from "@/lib/notify";
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
        });
      } catch (error) {
        console.error("Failed to restore app state:", error);
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
  ]);

  return { isStateLoaded };
}
