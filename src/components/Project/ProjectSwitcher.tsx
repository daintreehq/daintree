import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { ChevronsUpDown, Plus, Check, XCircle, Circle } from "lucide-react";
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
  running: Project[];
  recent: Project[];
}

function groupProjects(
  projects: Project[],
  currentProjectId: string | null,
  projectStats: Map<string, ProjectStats>
): GroupedProjects {
  const groups: GroupedProjects = {
    active: [],
    running: [],
    recent: [],
  };

  for (const project of projects) {
    if (project.id === currentProjectId) {
      groups.active.push(project);
    } else {
      const stats = projectStats.get(project.id);
      const hasProcesses = stats && stats.processCount > 0;

      if (hasProcesses) {
        groups.running.push(project);
      } else {
        groups.recent.push(project);
      }
    }
  }

  // Sort running projects by process count (most active first)
  groups.running.sort((a, b) => {
    const statsA = projectStats.get(a.id);
    const statsB = projectStats.get(b.id);
    return (statsB?.processCount || 0) - (statsA?.processCount || 0);
  });

  // Sort recent projects by lastOpened (most recent first)
  groups.recent.sort((a, b) => b.lastOpened - a.lastOpened);

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
  } = useProjectStore();

  const { addNotification } = useNotificationStore();
  const [isOpen, setIsOpen] = useState(false);
  const [projectStats, setProjectStats] = useState<Map<string, ProjectStats>>(new Map());
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

  const fetchProjectStats = useCallback(async () => {
    const stats = new Map<string, ProjectStats>();
    const results = await Promise.allSettled(
      projects.map((project) => projectClient.getStats(project.id))
    );

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        stats.set(projects[index].id, result.value);
      } else {
        console.warn(`Failed to fetch stats for ${projects[index].id}:`, result.reason);
      }
    });

    setProjectStats(stats);
  }, [projects]);

  const handleCloseProject = async (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent dropdown from closing

    const stats = projectStats.get(projectId);

    const project = projects.find((p) => p.id === projectId);

    // Handle case where stats are unavailable
    if (!stats) {
      const confirmed = window.confirm(
        `Close "${project?.name}"?\n\n` +
          `Process stats unavailable. This will close any running processes for this project.`
      );

      if (!confirmed) return;
    } else {
      const processCount = stats.processCount;

      if (processCount === 0) {
        addNotification({
          type: "info",
          title: "No processes running",
          message: "This project has no active processes",
          duration: 3000,
        });
        return;
      }

      const confirmed = window.confirm(
        `Close "${project?.name}"?\n\n` +
          `This will close ${processCount} process(es):\n` +
          `- ${stats.terminalCount} terminal(s)`
      );

      if (!confirmed) return;
    }

    try {
      const result = await closeProject(projectId);
      addNotification({
        type: "success",
        title: "Project closed",
        message: `Ended ${result.processesKilled} process(es)`,
        duration: 3000,
      });
      // Refresh stats after close
      await fetchProjectStats();
    } catch (error) {
      addNotification({
        type: "error",
        title: "Failed to close project",
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

  // Poll for project stats when dropdown is open
  useEffect(() => {
    if (!isOpen || projects.length === 0) return;

    let cancelled = false;

    const runFetch = async () => {
      if (cancelled) return;
      await fetchProjectStats();
    };

    void runFetch(); // Initial fetch
    const interval = setInterval(() => void runFetch(), 5000); // Poll every 5s

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isOpen, projects, fetchProjectStats]);

  const renderIcon = (emoji: string, color?: string, sizeClass = "h-8 w-8 text-lg") => (
    <div
      className={cn(
        "flex items-center justify-center rounded-[var(--radius-xl)] shadow-inner shrink-0 transition-all duration-200",
        "bg-white/5",
        sizeClass
      )}
      style={{
        background: getProjectGradient(color),
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

    return (
      <DropdownMenuItem
        key={project.id}
        onClick={() => {
          if (!isActive && !isLoading) {
            handleProjectSwitch(project.id);
          }
        }}
        disabled={isLoading}
        className={cn(
          "gap-2 p-2 cursor-pointer mb-0.5 rounded-[var(--radius-md)] transition-colors",
          isActive ? "bg-accent/50" : "focus:bg-accent/30"
        )}
      >
        <div className="w-3 flex items-center justify-center shrink-0">
          {isRunning && (
            <span title={getStatsTooltip(stats)}>
              <Circle className="h-2 w-2 fill-green-500 text-green-500" />
            </span>
          )}
        </div>

        {renderIcon(project.emoji || "🌲", project.color, "h-8 w-8 text-base")}

        <div className="flex flex-col min-w-0 flex-1">
          <span
            className={cn(
              "truncate text-sm font-medium",
              isActive ? "text-foreground" : "text-foreground/80"
            )}
          >
            {project.name}
          </span>
          <span className="truncate text-[11px] font-mono text-muted-foreground/70">
            {project.path.split(/[/\\]/).pop()}
          </span>
        </div>

        {isActive && <Check className="h-4 w-4 text-canopy-accent ml-2 shrink-0" />}

        {!isActive && isRunning && (
          <button
            onClick={(e) => handleCloseProject(project.id, e)}
            className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors shrink-0"
            title="Close project and end processes"
          >
            <XCircle className="h-4 w-4" />
          </button>
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

    // Running Projects Section
    if (groupedProjects.running.length > 0) {
      sections.push(
        <div key="running">
          {sections.length > 0 && <DropdownMenuSeparator className="my-1 bg-border/40" />}
          <DropdownMenuLabel className="text-[11px] font-semibold text-muted-foreground/50 uppercase tracking-widest px-2 py-1.5 flex items-center gap-2">
            <Circle className="h-2 w-2 fill-green-500 text-green-500" />
            Running ({groupedProjects.running.length})
          </DropdownMenuLabel>
          {groupedProjects.running.map((project) => renderProjectItem(project, false))}
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
        <div className="p-2">
          <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="w-full justify-between text-muted-foreground border-dashed active:scale-100"
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
                  className="gap-3 p-2 group cursor-pointer focus:bg-canopy-accent/10"
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
        </div>
      );
    }

    return (
      <div className="p-2">
        <Button
          variant="outline"
          className="w-full justify-start text-muted-foreground border-dashed h-10 active:scale-100"
          onClick={addProject}
          disabled={isLoading}
        >
          <Plus className="mr-2 h-4 w-4" />
          Open Project...
        </Button>
      </div>
    );
  }

  return (
    <div className="p-2">
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="w-full justify-between px-2 h-14 hover:bg-canopy-bg/50 group transition-all duration-200 active:scale-100"
            disabled={isLoading}
          >
            <div className="flex items-center gap-3 text-left min-w-0">
              {renderIcon(currentProject.emoji || "🌲", currentProject.color, "h-10 w-10 text-2xl")}

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

          <DropdownMenuItem
            onClick={addProject}
            className="gap-3 p-2 cursor-pointer focus:bg-accent/30"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
              <Plus className="h-4 w-4" />
            </div>
            <span className="font-medium text-sm text-muted-foreground">Add Project...</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
