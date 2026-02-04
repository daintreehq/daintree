import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { useProjectStore } from "@/store/projectStore";
import { useNotificationStore } from "@/store/notificationStore";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { projectClient, terminalClient } from "@/clients";
import type { ProjectStats } from "@shared/types";
import { isAgentTerminal } from "@/utils/terminalType";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { ProjectSwitcherPalette } from "./ProjectSwitcherPalette";
import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import Fuse, { type IFuseOptions } from "fuse.js";

interface ProjectTerminalCounts {
  activeAgentCount: number;
  waitingAgentCount: number;
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

export function ProjectSwitcher() {
  const {
    projects,
    currentProject,
    isLoading,
    loadProjects,
    getCurrentProject,
    switchProject,
    addProject,
    closeProject,
    reopenProject,
  } = useProjectStore();

  const { addNotification } = useNotificationStore();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [projectStats, setProjectStats] = useState<Map<string, ProjectStats>>(new Map());
  const [terminalCounts, setTerminalCounts] = useState<Map<string, ProjectTerminalCounts>>(
    new Map()
  );
  const [stopConfirmProjectId, setStopConfirmProjectId] = useState<string | null>(null);
  const [isStoppingProject, setIsStoppingProject] = useState(false);
  const switchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectSwitcherShortcut = useKeybindingDisplay("project.switcherPalette");

  // Debounce search query
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

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [debouncedQuery]);

  const refreshStopCandidateCounts = useCallback(
    async (projectId: string) => {
      const [statsResult, terminalsResult] = await Promise.allSettled([
        projectClient.getStats(projectId),
        terminalClient.getForProject(projectId),
      ]);

      if (statsResult.status === "fulfilled") {
        setProjectStats((prev) => {
          const next = new Map(prev);
          next.set(projectId, statsResult.value);
          return next;
        });
      }

      if (terminalsResult.status === "fulfilled") {
        let activeAgentCount = 0;
        let waitingAgentCount = 0;

        for (const terminal of terminalsResult.value) {
          if (terminal.hasPty === false) continue;

          const isAgent = isAgentTerminal(terminal.kind ?? terminal.type, terminal.agentId);
          if (!isAgent) continue;

          const agentState = terminal.agentState;

          if (agentState === "waiting") {
            waitingAgentCount += 1;
          } else if (agentState === "working" || agentState === "running") {
            activeAgentCount += 1;
          }
        }

        setTerminalCounts((prev) => {
          const next = new Map(prev);
          next.set(projectId, { activeAgentCount, waitingAgentCount });
          return next;
        });
      }
    },
    [setProjectStats, setTerminalCounts]
  );

  const handleProjectSwitch = useCallback(
    (projectId: string) => {
      if (switchTimeoutRef.current) {
        clearTimeout(switchTimeoutRef.current);
      }

      addNotification({
        type: "info",
        title: "Switching projects",
        message: "Resetting state for clean project isolation",
        duration: 1500,
      });

      switchTimeoutRef.current = setTimeout(() => {
        switchProject(projectId);
      }, 1500);
    },
    [addNotification, switchProject]
  );

  const fetchStats = useCallback(async () => {
    if (projects.length === 0) return;

    const currentProjects = projects;

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
      const newCounts = new Map<string, { activeAgentCount: number; waitingAgentCount: number }>();
      terminalsResults.value.forEach((result, index) => {
        if (result.status !== "fulfilled") return;

        let activeAgentCount = 0;
        let waitingAgentCount = 0;

        for (const terminal of result.value) {
          if (!panelKindHasPty(terminal.kind ?? "terminal")) continue;
          if (terminal.kind === "dev-preview") continue;
          if (terminal.hasPty === false) continue;

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
  }, [projects]);

  const handleStopProject = useCallback(
    (projectId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      setIsOpen(false);
      void refreshStopCandidateCounts(projectId);
      setStopConfirmProjectId(projectId);
    },
    [refreshStopCandidateCounts]
  );

  const confirmStopProject = async () => {
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

      await fetchStats();
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
  };

  const handleReopenProject = useCallback(
    async (projectId: string) => {
      addNotification({
        type: "info",
        title: "Reopening project",
        message: "Reconnecting to background terminals...",
        duration: 1500,
      });

      try {
        await reopenProject(projectId);
      } catch (error) {
        addNotification({
          type: "error",
          title: "Failed to reopen project",
          message: error instanceof Error ? error.message : "Unknown error",
          duration: 5000,
        });
      }
    },
    [addNotification, reopenProject]
  );

  useEffect(() => {
    loadProjects();
    getCurrentProject();

    const cleanup = projectClient.onSwitch(() => {
      getCurrentProject();
      loadProjects();
    });

    return () => {
      cleanup();
      if (switchTimeoutRef.current) {
        clearTimeout(switchTimeoutRef.current);
      }
    };
  }, [loadProjects, getCurrentProject]);

  // Refresh projects and fetch stats when dropdown opens
  useEffect(() => {
    if (isOpen) {
      loadProjects();
      fetchStats();
    }
  }, [isOpen, loadProjects, fetchStats]);

  // Poll for updates while open
  useEffect(() => {
    if (!isOpen) return;

    const interval = setInterval(() => {
      void fetchStats();
    }, 10000);

    return () => clearInterval(interval);
  }, [isOpen, fetchStats]);

  // Convert projects to searchable format
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
        status: p.status,
        isActive,
        isBackground,
        activeAgentCount: counts?.activeAgentCount ?? 0,
        waitingAgentCount: counts?.waitingAgentCount ?? 0,
        processCount: stats?.processCount ?? 0,
      };
    });
  }, [projects, projectStats, terminalCounts, currentProject?.id]);

  // Sort projects: active first, then background, then recent
  const sortedProjects = useMemo<SearchableProject[]>(() => {
    return [...searchableProjects].sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      if (a.isBackground && !b.isBackground) return -1;
      if (!a.isBackground && b.isBackground) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [searchableProjects]);

  // Fuzzy search
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

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    setQuery("");
    setSelectedIndex(0);
    setDebouncedQuery("");
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setSelectedIndex(0);
    setDebouncedQuery("");
  }, []);

  const selectPrevious = useCallback(() => {
    if (results.length === 0) return;
    setSelectedIndex((prev) => (prev <= 0 ? results.length - 1 : prev - 1));
  }, [results.length]);

  const selectNext = useCallback(() => {
    if (results.length === 0) return;
    setSelectedIndex((prev) => (prev >= results.length - 1 ? 0 : prev + 1));
  }, [results.length]);

  const handleSelectProject = useCallback(
    async (project: SearchableProject) => {
      if (project.isActive) {
        return;
      }

      handleClose();

      if (project.isBackground) {
        await handleReopenProject(project.id);
      } else {
        handleProjectSwitch(project.id);
      }
    },
    [handleClose, handleProjectSwitch, handleReopenProject]
  );

  const renderIcon = (emoji: string, color?: string, sizeClass = "h-9 w-9 text-lg") => (
    <div
      className={cn(
        "flex items-center justify-center rounded-[var(--radius-xl)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] shrink-0 transition-all duration-200",
        sizeClass
      )}
      style={{
        background: color
          ? `linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), ${getProjectGradient(color)}`
          : "linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), var(--color-canopy-sidebar)",
      }}
    >
      <span className="leading-none select-none filter drop-shadow-sm">{emoji}</span>
    </div>
  );

  const stopProject = stopConfirmProjectId
    ? projects.find((project) => project.id === stopConfirmProjectId)
    : null;
  const stopProjectStats = stopConfirmProjectId ? projectStats.get(stopConfirmProjectId) : null;
  const stopProjectCounts = stopConfirmProjectId ? terminalCounts.get(stopConfirmProjectId) : null;
  const stopAgentCount =
    (stopProjectCounts?.activeAgentCount ?? 0) + (stopProjectCounts?.waitingAgentCount ?? 0);
  const stopTerminalCount = stopProjectStats?.terminalCount ?? null;

  const stopDialog = (
    <ConfirmDialog
      isOpen={stopConfirmProjectId != null}
      onClose={() => {
        if (isStoppingProject) return;
        setStopConfirmProjectId(null);
      }}
      title={`Stop "${stopProject?.name ?? "this project"}"?`}
      description={
        <>
          <span className="block">
            This will terminate all running sessions in this project
            {stopTerminalCount != null
              ? ` (${stopTerminalCount} session${stopTerminalCount === 1 ? "" : "s"})`
              : ""}
            .
          </span>
          {stopAgentCount > 0 && (
            <span className="block mt-2">
              It will also stop {stopAgentCount} agent session{stopAgentCount === 1 ? "" : "s"}.
            </span>
          )}
          <span className="block mt-2">This can't be undone.</span>
        </>
      }
      confirmLabel="Stop project"
      cancelLabel="Cancel"
      onConfirm={confirmStopProject}
      isConfirmLoading={isStoppingProject}
      variant="destructive"
    />
  );

  if (!currentProject) {
    if (projects.length > 0) {
      return (
        <>
          {stopDialog}
          <ProjectSwitcherPalette
            mode="dropdown"
            isOpen={isOpen}
            query={query}
            results={results}
            selectedIndex={selectedIndex}
            onQueryChange={setQuery}
            onSelectPrevious={selectPrevious}
            onSelectNext={selectNext}
            onSelect={handleSelectProject}
            onClose={handleClose}
            onAddProject={addProject}
            onStopProject={handleStopProject}
          >
            <Button
              variant="outline"
              className="w-full justify-between text-muted-foreground border-dashed h-12 active:scale-100"
              disabled={isLoading}
              onClick={handleOpen}
            >
              <span>Select Project...</span>
              <ChevronsUpDown className="opacity-50" />
            </Button>
          </ProjectSwitcherPalette>
        </>
      );
    }

    return (
      <>
        {stopDialog}
        <Button
          variant="outline"
          className="w-full justify-start text-muted-foreground border-dashed h-12 active:scale-100"
          onClick={addProject}
          disabled={isLoading}
        >
          <Plus />
          Open Project...
        </Button>
      </>
    );
  }

  return (
    <>
      {stopDialog}
      <ProjectSwitcherPalette
        mode="dropdown"
        isOpen={isOpen}
        query={query}
        results={results}
        selectedIndex={selectedIndex}
        onQueryChange={setQuery}
        onSelectPrevious={selectPrevious}
        onSelectNext={selectNext}
        onSelect={handleSelectProject}
        onClose={handleClose}
        onAddProject={addProject}
        onStopProject={handleStopProject}
      >
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                className={cn(
                  "w-full justify-between h-12 px-2.5",
                  "rounded-[var(--radius-lg)]",
                  "border border-white/[0.06]",
                  "bg-white/[0.02] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
                  "hover:bg-white/[0.04] transition-colors",
                  "active:scale-100"
                )}
                disabled={isLoading}
                onClick={handleOpen}
              >
                <div className="flex items-center gap-3 text-left min-w-0">
                  {renderIcon(
                    currentProject.emoji || "🌲",
                    currentProject.color,
                    "h-9 w-9 text-xl"
                  )}

                  <div className="flex flex-col min-w-0 gap-0.5">
                    <span className="truncate font-semibold text-canopy-text text-sm leading-none">
                      {currentProject.name}
                    </span>
                    <span className="truncate text-xs text-muted-foreground/60 font-mono">
                      {currentProject.path.split(/[/\\]/).pop()}
                    </span>
                  </div>
                </div>
                <ChevronsUpDown className="shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              Switch project{projectSwitcherShortcut ? ` (${projectSwitcherShortcut})` : ""}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </ProjectSwitcherPalette>
    </>
  );
}
