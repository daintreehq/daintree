import { useCallback, useMemo } from "react";
import { ChevronsUpDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { useProjectStore } from "@/store/projectStore";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { useProjectSwitcherPalette } from "@/hooks";
import { actionService } from "@/services/ActionService";
import { notify } from "@/lib/notify";
import { ProjectSwitcherPalette } from "./ProjectSwitcherPalette";
import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";

const renderIcon = (emoji: string, color?: string, sizeClass = "h-9 w-9 text-lg") => (
  <div
    className={cn(
      "flex items-center justify-center rounded-[var(--radius-xl)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.18)] shrink-0 transition-all duration-200",
      sizeClass
    )}
    style={{
      background: color
        ? `linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), ${getProjectGradient(color)}`
        : "linear-gradient(to bottom, rgba(0,0,0,0.08), rgba(0,0,0,0.16)), var(--color-surface-panel)",
    }}
  >
    <span className="leading-none select-none filter drop-shadow-sm">{emoji}</span>
  </div>
);

export function ProjectSwitcher() {
  const projects = useProjectStore((state) => state.projects);
  const currentProject = useProjectStore((state) => state.currentProject);
  const isLoading = useProjectStore((state) => state.isLoading);
  const projectSwitcher = useProjectSwitcherPalette();
  const projectSwitcherShortcut = useKeybindingDisplay("project.switcherPalette");
  const isDropdownOpen = projectSwitcher.isOpen && projectSwitcher.mode === "dropdown";
  const handleDropdownClose = useCallback(() => {
    if (projectSwitcher.mode !== "dropdown") return;
    projectSwitcher.close();
  }, [projectSwitcher]);

  const openCreateFolderDialog = useProjectStore((state) => state.openCreateFolderDialog);

  const handleCreateFolder = useCallback(() => {
    projectSwitcher.close();
    openCreateFolderDialog();
  }, [projectSwitcher, openCreateFolderDialog]);

  const handleOpenSettings = useCallback(() => {
    projectSwitcher.close();
    void actionService.dispatch("project.settings.open", undefined, { source: "user" });
  }, [projectSwitcher]);

  const handleStopProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.stopProject(projectId);
    },
    [projectSwitcher]
  );

  const handleCloseProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.removeProject(projectId);
    },
    [projectSwitcher]
  );

  const handleLocateProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.locateProject(projectId);
    },
    [projectSwitcher]
  );

  const handleTogglePinProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.togglePinProject(projectId);
    },
    [projectSwitcher]
  );

  const handleCopyPath = useCallback((path: string) => {
    void navigator.clipboard.writeText(path);
    notify({ type: "info", title: "Path copied", message: path, duration: 2000 });
  }, []);

  const handleSelectBackground = useCallback(
    (project: SearchableProject) => {
      if (project.isActive || project.isMissing) return;
      projectSwitcher.close();
      notify({
        type: "info",
        title: "Background open",
        message: "Background open is not yet available — coming soon",
        duration: 3000,
      });
    },
    [projectSwitcher]
  );

  const handleSelectNewWindow = useCallback(
    (project: SearchableProject) => {
      if (project.isMissing) return;
      projectSwitcher.close();
      void actionService.dispatch(
        "app.newWindow",
        { projectPath: project.path },
        { source: "user" }
      );
    },
    [projectSwitcher]
  );

  const badgeStatus = useMemo(() => {
    const bgProjects = projectSwitcher.results.filter((p) => !p.isActive);
    const totalWaiting = bgProjects.reduce((sum, p) => sum + p.waitingAgentCount, 0);
    const totalActive = bgProjects.reduce((sum, p) => sum + p.activeAgentCount, 0);

    if (totalWaiting > 0) return { color: "bg-state-waiting", pulse: false, count: totalWaiting };
    if (totalActive > 0) return { color: "bg-canopy-accent", pulse: true, count: totalActive };
    return null;
  }, [projectSwitcher.results]);

  const stopDialog = (
    <ConfirmDialog
      isOpen={projectSwitcher.stopConfirmProjectId != null}
      onClose={() => {
        if (projectSwitcher.isStoppingProject) return;
        projectSwitcher.setStopConfirmProjectId(null);
      }}
      title="Stop project?"
      description="This will terminate all running sessions in this project. This can't be undone."
      confirmLabel="Stop project"
      cancelLabel="Cancel"
      onConfirm={projectSwitcher.confirmStopProject}
      isConfirmLoading={projectSwitcher.isStoppingProject}
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
            isOpen={isDropdownOpen}
            query={projectSwitcher.query}
            results={projectSwitcher.results}
            selectedIndex={projectSwitcher.selectedIndex}
            onQueryChange={projectSwitcher.setQuery}
            onSelectPrevious={projectSwitcher.selectPrevious}
            onSelectNext={projectSwitcher.selectNext}
            onSelect={projectSwitcher.selectProject}
            onClose={handleDropdownClose}
            onAddProject={projectSwitcher.addProject}
            onCreateFolder={handleCreateFolder}
            onStopProject={handleStopProject}
            onCloseProject={handleCloseProject}
            onLocateProject={handleLocateProject}
            onTogglePinProject={handleTogglePinProject}
            onCopyPath={handleCopyPath}
            onSelectBackground={handleSelectBackground}
            onSelectNewWindow={handleSelectNewWindow}
            removeConfirmProject={projectSwitcher.removeConfirmProject}
            onRemoveConfirmClose={() => projectSwitcher.setRemoveConfirmProject(null)}
            onConfirmRemove={projectSwitcher.confirmRemoveProject}
            isRemovingProject={projectSwitcher.isRemovingProject}
            onHoverProject={projectSwitcher.prefetchProject}
          >
            <Button
              variant="outline"
              className="w-full justify-between text-muted-foreground border-dashed h-12 active:scale-100"
              disabled={isLoading}
              onClick={() => projectSwitcher.open("dropdown")}
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
          onClick={() => void projectSwitcher.addProject()}
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
        isOpen={isDropdownOpen}
        query={projectSwitcher.query}
        results={projectSwitcher.results}
        selectedIndex={projectSwitcher.selectedIndex}
        onQueryChange={projectSwitcher.setQuery}
        onSelectPrevious={projectSwitcher.selectPrevious}
        onSelectNext={projectSwitcher.selectNext}
        onSelect={projectSwitcher.selectProject}
        onClose={handleDropdownClose}
        onAddProject={projectSwitcher.addProject}
        onCreateFolder={handleCreateFolder}
        onStopProject={handleStopProject}
        onCloseProject={handleCloseProject}
        onLocateProject={handleLocateProject}
        onTogglePinProject={handleTogglePinProject}
        onOpenProjectSettings={handleOpenSettings}
        onCopyPath={handleCopyPath}
        onSelectBackground={handleSelectBackground}
        removeConfirmProject={projectSwitcher.removeConfirmProject}
        onRemoveConfirmClose={() => projectSwitcher.setRemoveConfirmProject(null)}
        onConfirmRemove={projectSwitcher.confirmRemoveProject}
        isRemovingProject={projectSwitcher.isRemovingProject}
        groups={projectSwitcher.groups}
        onCreateGroup={projectSwitcher.createGroup}
        onAssignProjectToGroup={projectSwitcher.assignProjectToGroup}
        onRemoveProjectFromGroup={projectSwitcher.removeProjectFromGroup}
        onRenameGroup={projectSwitcher.renameGroup}
        onDeleteGroup={projectSwitcher.deleteGroup}
        onMoveGroupUp={projectSwitcher.moveGroupUp}
        onMoveGroupDown={projectSwitcher.moveGroupDown}
        onHoverProject={projectSwitcher.prefetchProject}
      >
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                className={cn(
                  "relative w-full justify-between h-12 px-2.5",
                  "rounded-[var(--radius-lg)]",
                  "border border-border-subtle",
                  "bg-surface-panel-elevated shadow-[inset_0_1px_0_var(--color-overlay-soft)]",
                  "hover:bg-surface-panel-elevated transition-colors",
                  "active:scale-100"
                )}
                disabled={isLoading}
                onClick={() => projectSwitcher.open("dropdown")}
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
                    <span className="truncate font-mono text-xs text-text-secondary">
                      {currentProject.path.split(/[/\\]/).pop()}
                    </span>
                  </div>
                </div>
                <ChevronsUpDown className="shrink-0 text-text-muted transition-colors group-hover:text-text-secondary" />
                {badgeStatus && (
                  <span
                    role="status"
                    aria-label={`${badgeStatus.count} background agent${badgeStatus.count === 1 ? "" : "s"} ${badgeStatus.pulse ? "working" : "waiting"}`}
                    className={cn(
                      "absolute top-1 right-1 h-2 w-2 rounded-full ring-2 ring-[var(--color-surface-panel-elevated)]",
                      badgeStatus.color,
                      badgeStatus.pulse && "animate-agent-pulse"
                    )}
                  />
                )}
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
