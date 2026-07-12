import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronsUpDown, FileText, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { useProjectStore } from "@/store/projectStore";
import { useScratchStore } from "@/store/scratchStore";
import { activeWorkspaceIdentity } from "@/lib/workspaceIdentity";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/Spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { useProjectSwitcherPalette, useDohertyGate } from "@/hooks";
import { actionService } from "@/services/ActionService";
import { ProjectSwitcherPalette } from "./ProjectSwitcherPalette";
import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";

const renderIcon = (emoji: string, color?: string, sizeClass = "h-9 w-9 text-lg") => (
  <div
    className={cn(
      // Wash/shadow var fallbacks keep themes without the overrides byte-identical.
      "flex items-center justify-center rounded-[var(--radius-xl)] shadow-[var(--project-tile-shadow,inset_0_1px_2px_rgba(0,0,0,0.3))] shrink-0 transition duration-150",
      sizeClass
    )}
    style={{
      background: color
        ? `var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), ${getProjectGradient(color)}`
        : "var(--project-tile-wash, linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2))), var(--color-surface-panel)",
    }}
  >
    <span className="leading-none select-none filter drop-shadow-sm">{emoji}</span>
  </div>
);

export function ProjectSwitcher() {
  const projects = useProjectStore((state) => state.projects);
  const currentProject = useProjectStore((state) => state.currentProject);
  const currentScratch = useScratchStore((state) => state.currentScratch);
  const workspaceIdentity = activeWorkspaceIdentity(currentProject, currentScratch);
  const isLoading = useProjectStore((state) => state.isLoading);
  const showLoadingSpinner = useDohertyGate(isLoading);
  const projectSwitcher = useProjectSwitcherPalette();
  const projectSwitcherShortcut = useKeybindingDisplay("project.switcherPalette");
  const isDropdownOpen = projectSwitcher.isOpen && projectSwitcher.mode === "dropdown";
  const handleDropdownClose = useCallback(() => {
    if (projectSwitcher.mode !== "dropdown") return;
    projectSwitcher.close();
  }, [projectSwitcher]);

  // Radix Tooltip reopens when the palette closes and Popover restores focus to
  // this trigger — leaving a stale tooltip floating in the backgrounded view
  // after a project switch (most visible when switching back to it). Gate the
  // tooltip on controlled state and hold it suppressed through the palette's
  // focus restoration until the next genuine pointer hover. Same pattern as
  // AgentButton.
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const isRestoringFocusRef = useRef(false);

  const handleTooltipOpenChange = useCallback((open: boolean) => {
    if (open && isRestoringFocusRef.current) return;
    setTooltipOpen(open);
  }, []);

  const suppressTooltipDuringFocusRestore = useCallback(() => {
    setTooltipOpen(false);
    isRestoringFocusRef.current = true;
  }, []);

  const handleOpenDropdown = useCallback(() => {
    setTooltipOpen(false);
    projectSwitcher.open("dropdown");
  }, [projectSwitcher]);

  const openCreateFolderDialog = useProjectStore((state) => state.openCreateFolderDialog);

  const handleCreateFolder = useCallback(() => {
    projectSwitcher.close();
    openCreateFolderDialog();
  }, [projectSwitcher, openCreateFolderDialog]);

  const handleCloneRepo = useCallback(() => {
    projectSwitcher.cloneRepo();
  }, [projectSwitcher]);

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

  const handleFreeMemoryProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.freeMemoryProject(projectId);
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

  // Reads the uncapped, unscoped agent totals rather than `results` — that
  // array is scoped for presentation (modal browse drops projects whose
  // process count hasn't landed yet), which would blink the badge off.
  const badgeStatus = useMemo(() => {
    const { activeAgentCount, waitingAgentCount } = projectSwitcher.nonActiveAgentCounts;

    if (waitingAgentCount > 0) {
      return { color: "bg-state-waiting", pulse: false, count: waitingAgentCount };
    }
    if (activeAgentCount > 0) {
      return { color: "bg-activity-active", pulse: true, count: activeAgentCount };
    }
    return null;
  }, [projectSwitcher.nonActiveAgentCounts]);

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

  if (!currentProject && !currentScratch) {
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
            onCloneRepo={handleCloneRepo}
            onCreateFolder={handleCreateFolder}
            onStopProject={handleStopProject}
            onCloseProject={handleCloseProject}
            onFreeMemoryProject={handleFreeMemoryProject}
            onLocateProject={handleLocateProject}
            onTogglePinProject={handleTogglePinProject}
            onCopyPath={projectSwitcher.copyPath}
            onSelectNewWindow={handleSelectNewWindow}
            onHoverProject={projectSwitcher.onHoverProject}
            onHoverProjectEnd={projectSwitcher.onHoverProjectEnd}
            removeConfirmProject={projectSwitcher.removeConfirmProject}
            onRemoveConfirmClose={() => projectSwitcher.setRemoveConfirmProject(null)}
            onConfirmRemove={projectSwitcher.confirmRemoveProject}
            isRemovingProject={projectSwitcher.isRemovingProject}
            freeMemoryConfirmProject={projectSwitcher.freeMemoryConfirmProject}
            onFreeMemoryConfirmClose={() => projectSwitcher.setFreeMemoryConfirmProject(null)}
            onConfirmFreeMemory={projectSwitcher.confirmFreeMemory}
            isFreeingMemory={projectSwitcher.isFreeingMemory}
            scratchResults={projectSwitcher.scratchResults}
            onCreateScratch={(name) => void projectSwitcher.createScratch(name)}
            onSelectScratch={(scratch) => void projectSwitcher.selectScratch(scratch)}
            onRemoveScratch={(scratchId) => void projectSwitcher.removeScratchAction(scratchId)}
            onRenameScratch={(scratchId, name) =>
              void projectSwitcher.renameScratch(scratchId, name)
            }
          >
            <Button
              variant="outline"
              className="w-full justify-between text-muted-foreground border-dashed h-12 active:scale-100"
              disabled={showLoadingSpinner}
              onClick={() => projectSwitcher.open("dropdown")}
            >
              <span>Select Project...</span>
              {showLoadingSpinner ? (
                <Spinner size="md" className="shrink-0" />
              ) : (
                <ChevronsUpDown className="text-text-muted" />
              )}
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
        onCloneRepo={handleCloneRepo}
        onCreateFolder={handleCreateFolder}
        onStopProject={handleStopProject}
        onCloseProject={handleCloseProject}
        onFreeMemoryProject={handleFreeMemoryProject}
        onLocateProject={handleLocateProject}
        onTogglePinProject={handleTogglePinProject}
        onOpenProjectSettings={currentProject ? handleOpenSettings : undefined}
        onCopyPath={projectSwitcher.copyPath}
        onHoverProject={projectSwitcher.onHoverProject}
        onHoverProjectEnd={projectSwitcher.onHoverProjectEnd}
        removeConfirmProject={projectSwitcher.removeConfirmProject}
        onRemoveConfirmClose={() => projectSwitcher.setRemoveConfirmProject(null)}
        onConfirmRemove={projectSwitcher.confirmRemoveProject}
        isRemovingProject={projectSwitcher.isRemovingProject}
        freeMemoryConfirmProject={projectSwitcher.freeMemoryConfirmProject}
        onFreeMemoryConfirmClose={() => projectSwitcher.setFreeMemoryConfirmProject(null)}
        onConfirmFreeMemory={projectSwitcher.confirmFreeMemory}
        isFreeingMemory={projectSwitcher.isFreeingMemory}
        scratchResults={projectSwitcher.scratchResults}
        onCreateScratch={(name) => void projectSwitcher.createScratch(name)}
        onSelectScratch={(scratch) => void projectSwitcher.selectScratch(scratch)}
        onRemoveScratch={(scratchId) => void projectSwitcher.removeScratchAction(scratchId)}
        onRenameScratch={(scratchId, name) => void projectSwitcher.renameScratch(scratchId, name)}
        onDropdownCloseAutoFocus={suppressTooltipDuringFocusRestore}
      >
        <Tooltip open={tooltipOpen} onOpenChange={handleTooltipOpenChange}>
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
              disabled={showLoadingSpinner}
              aria-label={workspaceIdentity.ariaLabel}
              onClick={handleOpenDropdown}
              onPointerEnter={() => {
                isRestoringFocusRef.current = false;
              }}
            >
              <div className="flex items-center gap-3 text-left min-w-0">
                {currentProject ? (
                  renderIcon(currentProject.emoji || "🌲", currentProject.color, "h-9 w-9 text-xl")
                ) : (
                  <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-xl)] bg-tint/[0.04] text-muted-foreground shrink-0">
                    <FileText className="h-4 w-4" />
                  </div>
                )}

                <div className="flex flex-col min-w-0 gap-0.5">
                  <span className="truncate font-semibold text-daintree-text text-sm leading-none">
                    {workspaceIdentity.name}
                  </span>
                  <span
                    className={cn(
                      "truncate text-xs text-text-secondary",
                      currentProject && "font-mono"
                    )}
                  >
                    {currentProject
                      ? currentProject.path.split(/[/\\]/).pop()
                      : "Scratch workspace"}
                  </span>
                </div>
              </div>
              {showLoadingSpinner ? (
                <Spinner size="md" className="shrink-0 text-text-muted" />
              ) : (
                <ChevronsUpDown className="shrink-0 text-text-muted transition-colors group-hover:text-text-secondary" />
              )}
              {badgeStatus && (
                <span
                  role="status"
                  aria-label={`${badgeStatus.count} background agent${badgeStatus.count === 1 ? "" : "s"} ${badgeStatus.pulse ? "working" : "waiting"}`}
                  className={cn(
                    "absolute top-1 right-1 h-2 w-2 rounded-full ring-2 ring-[var(--color-surface-panel-elevated)]",
                    badgeStatus.color,
                    badgeStatus.pulse && "animate-activity-pulse"
                  )}
                />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            Switch project{projectSwitcherShortcut ? ` (${projectSwitcherShortcut})` : ""}
          </TooltipContent>
        </Tooltip>
      </ProjectSwitcherPalette>
    </>
  );
}
