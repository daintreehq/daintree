import { useCallback, useEffect, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useProjectRelocationStore } from "@/store/projectRelocationStore";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { copyWithToast } from "@/lib/copyWithToast";
import { projectClient } from "@/clients";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { Project } from "@shared/types";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import { toSearchableProject, type SearchableProjectContext } from "./ordering";
import type { SearchableProject, UseProjectSwitcherPaletteReturn } from "./types";

export type ProjectSwitcherProjectMutations = Pick<
  UseProjectSwitcherPaletteReturn,
  | "stopProject"
  | "removeProject"
  | "sleepProject"
  | "restartProject"
  | "locateProject"
  | "moveOrRenameProject"
  | "togglePinProject"
  | "copyPath"
  | "stopConfirmProjectId"
  | "setStopConfirmProjectId"
  | "confirmStopProject"
  | "isStoppingProject"
  | "removeConfirmProject"
  | "setRemoveConfirmProject"
  | "confirmRemoveProject"
  | "isRemovingProject"
  | "sleepConfirmProject"
  | "setSleepConfirmProject"
  | "confirmSleep"
  | "isSleepingProject"
>;

export interface UseProjectSwitcherProjectMutationsOptions {
  /** Closes the palette; every action that opens a dialog of its own runs it first. */
  close: () => void;
  projects: Project[];
  /** The stats map `searchableProjects` was built from — held while closed. */
  projectStats: ProjectStatusMap;
  searchableProjects: SearchableProject[];
  /** What `searchableProjects` was built against, minus the clock. */
  rowContext: Omit<SearchableProjectContext, "frecencyNow">;
  /** The clipboard write behind Copy path. */
  copyToClipboard: (text: string) => Promise<boolean>;
}

/**
 * The project row actions and their confirmations: stop, remove, sleep,
 * restart, pin, relocate and copy path.
 */
export function useProjectSwitcherProjectMutations({
  close,
  projects,
  projectStats,
  searchableProjects,
  rowContext,
  copyToClipboard,
}: UseProjectSwitcherProjectMutationsOptions): ProjectSwitcherProjectMutations {
  const [stopConfirmProjectId, setStopConfirmProjectId] = useState<string | null>(null);
  const [isStoppingProject, setIsStoppingProject] = useState(false);
  const [removeConfirmProject, setRemoveConfirmProject] = useState<SearchableProject | null>(null);
  const [isRemovingProject, setIsRemovingProject] = useState(false);
  const [sleepConfirmProject, setSleepConfirmProject] = useState<SearchableProject | null>(null);
  const [isSleepingProject, setIsSleepingProject] = useState(false);

  const loadProjects = useProjectStore((state) => state.loadProjects);
  const closeActiveProject = useProjectStore((state) => state.closeActiveProject);
  const sleepProjectAction = useProjectStore((state) => state.sleepProject);
  const closeProject = useProjectStore((state) => state.closeProject);
  const removeProject = useProjectStore((state) => state.removeProject);
  const openRelocation = useProjectRelocationStore((state) => state.open);

  useEffect(() => {
    if (!removeConfirmProject) return;
    const stillExists = searchableProjects.some((p) => p.id === removeConfirmProject.id);
    if (!stillExists) {
      setRemoveConfirmProject(null);
    }
  }, [removeConfirmProject, searchableProjects]);

  useEffect(() => {
    if (!sleepConfirmProject) return;
    const stillExists = searchableProjects.some((p) => p.id === sleepConfirmProject.id);
    if (!stillExists) {
      setSleepConfirmProject(null);
    }
  }, [sleepConfirmProject, searchableProjects]);

  // "Locate moved project" (missing) and "Move or rename project" (healthy) both
  // open the shared relocation dialog (#11282, phase 4), superseding the old
  // picker-then-mutate `project:locate` path. The palette closes first so its
  // overlay doesn't contend with the dialog's focus trap.
  const openRelocationDialog = useCallback(
    (projectId: string, mode: "move" | "reattach") => {
      const project = projects.find((p) => p.id === projectId);
      if (!project) return;
      close();
      openRelocation({ projectId, mode, oldPath: project.path, name: project.name });
    },
    [projects, close, openRelocation]
  );

  const locateProject = useCallback(
    (projectId: string) => openRelocationDialog(projectId, "reattach"),
    [openRelocationDialog]
  );

  const moveOrRenameProject = useCallback(
    (projectId: string) => openRelocationDialog(projectId, "move"),
    [openRelocationDialog]
  );

  const copyPath = useCallback(
    (path: string) => copyWithToast("Path", path, { write: copyToClipboard }),
    [copyToClipboard]
  );

  const togglePinProject = useCallback(
    async (projectId: string) => {
      const project = searchableProjects.find((p) => p.id === projectId);
      if (!project) return;
      const wantPinned = !project.isPinned;
      try {
        await projectClient.update(projectId, { pinned: wantPinned });
        await loadProjects();
      } catch (error) {
        const retry = async () => {
          try {
            await projectClient.update(projectId, { pinned: wantPinned });
            await loadProjects();
          } catch (retryError) {
            notify({
              type: "error",
              title: "Couldn't update project",
              message: formatErrorMessage(retryError, "Couldn't update project"),
              actions: [{ label: "Try again", variant: "primary", onClick: retry }],
            });
          }
        };
        notify({
          type: "error",
          title: "Couldn't update project",
          message: formatErrorMessage(error, "Couldn't update project"),
          actions: [{ label: "Try again", variant: "primary", onClick: retry }],
        });
      }
    },
    [searchableProjects, loadProjects]
  );

  const stopProject = useCallback(
    async (projectId: string) => {
      close();
      setStopConfirmProjectId(projectId);
    },
    [close]
  );

  const confirmStopProject = useCallback(async () => {
    if (!stopConfirmProjectId) return;
    setIsStoppingProject(true);

    const capturedId = stopConfirmProjectId;

    try {
      const isActive = useProjectStore.getState().currentProject?.id === capturedId;
      if (isActive) {
        await closeActiveProject(capturedId);
      } else {
        await closeProject(capturedId, { killTerminals: true });
      }
      setStopConfirmProjectId(null);
    } catch (error) {
      const retry = async () => {
        const isActive = useProjectStore.getState().currentProject?.id === capturedId;
        try {
          if (isActive) {
            await closeActiveProject(capturedId);
          } else {
            await closeProject(capturedId, { killTerminals: true });
          }
        } catch (retryError) {
          notify({
            type: "error",
            title: "Couldn't stop project",
            message: formatErrorMessage(retryError, "Couldn't stop project"),
            actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          });
        }
      };
      notify({
        type: "error",
        title: "Couldn't stop project",
        message: formatErrorMessage(error, "Couldn't stop project"),
        actions: [{ label: "Try again", variant: "primary", onClick: retry }],
      });
    } finally {
      setIsStoppingProject(false);
    }
  }, [stopConfirmProjectId, closeActiveProject, closeProject]);

  // The row as the store has it now. Sleep and remove are reachable from the
  // toolbar pill with the palette closed, where `searchableProjects` carries
  // held stats, and both confirms preview the counts they would stop.
  const findLiveProject = useCallback(
    (projectId: string): SearchableProject | undefined => {
      const stats = useProjectStatsStore.getState().stats;
      if (stats === projectStats) return searchableProjects.find((p) => p.id === projectId);
      const project = projects.find((p) => p.id === projectId);
      if (!project) return undefined;
      return toSearchableProject(project, stats[projectId], {
        ...rowContext,
        frecencyNow: Date.now(),
      });
    },
    [projectStats, searchableProjects, projects, rowContext]
  );

  const removeProjectFromList = useCallback(
    async (projectId: string) => {
      const project = findLiveProject(projectId);
      if (!project) return;

      if (removeConfirmProject) return;

      setRemoveConfirmProject(project);
    },
    [findLiveProject, removeConfirmProject]
  );

  const doSleepProject = useCallback(
    async (projectId: string) => {
      // Through the store, not projectClient: sleeping the ACTIVE project also
      // has to flush pending panel saves before the teardown and drop the window
      // to the no-project state after it.
      const run = () => sleepProjectAction(projectId);
      try {
        await run();
      } catch (error) {
        const retry = async () => {
          try {
            await run();
          } catch (retryError) {
            notify({
              type: "error",
              title: "Couldn't sleep project",
              message: formatErrorMessage(retryError, "Couldn't put the project to sleep"),
              actions: [{ label: "Try again", variant: "primary", onClick: retry }],
              context: { eventKind: "uiFeedback" },
            });
          }
        };
        notify({
          type: "error",
          title: "Couldn't sleep project",
          message: formatErrorMessage(error, "Couldn't put the project to sleep"),
          actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          context: { eventKind: "uiFeedback" },
        });
      }
    },
    [sleepProjectAction]
  );

  const sleepProject = useCallback(
    async (projectId: string) => {
      const project = findLiveProject(projectId);
      if (!project) return;

      close();

      const hasProcesses =
        project.processCount > 0 || project.activeAgentCount > 0 || project.waitingAgentCount > 0;

      // D1 (confirm) when live processes would be stopped, or when the target is
      // the project on screen here — that tears down what the user is looking
      // at. D0 (immediate) for a background project with nothing running to
      // interrupt. The snapshot freezes the counts the dialog previews.
      //
      // `isActive` only covers THIS window, and no cross-window signal is
      // available here: the persisted `status` is a singleton keyed to the
      // last-switched project, so "active" doesn't mean "open in some window".
      // A project open in ANOTHER window can therefore be slept without a
      // confirm — bounded harm, since nothing is running in that case and the
      // other window is told what happened (`useSleptProjectTransition`).
      if (hasProcesses || project.isActive) {
        setSleepConfirmProject(project);
      } else {
        await doSleepProject(projectId);
      }
    },
    [findLiveProject, close, doSleepProject]
  );

  const restartProject = useCallback(
    (projectId: string) => {
      close();
      void actionService.dispatch("project.restart", { projectId }, { source: "user" });
    },
    [close]
  );

  const confirmSleep = useCallback(async () => {
    if (!sleepConfirmProject || isSleepingProject) return;
    setIsSleepingProject(true);
    const capturedId = sleepConfirmProject.id;
    try {
      await doSleepProject(capturedId);
      setSleepConfirmProject(null);
    } finally {
      setIsSleepingProject(false);
    }
  }, [sleepConfirmProject, isSleepingProject, doSleepProject]);

  const confirmRemoveProject = useCallback(async () => {
    if (!removeConfirmProject || isRemovingProject) return;

    setIsRemovingProject(true);

    const capturedId = removeConfirmProject.id;

    try {
      if (removeConfirmProject.isActive) {
        await closeActiveProject(capturedId);
      } else {
        await removeProject(capturedId);
      }
      setRemoveConfirmProject(null);
    } catch (error) {
      const retry = async () => {
        const isActive = useProjectStore.getState().currentProject?.id === capturedId;
        try {
          if (isActive) {
            await closeActiveProject(capturedId);
          } else {
            await removeProject(capturedId);
          }
        } catch (retryError) {
          notify({
            type: "error",
            title: isActive ? "Couldn't close project" : "Couldn't remove project",
            message: formatErrorMessage(
              retryError,
              isActive ? "Couldn't close project" : "Couldn't remove project"
            ),
            actions: [{ label: "Try again", variant: "primary", onClick: retry }],
          });
        }
      };
      notify({
        type: "error",
        title: removeConfirmProject.isActive ? "Couldn't close project" : "Couldn't remove project",
        message: formatErrorMessage(
          error,
          removeConfirmProject.isActive ? "Couldn't close project" : "Couldn't remove project"
        ),
        actions: [{ label: "Try again", variant: "primary", onClick: retry }],
      });
    } finally {
      setIsRemovingProject(false);
    }
  }, [removeConfirmProject, isRemovingProject, closeActiveProject, removeProject]);

  return {
    stopProject,
    removeProject: removeProjectFromList,
    sleepProject,
    restartProject,
    locateProject,
    moveOrRenameProject,
    togglePinProject,
    copyPath,
    stopConfirmProjectId,
    setStopConfirmProjectId,
    confirmStopProject,
    isStoppingProject,
    removeConfirmProject,
    setRemoveConfirmProject,
    confirmRemoveProject,
    isRemovingProject,
    sleepConfirmProject,
    setSleepConfirmProject,
    confirmSleep,
    isSleepingProject,
  };
}
