import { useEffect, useRef } from "react";
import { hydrateAppState, type HydrationOptions } from "../../utils/stateHydration";
import { isElectronAvailable } from "../useElectron";
import { projectClient } from "@/clients";
import {
  useProjectStore,
  useTerminalStore,
  useDiagnosticsStore,
  useFocusStore,
  useActionMruStore,
} from "@/store";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useRecipeStore } from "@/store/recipeStore";
import { panelKindUsesTerminalUi } from "@shared/config/panelKindRegistry";
import {
  finalizeProjectSwitchRendererCache,
  isTerminalWarmInProjectSwitchCache,
} from "@/services/projectSwitchRendererCache";
import {
  forceReinitializeWorktreeDataStore,
  setWorktreeLoadError,
  useWorktreeDataStore,
} from "@/store/worktreeDataStore";

interface ProjectSwitchedEventDetail {
  switchId: string;
  projectId: string;
  worktreeLoadError?: string;
}

export function useProjectSwitchRehydration() {
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const setReconnectError = useTerminalStore((s) => s.setReconnectError);
  const hydrateTabGroups = useTerminalStore((s) => s.hydrateTabGroups);
  const hydrateMru = useTerminalStore((s) => s.hydrateMru);
  const setActiveWorktree = useWorktreeSelectionStore((s) => s.setActiveWorktree);
  const loadRecipes = useRecipeStore((s) => s.loadRecipes);
  const openDiagnosticsDock = useDiagnosticsStore((s) => s.openDock);
  const setFocusMode = useFocusStore((s) => s.setFocusMode);
  const hydrateActionMru = useActionMruStore((s) => s.hydrateActionMru);

  const currentSwitchIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isElectronAvailable()) {
      return;
    }

    const callbacks: HydrationOptions = {
      addTerminal: addTerminal as HydrationOptions["addTerminal"],
      setActiveWorktree,
      loadRecipes,
      openDiagnosticsDock,
      setFocusMode,
      setReconnectError,
      hydrateTabGroups,
      hydrateMru,
      hydrateActionMru,
    };

    const handleProjectSwitch = async (event: Event) => {
      const customEvent = event as CustomEvent<ProjectSwitchedEventDetail>;
      const switchId = customEvent.detail?.switchId;
      const projectId = customEvent.detail?.projectId;
      const worktreeLoadError = customEvent.detail?.worktreeLoadError;

      if (!switchId || !projectId) {
        console.error(
          "[useProjectSwitchRehydration] Missing switch metadata in project-switched event, skipping hydration"
        );
        return;
      }

      if (worktreeLoadError) {
        setWorktreeLoadError(projectId, worktreeLoadError);
      } else {
        const storeState = useWorktreeDataStore.getState();
        if (!(storeState.projectId === projectId && storeState.isInitialized)) {
          forceReinitializeWorktreeDataStore(projectId);
        }
      }

      currentSwitchIdRef.current = switchId;

      console.log(
        `[useProjectSwitchRehydration] Received project-switched event (switchId: ${switchId}), re-hydrating state...`
      );

      try {
        await hydrateAppState(callbacks, switchId, () => currentSwitchIdRef.current === switchId);

        if (currentSwitchIdRef.current !== switchId) {
          console.log(
            `[useProjectSwitchRehydration] Skipping wake - hydration superseded by newer switch (current: ${currentSwitchIdRef.current}, this: ${switchId})`
          );
          return;
        }

        const { terminals, activeDockTerminalId } = useTerminalStore.getState();
        const activeWorktreeId = useWorktreeSelectionStore.getState().activeWorktreeId ?? null;

        for (const terminal of terminals) {
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
            const isWarm =
              isTerminalWarmInProjectSwitchCache(projectId, terminal.id) &&
              Boolean(terminalInstanceService.get(terminal.id));
            if (!isWarm) {
              terminalInstanceService.wake(terminal.id);
            }
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
        if (currentSwitchIdRef.current === switchId) {
          finalizeProjectSwitchRendererCache(projectId);
          useProjectStore.getState().finishProjectSwitch();
        }
      }
    };

    window.addEventListener("project-switched", handleProjectSwitch);

    const cleanup = projectClient.onSwitch((payload) => {
      const { project, switchId, worktreeLoadError } = payload;
      console.log(
        `[useProjectSwitchRehydration] Received PROJECT_ON_SWITCH from main process (project: ${project.name}, switchId: ${switchId}), re-hydrating...`
      );
      window.dispatchEvent(
        new CustomEvent<ProjectSwitchedEventDetail>("project-switched", {
          detail: { switchId, projectId: project.id, worktreeLoadError },
        })
      );
    });

    return () => {
      window.removeEventListener("project-switched", handleProjectSwitch);
      cleanup();
    };
  }, [
    addTerminal,
    setActiveWorktree,
    loadRecipes,
    openDiagnosticsDock,
    setFocusMode,
    setReconnectError,
    hydrateTabGroups,
    hydrateMru,
    hydrateActionMru,
  ]);
}
