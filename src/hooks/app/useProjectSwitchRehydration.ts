/**
 * useProjectSwitchRehydration - Handles state re-hydration on project switch.
 *
 * Extracts project switch re-hydration logic from App.tsx.
 * Uses switchId to prevent stale hydrations from overlapping switches.
 */

import { useEffect, useRef } from "react";
import { hydrateAppState } from "../../utils/stateHydration";
import { isElectronAvailable } from "../useElectron";
import { projectClient } from "@/clients";
import { useProjectStore, useTerminalStore } from "@/store";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { panelKindUsesTerminalUi } from "@shared/config/panelKindRegistry";
import { finalizeProjectSwitchRendererCache } from "@/services/projectSwitchRendererCache";
import type { HydrationCallbacks } from "./useAppHydration";

interface ProjectSwitchedEventDetail {
  switchId: string;
  projectId: string;
}

export function useProjectSwitchRehydration(callbacks: HydrationCallbacks) {
  // Track the current switchId to prevent stale hydrations
  const currentSwitchIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isElectronAvailable()) {
      return;
    }

    const handleProjectSwitch = async (event: Event) => {
      const customEvent = event as CustomEvent<ProjectSwitchedEventDetail>;
      const switchId = customEvent.detail?.switchId;
      const projectId = customEvent.detail?.projectId;

      // Enforce non-empty switchId for staleness checks
      if (!switchId || !projectId) {
        console.error(
          "[useProjectSwitchRehydration] Missing switch metadata in project-switched event, skipping hydration"
        );
        return;
      }

      // Update the current switchId - any previous hydration is now stale
      currentSwitchIdRef.current = switchId;

      console.log(
        `[useProjectSwitchRehydration] Received project-switched event (switchId: ${switchId}), re-hydrating state...`
      );

      try {
        await hydrateAppState(callbacks, switchId, () => currentSwitchIdRef.current === switchId);

        // Check if this hydration is still current before waking terminals
        if (currentSwitchIdRef.current !== switchId) {
          console.log(
            `[useProjectSwitchRehydration] Skipping wake - hydration superseded by newer switch (current: ${currentSwitchIdRef.current}, this: ${switchId})`
          );
          return;
        }

        const { terminals, activeDockTerminalId } = useTerminalStore.getState();
        const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId ?? null;

        for (const terminal of terminals) {
          // Check staleness before each wake to handle rapid switches
          if (currentSwitchIdRef.current !== switchId) {
            console.log(`[useProjectSwitchRehydration] Aborting wake loop - switch superseded`);
            break;
          }

          if (!panelKindUsesTerminalUi(terminal.kind ?? "terminal")) {
            continue;
          }

          const isActiveDockTerminal = terminal.id === activeDockTerminalId;
          const isInActiveWorktree = (terminal.worktreeId ?? null) === activeWorktreeId;

          if (isActiveDockTerminal || isInActiveWorktree) {
            terminalInstanceService.wake(terminal.id);
          }
        }

        if (currentSwitchIdRef.current === switchId) {
          console.log("[useProjectSwitchRehydration] State re-hydration complete");
        }
      } catch (error) {
        console.error(
          "[useProjectSwitchRehydration] Failed to re-hydrate state after project switch:",
          error
        );
      } finally {
        // Only finalize if this is still the current switch
        if (currentSwitchIdRef.current === switchId) {
          finalizeProjectSwitchRendererCache(projectId);
          useProjectStore.getState().finishProjectSwitch();
        }
      }
    };

    window.addEventListener("project-switched", handleProjectSwitch);

    const cleanup = projectClient.onSwitch((payload) => {
      const { project, switchId } = payload;
      console.log(
        `[useProjectSwitchRehydration] Received PROJECT_ON_SWITCH from main process (project: ${project.name}, switchId: ${switchId}), re-hydrating...`
      );
      // Note: Browser state is NOT reset here. Browser state is keyed by panelId (and
      // optionally worktreeId), so different projects have different panel IDs and won't
      // conflict. This preserves zoom factors across project switches.
      window.dispatchEvent(
        new CustomEvent<ProjectSwitchedEventDetail>("project-switched", {
          detail: { switchId, projectId: project.id },
        })
      );
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
    callbacks.setReconnectError,
    callbacks.hydrateTabGroups,
    callbacks.hydrateMru,
  ]);
}
