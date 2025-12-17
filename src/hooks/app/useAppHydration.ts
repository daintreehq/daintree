/**
 * useAppHydration - Handles initial app state hydration.
 *
 * Extracts hydration logic from App.tsx:
 * - Restores terminal state
 * - Restores active worktree
 * - Loads recipes
 */

import { useEffect, useRef, useState } from "react";
import { hydrateAppState } from "../../utils/stateHydration";
import { isElectronAvailable } from "../useElectron";

type DiagnosticsTab = "problems" | "logs" | "events";

export interface HydrationCallbacks {
  addTerminal: (options: any) => Promise<string>;
  setActiveWorktree: (id: string | null) => void;
  loadRecipes: () => Promise<void>;
  openDiagnosticsDock: (tab?: DiagnosticsTab) => void;
}

export function useAppHydration(callbacks: HydrationCallbacks) {
  const [isStateLoaded, setIsStateLoaded] = useState(false);
  const hasRestoredState = useRef(false);

  useEffect(() => {
    if (!isElectronAvailable() || hasRestoredState.current) {
      return;
    }

    hasRestoredState.current = true;

    const restoreState = async () => {
      try {
        await hydrateAppState(callbacks);
      } catch (error) {
        console.error("Failed to restore app state:", error);
      } finally {
        setIsStateLoaded(true);
      }
    };

    restoreState();
  }, [callbacks.addTerminal, callbacks.setActiveWorktree, callbacks.loadRecipes, callbacks.openDiagnosticsDock]);

  return { isStateLoaded };
}
