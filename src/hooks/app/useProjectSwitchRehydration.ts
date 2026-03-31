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
  hydrateResult?: import("@shared/types/ipc/app").HydrateResult;
  worktreeScopeId?: string;
}

export function useProjectSwitchRehydration() {
  const currentSwitchIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isElectronAvailable()) {
      return;
    }

    const handleProjectSwitch = async (event: Event) => {
      const { addTerminal, setReconnectError, hydrateTabGroups, restoreTerminalOrder, hydrateMru } =
        useTerminalStore.getState();
      const { setActiveWorktree } = useWorktreeSelectionStore.getState();
      const { loadRecipes } = useRecipeStore.getState();
      const { openDock: openDiagnosticsDock } = useDiagnosticsStore.getState();
      const { setFocusMode } = useFocusStore.getState();
      const { hydrateActionMru } = useActionMruStore.getState();

      const callbacks: HydrationOptions = {
        addTerminal: ((opts: Record<string, unknown>) =>
          addTerminal({ ...opts, bypassLimits: true } as Parameters<
            typeof addTerminal
          >[0])) as HydrationOptions["addTerminal"],
        setActiveWorktree,
        loadRecipes,
        openDiagnosticsDock,
        setFocusMode,
        setReconnectError,
        hydrateTabGroups,
        restoreTerminalOrder,
        hydrateMru,
        hydrateActionMru,
      };
      const customEvent = event as CustomEvent<ProjectSwitchedEventDetail>;
      const switchId = customEvent.detail?.switchId;
      const projectId = customEvent.detail?.projectId;
      const worktreeLoadError = customEvent.detail?.worktreeLoadError;
      const prefetchedHydrateResult = customEvent.detail?.hydrateResult;
      const worktreeScopeId = customEvent.detail?.worktreeScopeId;

      if (!switchId || !projectId) {
        console.error(
          "[useProjectSwitchRehydration] Missing switch metadata in project-switched event, skipping hydration"
        );
        return;
      }

      if (worktreeLoadError) {
        setWorktreeLoadError(projectId, worktreeLoadError);
      } else {
        // Always call forceReinitialize — it clears the isSwitching lock set by
        // prePopulateWorktreeSnapshot(), reattaches IPC listeners with the current
        // scopeId, and fetches fresh worktree data from the backend.
        forceReinitializeWorktreeDataStore(projectId, worktreeScopeId);
      }

      currentSwitchIdRef.current = switchId;

      console.log(
        `[useProjectSwitchRehydration] Received project-switched event (switchId: ${switchId}), re-hydrating state...`
      );

      // Clear terminal state just before rehydration to minimize the gap between
      // empty terminals and new terminals being added. This is part of the atomic
      // state swap: terminal state is preserved during resetAllStoresForProjectSwitch
      // (with skipTerminalStateReset) and only cleared here, right before hydration
      // populates new terminals — eliminating the visible empty-grid flash.
      const { clearTerminalStoreForSwitch } = useTerminalStore.getState();
      clearTerminalStoreForSwitch();

      try {
        await hydrateAppState(
          callbacks,
          switchId,
          () => currentSwitchIdRef.current === switchId,
          prefetchedHydrateResult
        );

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
      const { project, switchId, worktreeLoadError, hydrateResult, worktreeScopeId } = payload;
      console.log(
        `[useProjectSwitchRehydration] Received PROJECT_ON_SWITCH from main process (project: ${project.name}, switchId: ${switchId}, hasHydrateResult: ${Boolean(hydrateResult)}), re-hydrating...`
      );
      window.dispatchEvent(
        new CustomEvent<ProjectSwitchedEventDetail>("project-switched", {
          detail: {
            switchId,
            projectId: project.id,
            worktreeLoadError,
            hydrateResult,
            worktreeScopeId,
          },
        })
      );
    });

    return () => {
      window.removeEventListener("project-switched", handleProjectSwitch);
      cleanup();
    };
  }, []);
}
