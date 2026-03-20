import { useEffect, useRef, useState } from "react";
import { hydrateAppState, type HydrationOptions } from "../../utils/stateHydration";
import { isElectronAvailable } from "../useElectron";
import { useTerminalStore } from "@/store";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useRecipeStore } from "@/store/recipeStore";
import { useDiagnosticsStore, useFocusStore, useActionMruStore } from "@/store";

export function useAppHydration(enabled = true) {
  const [isStateLoaded, setIsStateLoaded] = useState(false);
  const hasRestoredState = useRef(false);

  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const setReconnectError = useTerminalStore((s) => s.setReconnectError);
  const hydrateTabGroups = useTerminalStore((s) => s.hydrateTabGroups);
  const restoreTerminalOrder = useTerminalStore((s) => s.restoreTerminalOrder);
  const hydrateMru = useTerminalStore((s) => s.hydrateMru);
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
          addTerminal: addTerminal as HydrationOptions["addTerminal"],
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
      }
    };

    restoreState();
  }, [
    enabled,
    addTerminal,
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
