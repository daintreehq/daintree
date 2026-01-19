import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { ChevronsUpDown, Plus, Circle, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { useProjectStore } from "@/store/projectStore";
import { useNotificationStore } from "@/store/notificationStore";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { projectClient, terminalClient } from "@/clients";
import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import type { Project, ProjectStats } from "@shared/types";
import { isAgentTerminal } from "@/utils/terminalType";
import { groupProjects } from "./projectGrouping";
import { ProjectActionRow } from "./ProjectActionRow";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";

interface ProjectTerminalCounts {
  activeAgentCount: number;
  waitingAgentCount: number;
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
  const [terminalCounts, setTerminalCounts] = useState<Map<string, ProjectTerminalCounts>>(
    new Map()
  );
  const [stopConfirmProjectId, setStopConfirmProjectId] = useState<string | null>(null);
  const [isStoppingProject, setIsStoppingProject] = useState(false);
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [isLoadingTerminalCounts, setIsLoadingTerminalCounts] = useState(false);
  const switchTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const projectSwitcherShortcut = useKeybindingDisplay("project.switcherPalette");

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
          if (!panelKindHasPty(terminal.kind ?? "terminal")) continue;
          if (terminal.kind === "dev-preview") continue;
          if (terminal.hasPty === false) continue; // Skip orphaned terminals without active PTY

          const agentState = terminal.agentState;
          const isAgent = isAgentTerminal(terminal.kind ?? terminal.type, terminal.agentId);
          if (!isAgent) continue;

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

  const fetchProjectStats = useCallback(async (projectsToFetch: Project[]) => {
    setIsLoadingStats(true);
    const stats = new Map<string, ProjectStats>();

    const isVerbose =
      typeof process !== "undefined" &&
      typeof process.env !== "undefined" &&
      Boolean(process.env.CANOPY_VERBOSE);

    try {
      const results = await Promise.allSettled(
        projectsToFetch.map((project) => projectClient.getStats(project.id))
      );

      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          stats.set(projectsToFetch[index].id, result.value);
          // Debug: log stats for each project
          if (isVerbose) {
            console.log(
              `[ProjectSwitcher] Stats for "${projectsToFetch[index].name}":`,
              result.value
            );
          }
        } else {
          console.warn(`Failed to fetch stats for ${projectsToFetch[index].id}:`, result.reason);
        }
      });

      setProjectStats(stats);
    } finally {
      setIsLoadingStats(false);
    }
  }, []);

  const fetchProjectTerminalCounts = useCallback(async (projectsToFetch: Project[]) => {
    setIsLoadingTerminalCounts(true);
    const nextCounts = new Map<string, ProjectTerminalCounts>();

    try {
      const results = await Promise.allSettled(
        projectsToFetch.map((project) => terminalClient.getForProject(project.id))
      );

      results.forEach((result, index) => {
        if (result.status !== "fulfilled") {
          console.warn(
            `Failed to fetch terminals for ${projectsToFetch[index].id}:`,
            result.reason
          );
          return;
        }

        let activeAgentCount = 0;
        let waitingAgentCount = 0;

        for (const terminal of result.value) {
          if (!panelKindHasPty(terminal.kind ?? "terminal")) continue;
          if (terminal.kind === "dev-preview") continue;
          if (terminal.hasPty === false) continue; // Skip orphaned terminals without active PTY

          const agentState = terminal.agentState;
          const isAgent = isAgentTerminal(terminal.kind ?? terminal.type, terminal.agentId);

          if (!isAgent) continue;

          if (agentState === "waiting") {
            waitingAgentCount += 1;
          } else if (agentState === "working" || agentState === "running") {
            activeAgentCount += 1;
          }
        }

        nextCounts.set(projectsToFetch[index].id, {
          activeAgentCount,
          waitingAgentCount,
        });
      });

      setTerminalCounts(nextCounts);
    } finally {
      setIsLoadingTerminalCounts(false);
    }
  }, []);

  const handleCloseProject = async (
    projectId: string,
    e: React.MouseEvent,
    killTerminals: boolean = false
  ) => {
    e.stopPropagation();
    e.preventDefault();

    if (killTerminals) {
      setIsOpen(false);
      void refreshStopCandidateCounts(projectId);
      setStopConfirmProjectId(projectId);
      return;
    }

    try {
      const result = await closeProject(projectId, { killTerminals });

      if (killTerminals) {
        setProjectStats((prev) => {
          const next = new Map(prev);
          next.set(projectId, {
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
          next.set(projectId, { activeAgentCount: 0, waitingAgentCount: 0 });
          return next;
        });

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
      await Promise.all([
        fetchProjectStats(updatedProjects),
        fetchProjectTerminalCounts(updatedProjects),
      ]);
    } catch (error) {
      addNotification({
        type: "error",
        title: "Failed to close project",
        message: error instanceof Error ? error.message : "Unknown error",
        duration: 5000,
      });
    }
  };

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

      const updatedProjects = await projectClient.getAll();
      await Promise.all([
        fetchProjectStats(updatedProjects),
        fetchProjectTerminalCounts(updatedProjects),
      ]);
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
          await Promise.all([
            fetchProjectStats(freshProjects),
            fetchProjectTerminalCounts(freshProjects),
          ]);
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
  }, [isOpen, fetchProjectStats, fetchProjectTerminalCounts, loadProjects]);

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

  const renderProjectItem = (project: Project, isActive: boolean) => {
    const stats = projectStats.get(project.id);
    const isBackground = project.status === "background";
    const counts = terminalCounts.get(project.id);
    const activeAgentCount = counts ? counts.activeAgentCount : null;
    const waitingAgentCount = counts ? counts.waitingAgentCount : null;
    const showStop = (stats?.processCount ?? 0) > 0;

    return (
      <DropdownMenuItem
        key={project.id}
        onClick={(e) => {
          if (isLoading) return;
          if (isActive && currentProject) return;

          if (isBackground) {
            handleReopenProject(project.id, e);
          } else {
            handleProjectSwitch(project.id);
          }
        }}
        disabled={isLoading}
        className={cn(
          "p-2 cursor-pointer mb-1 rounded-[var(--radius-lg)] transition-colors",
          isActive ? "bg-white/[0.04]" : "hover:bg-white/[0.03]"
        )}
      >
        <div className="flex items-center gap-3 w-full min-w-0">
          {renderIcon(project.emoji || "🌲", project.color, "h-8 w-8 text-base")}

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={cn(
                  "truncate text-sm font-semibold leading-tight",
                  isActive ? "text-foreground" : "text-foreground/85"
                )}
              >
                {project.name}
              </span>

              <div className="ml-auto flex items-center gap-1.5 shrink-0">
                <ProjectActionRow
                  activeAgentCount={activeAgentCount}
                  waitingAgentCount={waitingAgentCount}
                />

                {showStop && (
                  <button
                    type="button"
                    onClick={(e) => void handleCloseProject(project.id, e, true)}
                    className={cn(
                      "p-0.5 rounded transition-colors cursor-pointer",
                      "text-[var(--color-status-error)] hover:bg-red-500/10",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                    )}
                    title={`Stop project (${stats?.terminalCount ?? 0} session${(stats?.terminalCount ?? 0) === 1 ? "" : "s"})`}
                    aria-label={`Stop project (${stats?.terminalCount ?? 0} session${(stats?.terminalCount ?? 0) === 1 ? "" : "s"})`}
                  >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center min-w-0 mt-0.5">
              <span className="truncate text-[11px] leading-none font-mono text-muted-foreground/65">
                {project.path.split(/[/\\]/).pop()}
              </span>
            </div>
          </div>
        </div>
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
                (isLoadingStats || isLoadingTerminalCounts) && "animate-pulse"
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
          <span className="block mt-2">This can’t be undone.</span>
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
          <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                className="w-full justify-between text-muted-foreground border-dashed h-12 active:scale-100"
                disabled={isLoading}
              >
                <span>Select Project...</span>
                <ChevronsUpDown className="opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-[484px] max-w-[calc(100vw-2rem)] max-h-[60vh] overflow-y-auto p-2"
              align="start"
            >
              {renderGroupedProjects()}

              <DropdownMenuSeparator className="my-1 bg-border/40" />

              <DropdownMenuItem onClick={addProject} className="gap-3 p-2 cursor-pointer">
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20">
                  <Plus className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">Add Project...</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
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
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">
              Switch project{projectSwitcherShortcut ? ` (${projectSwitcherShortcut})` : ""}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <DropdownMenuContent
          className="w-[484px] max-w-[calc(100vw-2rem)] max-h-[60vh] overflow-y-auto p-2"
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
    </>
  );
}
