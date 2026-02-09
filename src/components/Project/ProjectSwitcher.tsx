import { useCallback } from "react";
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
import { ProjectSwitcherPalette } from "./ProjectSwitcherPalette";

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
            onStopProject={handleStopProject}
            onCloseProject={handleCloseProject}
            removeConfirmProject={projectSwitcher.removeConfirmProject}
            onRemoveConfirmClose={() => projectSwitcher.setRemoveConfirmProject(null)}
            onConfirmRemove={projectSwitcher.confirmRemoveProject}
            isRemovingProject={projectSwitcher.isRemovingProject}
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
        onStopProject={handleStopProject}
        onCloseProject={handleCloseProject}
        onOpenProjectSettings={handleOpenSettings}
        removeConfirmProject={projectSwitcher.removeConfirmProject}
        onRemoveConfirmClose={() => projectSwitcher.setRemoveConfirmProject(null)}
        onConfirmRemove={projectSwitcher.confirmRemoveProject}
        isRemovingProject={projectSwitcher.isRemovingProject}
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
