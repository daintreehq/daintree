import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronsUpDown, FileText, Plus } from "lucide-react";
import { SpinnerCircle } from "@/components/icons";
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

  const handleSleepProject = useCallback(
    (projectId: string) => {
      void projectSwitcher.sleepProject(projectId);
    },
    [projectSwitcher]
  );

  const handleLocateProject = useCallback(
    (projectId: string) => {
      projectSwitcher.locateProject(projectId);
    },
    [projectSwitcher]
  );

  const handleMoveOrRenameProject = useCallback(
    (projectId: string) => {
      projectSwitcher.moveOrRenameProject(projectId);
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

  // Reads the totals across every non-active project rather than `results`,
  // which is ordered and filtered for presentation.
  //
  // Two axes on one mark, the same split the switcher's rows draw (#11832):
  // hue says what is being asked of the user, shape says whether anything is
  // still moving. Before that they contended for one carrier, so a fleet that
  // was both waiting AND churning looked exactly like one that had stalled.
  const badgeStatus = useMemo(() => {
    const { activeAgentCount, waitingAgentCount, waitingProjectCount } =
      projectSwitcher.nonActiveAgentCounts;

    if (waitingAgentCount === 0 && activeAgentCount === 0) return null;

    const parts: string[] = [];
    // Waiting counts PROJECTS, not agents: the number answers "how many places
    // need me?", which stays legible when eight agents pile up in one repo. An
    // agent tally there would read as eight separate obligations.
    if (waitingAgentCount > 0) {
      parts.push(
        `${waitingProjectCount} project${waitingProjectCount === 1 ? "" : "s"} waiting for input`
      );
    }
    // Work in progress isn't an obligation, so it stays an agent count.
    if (activeAgentCount > 0) {
      parts.push(
        `${activeAgentCount} background agent${activeAgentCount === 1 ? "" : "s"} working`
      );
    }

    return {
      // Demand still wins the hue outright — the badge's colour has always
      // meant "this needs you", and liveness rides the shape instead of
      // competing for it.
      color: waitingAgentCount > 0 ? "bg-state-waiting" : "bg-activity-active",
      arc: waitingAgentCount > 0 ? "text-state-waiting" : "text-activity-active",
      isLive: activeAgentCount > 0,
      // Both facts, always. The mark is a single glyph and the label is the
      // only place a reader who cannot see it learns either one.
      label: parts.join(", "),
    };
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

  // Deleting the last scratch clears `currentScratch`, so a zero-project user
  // would drop straight to the bare "Open Project…" branch below — unmounting the
  // palette, and with it the confirm dialog still spinning on the delete. Hold the
  // palette open until the run resolves. Covers the single-scratch delete too:
  // deleting the one remaining scratch takes the same branch.
  const hasPendingScratchDelete = Boolean(
    projectSwitcher.deleteAllScratchesConfirm || projectSwitcher.deleteScratchConfirm
  );

  if (!currentProject && !currentScratch) {
    if (projects.length > 0 || hasPendingScratchDelete) {
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
            onSelect={projectSwitcher.selectRow}
            onClose={handleDropdownClose}
            onAddProject={projectSwitcher.addProject}
            onCloneRepo={handleCloneRepo}
            onCreateFolder={handleCreateFolder}
            onStopProject={handleStopProject}
            onCloseProject={handleCloseProject}
            onSleepProject={handleSleepProject}
            onLocateProject={handleLocateProject}
            onMoveOrRenameProject={handleMoveOrRenameProject}
            onTogglePinProject={handleTogglePinProject}
            onCopyPath={projectSwitcher.copyPath}
            onSelectNewWindow={handleSelectNewWindow}
            onHoverProject={projectSwitcher.onHoverProject}
            onHoverProjectEnd={projectSwitcher.onHoverProjectEnd}
            fleetLiveness={projectSwitcher.fleetLiveness}
            removeConfirmProject={projectSwitcher.removeConfirmProject}
            onRemoveConfirmClose={() => projectSwitcher.setRemoveConfirmProject(null)}
            onConfirmRemove={projectSwitcher.confirmRemoveProject}
            isRemovingProject={projectSwitcher.isRemovingProject}
            sleepConfirmProject={projectSwitcher.sleepConfirmProject}
            onSleepConfirmClose={() => projectSwitcher.setSleepConfirmProject(null)}
            onConfirmSleep={projectSwitcher.confirmSleep}
            isSleepingProject={projectSwitcher.isSleepingProject}
            rankedSearch={projectSwitcher.isRankedSearch}
            scratchResults={projectSwitcher.scratchResults}
            onCreateScratch={(name) => void projectSwitcher.createScratch(name)}
            onSelectScratch={(scratch) => void projectSwitcher.selectScratch(scratch)}
            onRequestDeleteScratch={projectSwitcher.requestDeleteScratch}
            deleteScratchConfirm={projectSwitcher.deleteScratchConfirm}
            onDismissDeleteScratchConfirm={projectSwitcher.dismissDeleteScratchConfirm}
            onConfirmDeleteScratch={() => void projectSwitcher.confirmDeleteScratch()}
            isDeletingScratch={projectSwitcher.isDeletingScratch}
            onRequestDeleteAllScratches={projectSwitcher.requestDeleteAllScratches}
            deleteAllScratchesConfirm={projectSwitcher.deleteAllScratchesConfirm}
            onDismissDeleteAllScratchesConfirm={projectSwitcher.dismissDeleteAllScratchesConfirm}
            onConfirmDeleteAllScratches={() => void projectSwitcher.confirmDeleteAllScratches()}
            isDeletingAllScratches={projectSwitcher.isDeletingAllScratches}
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
        onSelect={projectSwitcher.selectRow}
        onClose={handleDropdownClose}
        onAddProject={projectSwitcher.addProject}
        onCloneRepo={handleCloneRepo}
        onCreateFolder={handleCreateFolder}
        onStopProject={handleStopProject}
        onCloseProject={handleCloseProject}
        onSleepProject={handleSleepProject}
        onLocateProject={handleLocateProject}
        onMoveOrRenameProject={handleMoveOrRenameProject}
        onTogglePinProject={handleTogglePinProject}
        onOpenProjectSettings={currentProject ? handleOpenSettings : undefined}
        onCopyPath={projectSwitcher.copyPath}
        onHoverProject={projectSwitcher.onHoverProject}
        onHoverProjectEnd={projectSwitcher.onHoverProjectEnd}
        fleetLiveness={projectSwitcher.fleetLiveness}
        removeConfirmProject={projectSwitcher.removeConfirmProject}
        onRemoveConfirmClose={() => projectSwitcher.setRemoveConfirmProject(null)}
        onConfirmRemove={projectSwitcher.confirmRemoveProject}
        isRemovingProject={projectSwitcher.isRemovingProject}
        sleepConfirmProject={projectSwitcher.sleepConfirmProject}
        onSleepConfirmClose={() => projectSwitcher.setSleepConfirmProject(null)}
        onConfirmSleep={projectSwitcher.confirmSleep}
        isSleepingProject={projectSwitcher.isSleepingProject}
        rankedSearch={projectSwitcher.isRankedSearch}
        scratchResults={projectSwitcher.scratchResults}
        onCreateScratch={(name) => void projectSwitcher.createScratch(name)}
        onSelectScratch={(scratch) => void projectSwitcher.selectScratch(scratch)}
        onRequestDeleteScratch={projectSwitcher.requestDeleteScratch}
        deleteScratchConfirm={projectSwitcher.deleteScratchConfirm}
        onDismissDeleteScratchConfirm={projectSwitcher.dismissDeleteScratchConfirm}
        onConfirmDeleteScratch={() => void projectSwitcher.confirmDeleteScratch()}
        isDeletingScratch={projectSwitcher.isDeletingScratch}
        onRequestDeleteAllScratches={projectSwitcher.requestDeleteAllScratches}
        deleteAllScratchesConfirm={projectSwitcher.deleteAllScratchesConfirm}
        onDismissDeleteAllScratchesConfirm={projectSwitcher.dismissDeleteAllScratchesConfirm}
        onConfirmDeleteAllScratches={() => void projectSwitcher.confirmDeleteAllScratches()}
        isDeletingAllScratches={projectSwitcher.isDeletingAllScratches}
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
                // A fixed box either mark centres in, so switching between them
                // moves nothing around it. The 10px arc lands on the same
                // footprint the 8px dot and its ring already occupied.
                <span
                  role="status"
                  aria-label={badgeStatus.label}
                  className="absolute top-0.5 right-0.5 flex h-3 w-3 items-center justify-center"
                >
                  {badgeStatus.isLive ? (
                    // Sized inline rather than by class. `Button` sizes every
                    // SVG under it with a descendant rule (`[&_svg]:size-4`),
                    // which outranks a utility class on the glyph itself — so a
                    // classed 10px arc would silently render at 16px and spill
                    // out of the badge's box.
                    <SpinnerCircle
                      className={badgeStatus.arc}
                      style={{ width: "0.625rem", height: "0.625rem" }}
                      data-testid="project-switcher-badge-arc"
                    />
                  ) : (
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full ring-2 ring-[var(--color-surface-panel-elevated)]",
                        badgeStatus.color
                      )}
                    />
                  )}
                </span>
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
