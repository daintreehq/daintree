import { useMemo, useEffect, useRef, useCallback } from "react";
import { Circle, FolderPlus, Plus, Settings2, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { SearchablePalette } from "@/components/ui/SearchablePalette";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ProjectActionRow } from "./ProjectActionRow";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import type { ProjectSwitcherMode, SearchableProject } from "@/hooks/useProjectSwitcherPalette";
import { useUIStore } from "@/store/uiStore";

export interface ProjectSwitcherPaletteProps {
  isOpen: boolean;
  query: string;
  results: SearchableProject[];
  selectedIndex: number;
  onQueryChange: (query: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onSelect: (project: SearchableProject) => void;
  onClose: () => void;
  mode?: ProjectSwitcherMode;
  onAddProject?: () => void;
  onCreateFolder?: () => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onOpenProjectSettings?: () => void;
  dropdownAlign?: "start" | "center" | "end";
  children?: React.ReactNode;
  removeConfirmProject?: SearchableProject | null;
  onRemoveConfirmClose?: () => void;
  onConfirmRemove?: () => void;
  isRemovingProject?: boolean;
}

interface ProjectListItemProps {
  project: SearchableProject;
  index: number;
  selectedIndex: number;
  onSelect: (project: SearchableProject) => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
}

function ProjectListItem({
  project,
  index,
  selectedIndex,
  onSelect,
  onStopProject,
  onCloseProject,
}: ProjectListItemProps) {
  const showStop = project.processCount > 0;

  return (
    <div
      id={`project-option-${project.id}`}
      role="option"
      aria-selected={index === selectedIndex}
      className={cn(
        "group relative w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors border border-transparent",
        project.isActive
          ? cn("text-canopy-text", index === selectedIndex && "bg-white/[0.04]")
          : index === selectedIndex
            ? "bg-white/[0.04] text-canopy-text cursor-pointer"
            : "text-canopy-text/70 hover:bg-white/[0.02] hover:text-canopy-text cursor-pointer"
      )}
      onClick={() => !project.isActive && onSelect(project)}
    >
      <div
        className={cn(
          "flex items-center justify-center rounded-[var(--radius-lg)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] shrink-0 transition-all duration-200",
          "h-8 w-8 text-base"
        )}
        style={{
          background: project.color
            ? `linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), ${getProjectGradient(project.color)}`
            : "linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), var(--color-canopy-sidebar)",
        }}
      >
        <span className="leading-none select-none filter drop-shadow-sm">{project.emoji}</span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              "truncate text-sm font-semibold leading-tight",
              project.isActive || index === selectedIndex
                ? "text-canopy-text"
                : "text-canopy-text/85"
            )}
          >
            {project.name}
          </span>

          {project.isBackground && !project.isActive && (
            <Circle
              className="h-2 w-2 fill-green-500 text-green-500 shrink-0"
              aria-label="Running in background"
            />
          )}

          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <ProjectActionRow
              activeAgentCount={project.activeAgentCount}
              waitingAgentCount={project.waitingAgentCount}
            />

            {(showStop || onCloseProject) && (
              <div
                className={cn(
                  "flex items-center gap-1.5 transition-opacity",
                  index === selectedIndex ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                )}
              >
                {showStop && onStopProject && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onStopProject(project.id);
                          }}
                          className={cn(
                            "p-0.5 rounded transition-colors cursor-pointer",
                            "text-[var(--color-status-error)] hover:bg-red-500/10",
                            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                          )}
                          aria-label="Stop project"
                        >
                          <Square className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Stop project</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                {onCloseProject && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCloseProject(project.id);
                          }}
                          className={cn(
                            "p-0.5 rounded transition-colors cursor-pointer",
                            "text-canopy-text/50 hover:bg-white/[0.06] hover:text-canopy-text/80",
                            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                          )}
                          aria-label="Close project"
                        >
                          <X className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Close project</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center min-w-0 mt-0.5">
          <span className="truncate text-[11px] leading-none font-mono text-canopy-text/50">
            {project.path.split(/[/\\]/).pop()}
          </span>
        </div>
      </div>
    </div>
  );
}

interface ProjectListContentProps {
  results: SearchableProject[];
  selectedIndex: number;
  query: string;
  onSelect: (project: SearchableProject) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  onAddProject?: () => void;
  onCreateFolder?: () => void;
  onOpenProjectSettings?: () => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  showAddProject?: boolean;
  showCreateFolder?: boolean;
  showProjectSettings?: boolean;
}

function ProjectListContent({
  results,
  selectedIndex,
  query,
  onSelect,
  listRef,
  onAddProject,
  onCreateFolder,
  onOpenProjectSettings,
  onStopProject,
  onCloseProject,
  showAddProject = false,
  showCreateFolder = false,
  showProjectSettings = false,
}: ProjectListContentProps) {
  const showSettings = showProjectSettings && onOpenProjectSettings;
  const showAdd = showAddProject && onAddProject;
  const showCreate = showCreateFolder && onCreateFolder;
  const showActions = showSettings || showAdd || showCreate;

  const isSearching = query.trim().length > 0;

  const sections = useMemo(() => {
    if (isSearching || results.length === 0) return null;
    const current = results.filter((p) => p.isActive);
    const previous = results.filter((p) => !p.isActive);
    return [current, previous].filter((s) => s.length > 0);
  }, [results, isSearching]);

  const renderItem = (project: SearchableProject) => {
    const index = results.indexOf(project);
    return (
      <div key={project.id} role="presentation">
        <ProjectListItem
          project={project}
          index={index}
          selectedIndex={selectedIndex}
          onSelect={onSelect}
          onStopProject={onStopProject}
          onCloseProject={onCloseProject}
        />
      </div>
    );
  };

  return (
    <>
      <div ref={listRef} id="project-list" role="listbox" aria-label="Projects">
        {results.length === 0 ? (
          <div className="p-2">
            <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">
              {query.trim() ? (
                <>
                  <div>{`No projects match "${query}"`}</div>
                  {onAddProject && (
                    <button
                      type="button"
                      onClick={() => onAddProject()}
                      className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-[var(--radius-md)] bg-white/[0.04] text-canopy-text/70 hover:text-canopy-text hover:bg-white/[0.06] transition-colors cursor-pointer text-sm"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Project...
                    </button>
                  )}
                </>
              ) : (
                "No projects available"
              )}
            </div>
          </div>
        ) : sections ? (
          sections.map((section, sectionIdx) => {
            const isActiveSection = section[0]?.isActive;
            const isLast = sectionIdx === sections.length - 1;
            return (
              <div key={sectionIdx}>
                {sectionIdx > 0 && <div className="h-[3px] bg-white/[0.08]" />}
                <div
                  className={cn(
                    "px-2 py-1.5",
                    sectionIdx === 0 && "pt-2",
                    isLast && !showActions && "pb-2",
                    isActiveSection && "bg-white/[0.02]"
                  )}
                >
                  {section.map(renderItem)}
                </div>
              </div>
            );
          })
        ) : (
          <div className="p-2">
            {results.map((project, index) => (
              <div key={project.id} role="presentation">
                <ProjectListItem
                  project={project}
                  index={index}
                  selectedIndex={selectedIndex}
                  onSelect={onSelect}
                  onStopProject={onStopProject}
                  onCloseProject={onCloseProject}
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {showActions && (
        <>
          <div className="h-[3px] bg-white/[0.08]" />
          <div className="px-2 pt-1 pb-2">
            {showSettings && (
              <button
                type="button"
                onClick={() => onOpenProjectSettings?.()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-white/[0.02]"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] bg-white/[0.04] text-muted-foreground">
                  <Settings2 className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">
                  Project Settings...
                </span>
              </button>
            )}
            {showAdd && (
              <button
                type="button"
                onClick={() => onAddProject?.()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-white/[0.02]"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
                  <Plus className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">Add Project...</span>
              </button>
            )}
            {showCreate && (
              <button
                type="button"
                onClick={() => onCreateFolder?.()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-white/[0.02]"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
                  <FolderPlus className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">
                  Create New Folder...
                </span>
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}

const PROJECT_FOOTER = (
  <>
    <span>
      <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
        ↑
      </kbd>
      <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60 ml-1">
        ↓
      </kbd>
      <span className="ml-1.5">to navigate</span>
    </span>
    <span>
      <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
        Enter
      </kbd>
      <span className="ml-1.5">to switch</span>
    </span>
    <span>
      <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
        ⌘⌫
      </kbd>
      <span className="ml-1.5">to remove</span>
    </span>
    <span>
      <kbd className="px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-canopy-border text-canopy-text/60">
        Esc
      </kbd>
      <span className="ml-1.5">to close</span>
    </span>
  </>
);

function ModalContent({
  isOpen,
  query,
  results,
  selectedIndex,
  onQueryChange,
  onSelectPrevious,
  onSelectNext,
  onSelect,
  onClose,
  onAddProject,
  onCreateFolder,
  onStopProject,
  onCloseProject,
}: Omit<ProjectSwitcherPaletteProps, "mode" | "children">) {
  const listRef = useRef<HTMLDivElement>(null);
  const projectSwitcherShortcut = useKeybindingDisplay("project.switcherPalette");

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0 && selectedIndex < results.length) {
      const selectedItem = listRef.current.querySelector(
        `#project-option-${results[selectedIndex].id}`
      );
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex, results]);

  const handleBackspaceKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (
        e.key === "Backspace" &&
        (e.metaKey || e.ctrlKey) &&
        onCloseProject &&
        results.length > 0 &&
        selectedIndex >= 0 &&
        selectedIndex < results.length
      ) {
        e.preventDefault();
        onCloseProject(results[selectedIndex].id);
      }
    },
    [results, selectedIndex, onCloseProject]
  );

  return (
    <SearchablePalette<SearchableProject>
      isOpen={isOpen}
      query={query}
      results={results}
      selectedIndex={selectedIndex}
      onQueryChange={onQueryChange}
      onSelectPrevious={onSelectPrevious}
      onSelectNext={onSelectNext}
      onConfirm={() => {
        if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
          onSelect(results[selectedIndex]);
        }
      }}
      onClose={onClose}
      getItemId={(project) => project.id}
      renderItem={() => null}
      label="Switch Project"
      keyHint={projectSwitcherShortcut}
      ariaLabel="Project switcher"
      searchPlaceholder="Search projects..."
      searchAriaLabel="Search projects"
      listId="project-list"
      itemIdPrefix="project-option"
      headerClassName="pb-2"
      bodyClassName="p-0"
      onKeyDown={handleBackspaceKeyDown}
      footer={PROJECT_FOOTER}
      renderBody={() => (
        <ProjectListContent
          results={results}
          selectedIndex={selectedIndex}
          query={query}
          onSelect={onSelect}
          listRef={listRef}
          onAddProject={onAddProject}
          onCreateFolder={onCreateFolder}
          onStopProject={onStopProject}
          onCloseProject={onCloseProject}
          showAddProject={true}
          showCreateFolder={true}
        />
      )}
    />
  );
}

function DropdownContent({
  isOpen,
  query,
  results,
  selectedIndex,
  onQueryChange,
  onSelectPrevious,
  onSelectNext,
  onSelect,
  onClose,
  onAddProject,
  onCreateFolder,
  onStopProject,
  onOpenProjectSettings,
  onCloseProject,
  dropdownAlign = "start",
  children,
}: Omit<ProjectSwitcherPaletteProps, "mode">) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const projectSwitcherShortcut = useKeybindingDisplay("project.switcherPalette");
  const overlayCount = useUIStore((state) => state.overlayCount);
  const prevOverlayCountRef = useRef<number>(overlayCount);
  const focusRafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    focusRafRef.current = requestAnimationFrame(() => {
      inputRef.current?.focus();
      focusRafRef.current = null;
    });
    return () => {
      if (focusRafRef.current !== null) {
        cancelAnimationFrame(focusRafRef.current);
        focusRafRef.current = null;
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && overlayCount > prevOverlayCountRef.current && overlayCount > 0) {
      onClose();
    }
    prevOverlayCountRef.current = overlayCount;
  }, [isOpen, overlayCount, onClose]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0 && selectedIndex < results.length) {
      const selectedItem = listRef.current.querySelector(
        `#project-option-${results[selectedIndex].id}`
      );
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex, results]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          onSelectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          onSelectNext();
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
            onSelect(results[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
        case "Tab":
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) {
            onSelectPrevious();
          } else {
            onSelectNext();
          }
          break;
        case "Backspace":
          if (
            (e.metaKey || e.ctrlKey) &&
            onCloseProject &&
            results.length > 0 &&
            selectedIndex >= 0 &&
            selectedIndex < results.length
          ) {
            e.preventDefault();
            e.stopPropagation();
            onCloseProject(results[selectedIndex].id);
          }
          break;
      }
    },
    [results, selectedIndex, onSelectPrevious, onSelectNext, onSelect, onClose, onCloseProject]
  );

  const activeResult = results[selectedIndex];

  return (
    <Popover open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className="w-[484px] max-w-[calc(100vw-2rem)] p-0"
        align={dropdownAlign}
        sideOffset={8}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <AppPaletteDialog.Header
          label="Switch Project"
          keyHint={projectSwitcherShortcut}
          className="pb-2"
        >
          <AppPaletteDialog.Input
            inputRef={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search projects..."
            role="combobox"
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-label="Search projects"
            aria-controls="project-list"
            aria-activedescendant={activeResult ? `project-option-${activeResult.id}` : undefined}
          />
        </AppPaletteDialog.Header>

        <AppPaletteDialog.Body maxHeight="max-h-[60vh]" className="p-0">
          <ProjectListContent
            results={results}
            selectedIndex={selectedIndex}
            query={query}
            onSelect={onSelect}
            listRef={listRef}
            onAddProject={onAddProject}
            onCreateFolder={onCreateFolder}
            onOpenProjectSettings={onOpenProjectSettings}
            onStopProject={onStopProject}
            onCloseProject={onCloseProject}
            showAddProject={true}
            showCreateFolder={true}
            showProjectSettings={!!onOpenProjectSettings}
          />
        </AppPaletteDialog.Body>

        <AppPaletteDialog.Footer>{PROJECT_FOOTER}</AppPaletteDialog.Footer>
      </PopoverContent>
    </Popover>
  );
}

export function ProjectSwitcherPalette({
  isOpen,
  query,
  results,
  selectedIndex,
  onQueryChange,
  onSelectPrevious,
  onSelectNext,
  onSelect,
  onClose,
  mode = "modal",
  onAddProject,
  onCreateFolder,
  onStopProject,
  onCloseProject,
  onOpenProjectSettings,
  dropdownAlign,
  children,
  removeConfirmProject,
  onRemoveConfirmClose,
  onConfirmRemove,
  isRemovingProject = false,
}: ProjectSwitcherPaletteProps) {
  const hasRunningProcesses = removeConfirmProject
    ? removeConfirmProject.processCount > 0 ||
      removeConfirmProject.activeAgentCount > 0 ||
      removeConfirmProject.waitingAgentCount > 0
    : false;

  const content =
    mode === "dropdown" ? (
      <DropdownContent
        isOpen={isOpen}
        query={query}
        results={results}
        selectedIndex={selectedIndex}
        onQueryChange={onQueryChange}
        onSelectPrevious={onSelectPrevious}
        onSelectNext={onSelectNext}
        onSelect={onSelect}
        onClose={onClose}
        onAddProject={onAddProject}
        onCreateFolder={onCreateFolder}
        onStopProject={onStopProject}
        onCloseProject={onCloseProject}
        onOpenProjectSettings={onOpenProjectSettings}
        dropdownAlign={dropdownAlign}
      >
        {children}
      </DropdownContent>
    ) : (
      <ModalContent
        isOpen={isOpen}
        query={query}
        results={results}
        selectedIndex={selectedIndex}
        onQueryChange={onQueryChange}
        onSelectPrevious={onSelectPrevious}
        onSelectNext={onSelectNext}
        onSelect={onSelect}
        onClose={onClose}
        onAddProject={onAddProject}
        onCreateFolder={onCreateFolder}
        onStopProject={onStopProject}
        onCloseProject={onCloseProject}
      />
    );

  return (
    <>
      {content}
      {removeConfirmProject && onRemoveConfirmClose && onConfirmRemove && (
        <ConfirmDialog
          isOpen={true}
          onClose={isRemovingProject ? undefined : onRemoveConfirmClose}
          title={removeConfirmProject.isActive ? "Close Project?" : "Remove Project from List?"}
          zIndex="nested"
          confirmLabel={removeConfirmProject.isActive ? "Close Project" : "Remove Project"}
          cancelLabel="Cancel"
          onConfirm={onConfirmRemove}
          isConfirmLoading={isRemovingProject}
          variant="destructive"
        >
          <div className="space-y-3">
            <div>
              <div className="font-medium text-sm">{removeConfirmProject.name}</div>
              <div className="text-xs text-canopy-text/50 font-mono mt-1">
                {removeConfirmProject.path}
              </div>
            </div>
            {removeConfirmProject.isActive
              ? hasRunningProcesses && (
                  <div className="rounded-[var(--radius-md)] bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-200">
                    <div className="font-medium">
                      Warning: All running processes will be terminated
                    </div>
                    <div className="mt-1 text-amber-200/80">
                      {removeConfirmProject.processCount > 0 && (
                        <div>• {removeConfirmProject.processCount} running process(es)</div>
                      )}
                      {removeConfirmProject.activeAgentCount > 0 && (
                        <div>• {removeConfirmProject.activeAgentCount} active agent(s)</div>
                      )}
                      {removeConfirmProject.waitingAgentCount > 0 && (
                        <div>• {removeConfirmProject.waitingAgentCount} waiting agent(s)</div>
                      )}
                    </div>
                  </div>
                )
              : hasRunningProcesses && (
                  <div className="rounded-[var(--radius-md)] bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-200">
                    <div className="font-medium">Warning: Active sessions detected</div>
                    <div className="mt-1 text-amber-200/80">
                      {removeConfirmProject.processCount > 0 && (
                        <div>• {removeConfirmProject.processCount} running process(es)</div>
                      )}
                      {removeConfirmProject.activeAgentCount > 0 && (
                        <div>• {removeConfirmProject.activeAgentCount} active agent(s)</div>
                      )}
                      {removeConfirmProject.waitingAgentCount > 0 && (
                        <div>• {removeConfirmProject.waitingAgentCount} waiting agent(s)</div>
                      )}
                    </div>
                  </div>
                )}
            <div className="text-xs text-canopy-text/60">
              {removeConfirmProject.isActive
                ? "The project will remain in your list and can be reopened at any time."
                : "This project will be removed from your list. You can add it back later, but any running terminals or processes will need to be restarted."}
            </div>
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}
