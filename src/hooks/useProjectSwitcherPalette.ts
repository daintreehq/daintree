import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { rankProjectMatches } from "@/lib/projectSwitcherSearch";
import { useProjectStore } from "@/store/projectStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { usePaletteStore } from "@/store/paletteStore";
import { notify } from "@/lib/notify";
import type { Project } from "@shared/types";
import { projectClient } from "@/clients";

export type ProjectSwitcherMode = "modal" | "dropdown";

export interface SearchableProject {
  id: string;
  name: string;
  path: string;
  emoji: string;
  color?: string;
  lastOpened: number;
  status: Project["status"];
  isActive: boolean;
  isBackground: boolean;
  isMissing: boolean;
  isPinned: boolean;
  frecencyScore: number;
  activeAgentCount: number;
  waitingAgentCount: number;
  processCount: number;
  displayPath: string;
}

export interface UseProjectSwitcherPaletteReturn {
  isOpen: boolean;
  mode: ProjectSwitcherMode;
  query: string;
  results: SearchableProject[];
  selectedIndex: number;
  open: (mode?: ProjectSwitcherMode) => void;
  close: () => void;
  toggle: (mode?: ProjectSwitcherMode) => void;
  setQuery: (query: string) => void;
  selectPrevious: () => void;
  selectNext: () => void;
  selectProject: (project: SearchableProject) => void;
  confirmSelection: () => void;
  addProject: () => Promise<void>;
  cloneRepo: () => void;
  stopProject: (projectId: string) => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  locateProject: (projectId: string) => Promise<void>;
  togglePinProject: (projectId: string) => Promise<void>;
  stopConfirmProjectId: string | null;
  setStopConfirmProjectId: (projectId: string | null) => void;
  confirmStopProject: () => Promise<void>;
  isStoppingProject: boolean;
  removeConfirmProject: SearchableProject | null;
  setRemoveConfirmProject: (project: SearchableProject | null) => void;
  confirmRemoveProject: () => Promise<void>;
  isRemovingProject: boolean;
  backgroundWaitingCount: number;
}

const MAX_RESULTS = 15;

export function useProjectSwitcherPalette(): UseProjectSwitcherPaletteReturn {
  const modalIsOpen = usePaletteStore((state) => state.activePaletteId === "project-switcher");
  const [dropdownIsOpen, setDropdownIsOpen] = useState(false);
  const [mode, setMode] = useState<ProjectSwitcherMode>("modal");
  const isOpen = mode === "modal" ? modalIsOpen : dropdownIsOpen;
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [stopConfirmProjectId, setStopConfirmProjectId] = useState<string | null>(null);
  const [isStoppingProject, setIsStoppingProject] = useState(false);
  const [removeConfirmProject, setRemoveConfirmProject] = useState<SearchableProject | null>(null);
  const [isRemovingProject, setIsRemovingProject] = useState(false);
  const selectedProjectIdRef = useRef<string | null>(null);

  const projects = useProjectStore((state) => state.projects);
  const currentProject = useProjectStore((state) => state.currentProject);
  const switchProject = useProjectStore((state) => state.switchProject);
  const reopenProject = useProjectStore((state) => state.reopenProject);
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const addProjectFn = useProjectStore((state) => state.addProject);
  const closeProject = useProjectStore((state) => state.closeProject);
  const closeActiveProject = useProjectStore((state) => state.closeActiveProject);
  const removeProject = useProjectStore((state) => state.removeProject);
  const locateProjectFn = useProjectStore((state) => state.locateProject);
  const projectStats = useProjectStatsStore((state) => state.stats);

  useEffect(() => {
    if (!isOpen) return;
    void loadProjects();
  }, [isOpen, loadProjects]);

  const searchableProjects = useMemo<SearchableProject[]>(() => {
    return projects.map((p) => {
      const stats = projectStats[p.id];
      const isActive = p.id === currentProject?.id;
      const isMissing = p.status === "missing";
      const hasProcesses = (stats?.processCount ?? 0) > 0;
      const isBackground = p.status === "background" || (!isActive && !isMissing && hasProcesses);

      return {
        id: p.id,
        name: p.name,
        path: p.path,
        emoji: p.emoji || "🌲",
        color: p.color,
        lastOpened: p.lastOpened ?? 0,
        status: p.status,
        isActive,
        isBackground,
        isMissing,
        isPinned: p.pinned ?? false,
        frecencyScore: p.frecencyScore ?? 3.0,
        activeAgentCount: stats?.activeAgentCount ?? 0,
        waitingAgentCount: stats?.waitingAgentCount ?? 0,
        processCount: stats?.processCount ?? 0,
        displayPath: p.path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? p.path,
      };
    });
  }, [projects, projectStats, currentProject?.id]);

  const backgroundWaitingCount = useMemo(
    () =>
      searchableProjects
        .filter((p) => !p.isActive && p.isBackground && p.waitingAgentCount > 0)
        .reduce((sum, p) => sum + p.waitingAgentCount, 0),
    [searchableProjects]
  );

  const sortedProjects = useMemo<SearchableProject[]>(() => {
    return [...searchableProjects].sort((a, b) => {
      if (a.lastOpened !== b.lastOpened) {
        return b.lastOpened - a.lastOpened;
      }
      return a.name.localeCompare(b.name);
    });
  }, [searchableProjects]);

  const results = useMemo<SearchableProject[]>(() => {
    if (!query.trim()) {
      return sortedProjects.slice(0, MAX_RESULTS);
    }

    return rankProjectMatches(query, sortedProjects).slice(0, MAX_RESULTS);
  }, [query, sortedProjects]);

  useEffect(() => {
    if (results.length === 0) {
      selectedProjectIdRef.current = null;
      setSelectedIndex(0);
      return;
    }

    const selectedId = selectedProjectIdRef.current;
    if (selectedId) {
      const nextIndex = results.findIndex((project) => project.id === selectedId);
      if (nextIndex >= 0) {
        setSelectedIndex((prev) => (prev === nextIndex ? prev : nextIndex));
        return;
      }
    }

    setSelectedIndex((prev) => Math.min(prev, results.length - 1));
  }, [results]);

  useEffect(() => {
    if (results.length === 0) return;
    if (selectedIndex < 0 || selectedIndex >= results.length) return;
    selectedProjectIdRef.current = results[selectedIndex].id;
  }, [results, selectedIndex]);

  useEffect(() => {
    if (query) {
      selectedProjectIdRef.current = null;
      setSelectedIndex(0);
    }
  }, [query]);

  useEffect(() => {
    if (!removeConfirmProject) return;
    const stillExists = searchableProjects.some((p) => p.id === removeConfirmProject.id);
    if (!stillExists) {
      setRemoveConfirmProject(null);
    }
  }, [removeConfirmProject, searchableProjects]);

  const open = useCallback(
    (nextMode: ProjectSwitcherMode = "modal") => {
      setMode(nextMode);
      if (nextMode === "modal") {
        usePaletteStore.getState().openPalette("project-switcher");
      } else {
        setDropdownIsOpen(true);
      }
      setQuery("");
      selectedProjectIdRef.current = null;
      setSelectedIndex(searchableProjects.length >= 2 ? 1 : 0);
    },
    [searchableProjects.length]
  );

  const close = useCallback(() => {
    if (mode === "modal") {
      usePaletteStore.getState().closePalette("project-switcher");
    } else {
      setDropdownIsOpen(false);
    }
    setQuery("");
    setSelectedIndex(0);
  }, [mode]);

  const toggle = useCallback(
    (nextMode: ProjectSwitcherMode = "modal") => {
      const currentlyOpen = nextMode === "modal" ? modalIsOpen : dropdownIsOpen;
      if (currentlyOpen) {
        setSelectedIndex((prev) => {
          if (results.length <= 1) return prev;
          const next = prev + 1;
          return next >= results.length ? 0 : next;
        });
      } else {
        open(nextMode);
      }
    },
    [modalIsOpen, dropdownIsOpen, open, results]
  );

  const selectPrevious = useCallback(() => {
    if (results.length === 0) return;
    setSelectedIndex((prev) => (prev <= 0 ? results.length - 1 : prev - 1));
  }, [results.length]);

  const selectNext = useCallback(() => {
    if (results.length === 0) return;
    setSelectedIndex((prev) => (prev >= results.length - 1 ? 0 : prev + 1));
  }, [results.length]);

  const selectProject = useCallback(
    async (project: SearchableProject) => {
      if (project.isActive || project.isMissing) {
        return;
      }

      close();

      if (project.isBackground) {
        try {
          await reopenProject(project.id);
        } catch (error) {
          notify({
            type: "error",
            title: "Failed to reopen project",
            message: error instanceof Error ? error.message : "Unknown error",
            duration: 5000,
          });
        }
      } else {
        try {
          await switchProject(project.id);
        } catch (error) {
          notify({
            type: "error",
            title: "Failed to switch project",
            message: error instanceof Error ? error.message : "Unknown error",
            duration: 5000,
          });
        }
      }
    },
    [close, switchProject, reopenProject]
  );

  const confirmSelection = useCallback(() => {
    if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
      selectProject(results[selectedIndex]);
    }
  }, [results, selectedIndex, selectProject]);

  const addProject = useCallback(async () => {
    close();
    await addProjectFn();
  }, [close, addProjectFn]);

  const cloneRepo = useCallback(() => {
    close();
    useProjectStore.getState().openCloneRepoDialog();
  }, [close]);

  const locateProject = useCallback(
    async (projectId: string) => {
      await locateProjectFn(projectId);
    },
    [locateProjectFn]
  );

  const togglePinProject = useCallback(
    async (projectId: string) => {
      const project = searchableProjects.find((p) => p.id === projectId);
      if (!project) return;
      try {
        await projectClient.update(projectId, { pinned: !project.isPinned });
        await loadProjects();
      } catch (error) {
        notify({
          type: "error",
          title: "Failed to update project",
          message: error instanceof Error ? error.message : "Unknown error",
          duration: 5000,
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

    try {
      await closeProject(stopConfirmProjectId, { killTerminals: true });
      setStopConfirmProjectId(null);
    } catch (error) {
      notify({
        type: "error",
        title: "Failed to stop project",
        message: error instanceof Error ? error.message : "Unknown error",
        duration: 5000,
      });
    } finally {
      setIsStoppingProject(false);
    }
  }, [stopConfirmProjectId, closeProject]);

  const removeProjectFromList = useCallback(
    async (projectId: string) => {
      const project = searchableProjects.find((p) => p.id === projectId);
      if (!project) return;

      if (removeConfirmProject) return;

      setRemoveConfirmProject(project);
    },
    [searchableProjects, removeConfirmProject]
  );

  const confirmRemoveProject = useCallback(async () => {
    if (!removeConfirmProject || isRemovingProject) return;

    setIsRemovingProject(true);

    try {
      if (removeConfirmProject.isActive) {
        await closeActiveProject(removeConfirmProject.id);
      } else {
        await removeProject(removeConfirmProject.id);
      }
      setRemoveConfirmProject(null);
    } catch (error) {
      notify({
        type: "error",
        title: removeConfirmProject.isActive
          ? "Failed to close project"
          : "Failed to remove project",
        message: error instanceof Error ? error.message : "Unknown error",
        duration: 5000,
      });
    } finally {
      setIsRemovingProject(false);
    }
  }, [removeConfirmProject, isRemovingProject, closeActiveProject, removeProject]);

  return {
    isOpen,
    mode,
    query,
    results,
    selectedIndex,
    open,
    close,
    toggle,
    setQuery,
    selectPrevious,
    selectNext,
    selectProject,
    confirmSelection,
    addProject,
    cloneRepo,
    stopProject,
    removeProject: removeProjectFromList,
    locateProject,
    togglePinProject,
    stopConfirmProjectId,
    setStopConfirmProjectId,
    confirmStopProject,
    isStoppingProject,
    removeConfirmProject,
    setRemoveConfirmProject,
    confirmRemoveProject,
    isRemovingProject,
    backgroundWaitingCount,
  };
}
