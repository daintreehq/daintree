import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import Fuse, { type IFuseOptions } from "fuse.js";
import { useProjectStore } from "@/store/projectStore";
import { useNotificationStore } from "@/store/notificationStore";
import type { Project, ProjectStats } from "@shared/types";
import { projectClient, terminalClient } from "@/clients";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isAgentTerminal } from "@/utils/terminalType";

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
  activeAgentCount: number;
  waitingAgentCount: number;
  processCount: number;
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
  stopProject: (projectId: string) => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  stopConfirmProjectId: string | null;
  setStopConfirmProjectId: (projectId: string | null) => void;
  confirmStopProject: () => Promise<void>;
  isStoppingProject: boolean;
}

const FUSE_OPTIONS: IFuseOptions<SearchableProject> = {
  keys: [
    { name: "name", weight: 2 },
    { name: "path", weight: 1 },
  ],
  threshold: 0.4,
  includeScore: true,
};

const MAX_RESULTS = 15;
const DEBOUNCE_MS = 150;

export function useProjectSwitcherPalette(): UseProjectSwitcherPaletteReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<ProjectSwitcherMode>("modal");
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [projectStats, setProjectStats] = useState<Map<string, ProjectStats>>(new Map());
  const [terminalCounts, setTerminalCounts] = useState<
    Map<string, { activeAgentCount: number; waitingAgentCount: number }>
  >(new Map());
  const [stopConfirmProjectId, setStopConfirmProjectId] = useState<string | null>(null);
  const [isStoppingProject, setIsStoppingProject] = useState(false);
  const selectedProjectIdRef = useRef<string | null>(null);
  const lastFetchRef = useRef(0);
  const lastFetchIdsRef = useRef<string>("");

  const projects = useProjectStore((state) => state.projects);
  const currentProject = useProjectStore((state) => state.currentProject);
  const switchProject = useProjectStore((state) => state.switchProject);
  const reopenProject = useProjectStore((state) => state.reopenProject);
  const loadProjects = useProjectStore((state) => state.loadProjects);
  const addProjectFn = useProjectStore((state) => state.addProject);
  const closeProject = useProjectStore((state) => state.closeProject);
  const removeProject = useProjectStore((state) => state.removeProject);
  const { addNotification } = useNotificationStore();

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      setDebouncedQuery(query);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  const fetchStats = useCallback(
    async (force = false) => {
      if (projects.length === 0) return;

      const currentProjects = projects;
      const projectIds = currentProjects.map((project) => project.id).join("|");
      const now = Date.now();

      if (!force) {
        if (now - lastFetchRef.current < 5000 && projectIds === lastFetchIdsRef.current) {
          return;
        }
      }

      lastFetchRef.current = now;
      lastFetchIdsRef.current = projectIds;

      const [statsResults, terminalsResults] = await Promise.allSettled([
        Promise.allSettled(currentProjects.map((p) => projectClient.getStats(p.id))),
        Promise.allSettled(currentProjects.map((p) => terminalClient.getForProject(p.id))),
      ]);

      if (statsResults.status === "fulfilled") {
        const newStats = new Map<string, ProjectStats>();
        statsResults.value.forEach((result, index) => {
          if (result.status === "fulfilled") {
            newStats.set(currentProjects[index].id, result.value);
          }
        });
        setProjectStats(newStats);
      }

      if (terminalsResults.status === "fulfilled") {
        const newCounts = new Map<
          string,
          { activeAgentCount: number; waitingAgentCount: number }
        >();
        terminalsResults.value.forEach((result, index) => {
          if (result.status !== "fulfilled") return;

          let activeAgentCount = 0;
          let waitingAgentCount = 0;

          for (const terminal of result.value) {
            if (!panelKindHasPty(terminal.kind ?? "terminal")) continue;
            if (terminal.kind === "dev-preview") continue;
            if (terminal.hasPty === false) continue; // Skip orphaned terminals without active PTY

            const isAgent = isAgentTerminal(terminal.kind ?? terminal.type, terminal.agentId);
            if (!isAgent) continue;

            if (terminal.agentState === "waiting") {
              waitingAgentCount += 1;
            } else if (terminal.agentState === "working" || terminal.agentState === "running") {
              activeAgentCount += 1;
            }
          }

          newCounts.set(currentProjects[index].id, { activeAgentCount, waitingAgentCount });
        });
        setTerminalCounts(newCounts);
      }
    },
    [projects]
  );

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    const runFetch = async () => {
      await loadProjects();
      if (cancelled) return;
      await fetchStats(true);
    };

    void runFetch();

    return () => {
      cancelled = true;
    };
  }, [isOpen, loadProjects, fetchStats]);

  useEffect(() => {
    if (isOpen && projects.length > 0) {
      void fetchStats();
    }
  }, [isOpen, projects, fetchStats]);

  const searchableProjects = useMemo<SearchableProject[]>(() => {
    return projects.map((p) => {
      const stats = projectStats.get(p.id);
      const counts = terminalCounts.get(p.id);
      const isActive = p.id === currentProject?.id;
      const hasProcesses = (stats?.processCount ?? 0) > 0;
      const isBackground = p.status === "background" || (!isActive && hasProcesses);

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
        activeAgentCount: counts?.activeAgentCount ?? 0,
        waitingAgentCount: counts?.waitingAgentCount ?? 0,
        processCount: stats?.processCount ?? 0,
      };
    });
  }, [projects, projectStats, terminalCounts, currentProject?.id]);

  const sortedProjects = useMemo<SearchableProject[]>(() => {
    return [...searchableProjects].sort((a, b) => {
      if (a.lastOpened !== b.lastOpened) {
        return b.lastOpened - a.lastOpened;
      }
      return a.name.localeCompare(b.name);
    });
  }, [searchableProjects]);

  const fuse = useMemo(() => {
    return new Fuse(sortedProjects, FUSE_OPTIONS);
  }, [sortedProjects]);

  const results = useMemo<SearchableProject[]>(() => {
    if (!debouncedQuery.trim()) {
      return sortedProjects.slice(0, MAX_RESULTS);
    }

    const fuseResults = fuse.search(debouncedQuery);
    return fuseResults.slice(0, MAX_RESULTS).map((r) => r.item);
  }, [debouncedQuery, sortedProjects, fuse]);

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
    selectedProjectIdRef.current = null;
    setSelectedIndex(0);
  }, [debouncedQuery]);

  const open = useCallback((nextMode: ProjectSwitcherMode = "modal") => {
    setMode(nextMode);
    setIsOpen(true);
    setQuery("");
    setSelectedIndex(0);
    setDebouncedQuery("");
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setSelectedIndex(0);
    setDebouncedQuery("");
  }, []);

  const toggle = useCallback(
    (nextMode: ProjectSwitcherMode = "modal") => {
      if (isOpen) {
        close();
      } else {
        open(nextMode);
      }
    },
    [isOpen, open, close]
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
      close();

      if (project.isActive) {
        return;
      }

      if (project.isBackground) {
        addNotification({
          type: "info",
          title: "Reopening project",
          message: "Reconnecting to background terminals...",
          duration: 1500,
        });
        try {
          await reopenProject(project.id);
        } catch (error) {
          addNotification({
            type: "error",
            title: "Failed to reopen project",
            message: error instanceof Error ? error.message : "Unknown error",
            duration: 5000,
          });
        }
      } else {
        addNotification({
          type: "info",
          title: "Switching projects",
          message: "Resetting state for clean project isolation",
          duration: 1500,
        });
        try {
          await switchProject(project.id);
        } catch (error) {
          addNotification({
            type: "error",
            title: "Failed to switch project",
            message: error instanceof Error ? error.message : "Unknown error",
            duration: 5000,
          });
        }
      }
    },
    [close, switchProject, reopenProject, addNotification]
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
      const result = await closeProject(stopConfirmProjectId, { killTerminals: true });

      setProjectStats((prev) => {
        const next = new Map(prev);
        next.set(stopConfirmProjectId, {
          processCount: 0,
          terminalCount: 0,
          estimatedMemoryMB: 0,
          terminalTypes: {},
          processIds: [],
        });
        return next;
      });
      setTerminalCounts((prev) => {
        const next = new Map(prev);
        next.set(stopConfirmProjectId, { activeAgentCount: 0, waitingAgentCount: 0 });
        return next;
      });

      addNotification({
        type: "success",
        title: "Project stopped",
        message: `Terminated ${result.processesKilled} process(es)`,
        duration: 3000,
      });

      setStopConfirmProjectId(null);
    } catch (error) {
      addNotification({
        type: "error",
        title: "Failed to stop project",
        message: error instanceof Error ? error.message : "Unknown error",
        duration: 5000,
      });
    } finally {
      setIsStoppingProject(false);
    }
  }, [stopConfirmProjectId, closeProject, addNotification]);

  const removeProjectFromList = useCallback(
    async (projectId: string) => {
      try {
        await removeProject(projectId);
      } catch (error) {
        addNotification({
          type: "error",
          title: "Failed to remove project",
          message: error instanceof Error ? error.message : "Unknown error",
          duration: 5000,
        });
      }
    },
    [removeProject, addNotification]
  );

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
    stopProject,
    removeProject: removeProjectFromList,
    stopConfirmProjectId,
    setStopConfirmProjectId,
    confirmStopProject,
    isStoppingProject,
  };
}
