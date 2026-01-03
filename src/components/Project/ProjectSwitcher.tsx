import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { ChevronsUpDown, Plus, Check, Circle, PlayCircle, StopCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { useProjectStore } from "@/store/projectStore";
import { useNotificationStore } from "@/store/notificationStore";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { projectClient } from "@/clients";
import type { Project, ProjectStats } from "@shared/types";

interface GroupedProjects {
  active: Project[];
  background: Project[];
  recent: Project[];
}

function groupProjects(
  projects: Project[],
  currentProjectId: string | null,
  projectStats: Map<string, ProjectStats>
): GroupedProjects {
  const groups: GroupedProjects = {
    active: [],
    background: [],
    recent: [],
  };

  // Debug logging (gated for performance)
  if (process.env.CANOPY_VERBOSE) {
    console.log("[ProjectSwitcher] groupProjects called:", {
      projectCount: projects.length,
      currentProjectId: currentProjectId?.slice(0, 8),
      statsCount: projectStats.size,
      projects: projects.map((p) => ({
        name: p.name,
        status: p.status,
        id: p.id.slice(0, 8),
      })),
    });
  }

  for (const project of projects) {
    // Treat project as active if it matches currentProjectId OR has status "active"
    // This handles race conditions where currentProject state is stale
    if (project.id === currentProjectId || project.status === "active") {
      groups.active.push(project);
    } else {
      const stats = projectStats.get(project.id);
      const hasProcesses = stats && stats.processCount > 0;
      const isBackground = project.status === "background";

      // Debug: log decision for each non-active project
      if (process.env.CANOPY_VERBOSE) {
        console.log(`[ProjectSwitcher] Grouping "${project.name}":`, {
          status: project.status,
          isBackground,
          hasProcesses,
          processCount: stats?.processCount ?? "no stats",
        });
      }

      // Projects with running processes or explicitly backgrounded
      if (hasProcesses || isBackground) {
        groups.background.push(project);
      } else {
        groups.recent.push(project);
      }
    }
  }

  // Sort background projects by process count (most active first)
  groups.background.sort((a, b) => {
    const statsA = projectStats.get(a.id);
    const statsB = projectStats.get(b.id);
    return (statsB?.processCount || 0) - (statsA?.processCount || 0);
  });

  // Sort recent projects by lastOpened (most recent first)
  groups.recent.sort((a, b) => b.lastOpened - a.lastOpened);

  if (process.env.CANOPY_VERBOSE) {
    console.log("[ProjectSwitcher] Grouping result:", {
      active: groups.active.map((p) => p.name),
      background: groups.background.map((p) => p.name),
      recent: groups.recent.map((p) => p.name),
    });
  }

  return groups;
}

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
  const [projectStats, setProjectStats] = useState<Map<string, ProjectStats>>(new Map());
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const switchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleProjectSwitch = (projectId: string) => {
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
  };

  const fetchProjectStats = useCallback(
    async (projectsToFetch: Project[]) => {
      setIsLoadingStats(true);
      const stats = new Map<string, ProjectStats>();

      try {
        const results = await Promise.allSettled(
          projectsToFetch.map((project) => projectClient.getStats(project.id))
        );

        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            stats.set(projectsToFetch[index].id, result.value);
            // Debug: log stats for each project
            if (process.env.CANOPY_VERBOSE) {
              console.log(
                `[ProjectSwitcher] Stats for "${projectsToFetch[index].name}":`,
                result.value
              );
            }
          } else {
            console.warn(
              `Failed to fetch stats for ${projectsToFetch[index].id}:`,
              result.reason
            );
          }
        });

        setProjectStats(stats);
      } finally {
        setIsLoadingStats(false);
      }
    },
    []
  );

  const handleCloseProject = async (
    projectId: string,
    e: React.MouseEvent,
    killTerminals: boolean = false
  ) => {
    e.stopPropagation(); // Prevent dropdown from closing

    const stats = projectStats.get(projectId);
    const project = projects.find((p) => p.id === projectId);

    if (killTerminals) {
      // Kill mode: confirm before killing processes
      const processCount = stats?.processCount ?? 0;

      if (processCount === 0) {
        addNotification({
          type: "info",
          title: "No processes running",
          message: "This project has no active processes to close",
          duration: 3000,
        });
        return;
      }

      const confirmed = window.confirm(
        `Stop "${project?.name}"?\n\n` +
          `This will terminate ${processCount} process(es):\n` +
          `- ${stats?.terminalCount ?? 0} terminal(s)\n\n` +
          `Terminals cannot be recovered after this.`
      );

      if (!confirmed) return;
    }

    try {
      const result = await closeProject(projectId, { killTerminals });

      if (killTerminals) {
        addNotification({
          type: "success",
          title: "Project stopped",
          message: `Terminated ${result.processesKilled} process(es)`,
          duration: 3000,
        });
      } else {
        addNotification({
          type: "info",
          title: "Project backgrounded",
          message: "Terminals are still running in the background",
          duration: 3000,
        });
      }

      // Refresh stats after close
      const updatedProjects = await projectClient.getAll();
      await fetchProjectStats(updatedProjects);
    } catch (error) {
      addNotification({
        type: "error",
        title: "Failed to close project",
        message: error instanceof Error ? error.message : "Unknown error",
        duration: 5000,
      });
    }
  };

  const handleReopenProject = async (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation();

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
  };

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
    if (!isOpen) return;

    let cancelled = false;
    let inFlight = false;

    const runFetch = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;

      try {
        // Refresh project list to get latest statuses, then fetch stats
        await loadProjects();
        const freshProjects = await projectClient.getAll();
        if (!cancelled && freshProjects.length > 0) {
          await fetchProjectStats(freshProjects);
        }
      } finally {
        inFlight = false;
      }
    };

    void runFetch(); // Initial fetch
    const interval = setInterval(() => void runFetch(), 10000); // Poll every 10s (reduced from 5s)

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isOpen, fetchProjectStats, loadProjects]);

  const renderIcon = (emoji: string, color?: string, sizeClass = "h-9 w-9 text-lg") => (
    <div
      className={cn(
        "flex items-center justify-center rounded-[var(--radius-xl)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] shrink-0 transition-all duration-200",
        sizeClass
      )}
      style={{
        background: `linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), ${getProjectGradient(color)}`,
      }}
    >
      <span className="leading-none select-none filter drop-shadow-sm">{emoji}</span>
    </div>
  );

  const groupedProjects = useMemo(
    () => groupProjects(projects, currentProject?.id || null, projectStats),
    [projects, currentProject?.id, projectStats]
  );

  const getStatsTooltip = (stats: ProjectStats | undefined) => {
    if (!stats || stats.processCount === 0) return "";
    const parts = [];
    parts.push(`${stats.terminalCount} terminal${stats.terminalCount !== 1 ? "s" : ""}`);
    parts.push(`~${stats.estimatedMemoryMB} MB`);
    return parts.join(", ");
  };

  const renderProjectItem = (project: Project, isActive: boolean) => {
    const stats = projectStats.get(project.id);
    const isRunning = stats && stats.processCount > 0;
    const isBackground = project.status === "background";

    return (
      <DropdownMenuItem
        key={project.id}
        onClick={(e) => {
          if (!isActive && !isLoading) {
            // Use reopen for background projects, switch for others
            if (isBackground) {
              handleReopenProject(project.id, e);
            } else {
              handleProjectSwitch(project.id);
            }
          }
        }}
        disabled={isLoading}
        className={cn(
          "gap-2 p-2 cursor-pointer mb-0.5 rounded-[var(--radius-md)] transition-colors",
          isActive && "bg-white/[0.03]"
        )}
      >
        <div className="w-3 flex items-center justify-center shrink-0">
          {isRunning && (
            <span title={getStatsTooltip(stats)} aria-label={`Running: ${getStatsTooltip(stats)}`}>
              <Circle className="h-2 w-2 fill-green-500 text-green-500" />
            </span>
          )}
        </div>

        {renderIcon(project.emoji || "🌲", project.color, "h-8 w-8 text-base")}

        <div className="flex flex-col min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "truncate text-sm font-medium",
                isActive ? "text-foreground" : "text-foreground/80"
              )}
            >
              {project.name}
            </span>
            {isBackground && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-muted/50 text-muted-foreground uppercase tracking-wider shrink-0">
                BG
              </span>
            )}
          </div>
          <span className="truncate text-[11px] font-mono text-muted-foreground/70">
            {project.path.split(/[/\\]/).pop()}
          </span>
        </div>

        {isActive && <Check className="h-4 w-4 text-canopy-accent ml-2 shrink-0" />}

        {/* Actions for non-active projects with background status or running processes */}
        {!isActive && (isRunning || isBackground) && (
          <div className="flex items-center gap-0.5 shrink-0">
            {isBackground && (
              <button
                type="button"
                onClick={(e) => handleReopenProject(project.id, e)}
                className="p-1 rounded hover:bg-canopy-accent/20 text-muted-foreground hover:text-canopy-accent transition-colors"
                title="Reopen project"
                aria-label="Reopen project"
              >
                <PlayCircle className="h-4 w-4" />
              </button>
            )}
            {/* Show stop button for background projects (have terminals by definition) or running stats */}
            {(isBackground || isRunning) && (
              <button
                type="button"
                onClick={(e) => handleCloseProject(project.id, e, true)}
                className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                title="Stop all terminals and close project"
                aria-label="Stop all terminals and close project"
              >
                <StopCircle className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </DropdownMenuItem>
    );
  };

  const renderGroupedProjects = () => {
    const sections: React.ReactNode[] = [];

    // Active Project Section
    if (groupedProjects.active.length > 0) {
      sections.push(
        <div key="active">
          <DropdownMenuLabel className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest px-2 py-1.5">
            Active
          </DropdownMenuLabel>
          {groupedProjects.active.map((project) => renderProjectItem(project, true))}
        </div>
      );
    }

    // Background Projects Section
    if (groupedProjects.background.length > 0) {
      sections.push(
        <div key="background">
          {sections.length > 0 && <DropdownMenuSeparator className="my-1 bg-border/40" />}
          <DropdownMenuLabel className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest px-2 py-1.5 flex items-center gap-2">
            <Circle
              className={cn(
                "h-2 w-2 fill-green-500 text-green-500",
                isLoadingStats && "animate-pulse"
              )}
            />
            Background ({groupedProjects.background.length})
          </DropdownMenuLabel>
          {groupedProjects.background.map((project) => renderProjectItem(project, false))}
        </div>
      );
    }

    // Recent Projects Section
    if (groupedProjects.recent.length > 0) {
      sections.push(
        <div key="recent">
          {sections.length > 0 && <DropdownMenuSeparator className="my-1 bg-border/40" />}
          <DropdownMenuLabel className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest px-2 py-1.5">
            Recent
          </DropdownMenuLabel>
          {groupedProjects.recent.map((project) => renderProjectItem(project, false))}
        </div>
      );
    }

    return sections;
  };

  if (!currentProject) {
    if (projects.length > 0) {
      return (
        <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="w-full justify-between text-muted-foreground border-dashed h-12 active:scale-100"
              disabled={isLoading}
            >
              <span>Select Project...</span>
              <ChevronsUpDown className="h-4 w-4 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64 max-h-[300px] overflow-y-auto p-1" align="start">
            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wider px-2 py-1.5">
              Projects
            </DropdownMenuLabel>

            {projects.map((project) => (
              <DropdownMenuItem
                key={project.id}
                onClick={() => handleProjectSwitch(project.id)}
                className="gap-3 p-2 group cursor-pointer"
              >
                {renderIcon(project.emoji || "🌲", project.color, "h-8 w-8 text-base")}
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="font-medium truncate">{project.name}</span>
                  <span className="text-[11px] font-mono text-muted-foreground truncate">
                    {project.path.split(/[/\\]/).pop()}
                  </span>
                </div>
              </DropdownMenuItem>
            ))}

            <DropdownMenuSeparator />

            <DropdownMenuItem
              onClick={addProject}
              className="gap-3 p-2 cursor-pointer text-muted-foreground focus:text-foreground"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20">
                <Plus className="h-4 w-4" />
              </div>
              <span className="font-medium">Add Project...</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    return (
      <Button
        variant="outline"
        className="w-full justify-start text-muted-foreground border-dashed h-12 active:scale-100"
        onClick={addProject}
        disabled={isLoading}
      >
        <Plus className="mr-2 h-4 w-4" />
        Open Project...
      </Button>
    );
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
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
        >
          <div className="flex items-center gap-3 text-left min-w-0">
            {renderIcon(currentProject.emoji || "🌲", currentProject.color, "h-9 w-9 text-xl")}

            <div className="flex flex-col min-w-0 gap-0.5">
              <span className="truncate font-semibold text-canopy-text text-sm leading-none">
                {currentProject.name}
              </span>
              <span className="truncate text-xs text-muted-foreground/60 font-mono">
                {currentProject.path.split(/[/\\]/).pop()}
              </span>
            </div>
          </div>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground/40 group-hover:text-muted-foreground/70 transition-colors" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="w-[260px] max-h-[60vh] overflow-y-auto p-1"
        align="start"
        sideOffset={8}
      >
        {renderGroupedProjects()}

        <DropdownMenuSeparator className="my-1 bg-border/40" />

        <DropdownMenuItem onClick={addProject} className="gap-3 p-2 cursor-pointer">
          <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
            <Plus className="h-4 w-4" />
          </div>
          <span className="font-medium text-sm text-muted-foreground">Add Project...</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
