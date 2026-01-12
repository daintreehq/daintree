/**
 * useProjectSwitchRehydration - Handles state re-hydration on project switch.
 *
 * Extracts project switch re-hydration logic from App.tsx.
 */

import { useEffect } from "react";
import { hydrateAppState } from "../../utils/stateHydration";
import { isElectronAvailable } from "../useElectron";
import { projectClient } from "@/clients";
import { useProjectStore, useTerminalStore } from "@/store";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import type { HydrationCallbacks } from "./useAppHydration";

export function useProjectSwitchRehydration(callbacks: HydrationCallbacks) {
  useEffect(() => {
    if (!isElectronAvailable()) {
      return;
    }

    const handleProjectSwitch = async () => {
      console.log(
        "[useProjectSwitchRehydration] Received project-switched event, re-hydrating state..."
      );
      try {
        await hydrateAppState(callbacks);
        const { terminals, activeDockTerminalId } = useTerminalStore.getState();
        const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId ?? null;

        for (const terminal of terminals) {
          if (!panelKindHasPty(terminal.kind ?? "terminal")) {
            continue;
          }

          const isActiveDockTerminal = terminal.id === activeDockTerminalId;
          const isInActiveWorktree = (terminal.worktreeId ?? null) === activeWorktreeId;

          if (isActiveDockTerminal || isInActiveWorktree) {
            terminalInstanceService.wake(terminal.id);
          }
        }
        console.log("[useProjectSwitchRehydration] State re-hydration complete");
      } catch (error) {
        console.error(
          "[useProjectSwitchRehydration] Failed to re-hydrate state after project switch:",
          error
        );
      } finally {
        useProjectStore.getState().finishProjectSwitch();
      }
    };

    window.addEventListener("project-switched", handleProjectSwitch);

    const cleanup = projectClient.onSwitch(() => {
      console.log(
        "[useProjectSwitchRehydration] Received PROJECT_ON_SWITCH from main process, re-hydrating..."
      );
      window.dispatchEvent(new CustomEvent("project-switched"));
    });

    return () => {
      window.removeEventListener("project-switched", handleProjectSwitch);
      cleanup();
    };
  }, [
    callbacks.addTerminal,
    callbacks.setActiveWorktree,
    callbacks.loadRecipes,
    callbacks.openDiagnosticsDock,
    callbacks.setFocusMode,
  ]);
}
