import { useEffect, useRef, useCallback } from "react";
import { Circle, Plus, Settings2, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ProjectActionRow } from "./ProjectActionRow";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import type { ProjectSwitcherMode, SearchableProject } from "@/hooks/useProjectSwitcherPalette";

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
  onStopProject?: (projectId: string, e: React.MouseEvent) => void;
  onCloseProject?: (projectId: string, e: React.MouseEvent) => void;
  onOpenProjectSettings?: () => void;
  dropdownAlign?: "start" | "center" | "end";
  children?: React.ReactNode;
}

interface ProjectListItemProps {
  project: SearchableProject;
  index: number;
  selectedIndex: number;
  onSelect: (project: SearchableProject) => void;
  onStopProject?: (projectId: string, e: React.MouseEvent) => void;
  onCloseProject?: (projectId: string, e: React.MouseEvent) => void;
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
  const canClose = !project.isActive;

  return (
    <div
      key={project.id}
      id={`project-option-${project.id}`}
      role="option"
      aria-selected={index === selectedIndex}
      className={cn(
        "relative w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors border cursor-pointer",
        index === selectedIndex
          ? "bg-white/[0.03] border-overlay text-canopy-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
          : "border-transparent text-canopy-text/70 hover:bg-white/[0.02] hover:text-canopy-text",
        project.isActive && "opacity-60"
      )}
      onClick={() => !project.isActive && onSelect(project)}
      aria-disabled={project.isActive}
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
              index === selectedIndex ? "text-canopy-text" : "text-canopy-text/85"
            )}
          >
            {project.name}
          </span>

          {project.isActive && (
            <span className="text-[10px] font-medium uppercase tracking-wider text-canopy-accent shrink-0">
              Active
            </span>
          )}

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

            {showStop && onStopProject && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onStopProject(project.id, e);
                }}
                className={cn(
                  "p-0.5 rounded transition-colors cursor-pointer",
                  "text-[var(--color-status-error)] hover:bg-red-500/10",
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
                )}
                title="Stop project"
                aria-label="Stop project"
              >
                <Square className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
            {onCloseProject && (
              <button
                type="button"
                onClick={(e) => {
                  if (!canClose) return;
                  e.stopPropagation();
                  onCloseProject(project.id, e);
                }}
                className={cn(
                  "p-0.5 rounded transition-colors cursor-pointer",
                  canClose
                    ? "text-canopy-text/50 hover:bg-white/[0.06] hover:text-canopy-text/80"
                    : "text-canopy-text/20 cursor-not-allowed"
                )}
                title={canClose ? "Close project" : "Can't close active project"}
                aria-label="Close project"
                disabled={!canClose}
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
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
  onOpenProjectSettings?: () => void;
  onStopProject?: (projectId: string, e: React.MouseEvent) => void;
  onCloseProject?: (projectId: string, e: React.MouseEvent) => void;
  showAddProject?: boolean;
  showProjectSettings?: boolean;
}

function ProjectListContent({
  results,
  selectedIndex,
  query,
  onSelect,
  listRef,
  onAddProject,
  onOpenProjectSettings,
  onStopProject,
  onCloseProject,
  showAddProject = false,
  showProjectSettings = false,
}: ProjectListContentProps) {
  const showSettings = showProjectSettings && onOpenProjectSettings;
  const showAdd = showAddProject && onAddProject;
  const showActions = showSettings || showAdd;

  return (
    <>
      <div ref={listRef} id="project-list" role="listbox" aria-label="Projects">
        {results.length === 0 ? (
          <div className="px-3 py-8 text-center text-canopy-text/50 text-sm">
            {query.trim() ? `No projects match "${query}"` : "No projects available"}
          </div>
        ) : (
          results.map((project, index) => (
            <ProjectListItem
              key={project.id}
              project={project}
              index={index}
              selectedIndex={selectedIndex}
              onSelect={onSelect}
              onStopProject={onStopProject}
              onCloseProject={onCloseProject}
            />
          ))
        )}
      </div>
      {showActions && (
        <>
          <div className="my-1 h-px bg-white/[0.06]" />
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
        </>
      )}
    </>
  );
}

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
  onStopProject,
  onCloseProject,
}: Omit<ProjectSwitcherPaletteProps, "mode" | "children">) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const projectSwitcherShortcut = useKeybindingDisplay("project.switcherPalette");

  useEffect(() => {
    if (isOpen && inputRef.current) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement;
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

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
      }
    },
    [results, selectedIndex, onSelectPrevious, onSelectNext, onSelect, onClose]
  );

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel="Project switcher">
      <AppPaletteDialog.Header label="Switch Project" keyHint={projectSwitcherShortcut}>
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
          aria-activedescendant={
            results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length
              ? `project-option-${results[selectedIndex].id}`
              : undefined
          }
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
          <ProjectListContent
            results={results}
            selectedIndex={selectedIndex}
            query={query}
            onSelect={onSelect}
            listRef={listRef}
            onAddProject={onAddProject}
            onStopProject={onStopProject}
            onCloseProject={onCloseProject}
            showAddProject={true}
          />
      </AppPaletteDialog.Body>

      <AppPaletteDialog.Footer>
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
            Esc
          </kbd>
          <span className="ml-1.5">to close</span>
        </span>
      </AppPaletteDialog.Footer>
    </AppPaletteDialog>
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
  onStopProject,
  onOpenProjectSettings,
  onCloseProject,
  dropdownAlign = "start",
  children,
}: Omit<ProjectSwitcherPaletteProps, "mode">) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const projectSwitcherShortcut = useKeybindingDisplay("project.switcherPalette");

  useEffect(() => {
    if (isOpen && inputRef.current) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const selectedItem = listRef.current.children[selectedIndex] as HTMLElement;
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

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
      }
    },
    [results, selectedIndex, onSelectPrevious, onSelectNext, onSelect, onClose]
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
        <AppPaletteDialog.Header label="Switch Project" keyHint={projectSwitcherShortcut}>
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
            aria-activedescendant={
              activeResult ? `project-option-${activeResult.id}` : undefined
            }
          />
        </AppPaletteDialog.Header>

        <AppPaletteDialog.Body maxHeight="max-h-[60vh]">
          <ProjectListContent
            results={results}
            selectedIndex={selectedIndex}
            query={query}
            onSelect={onSelect}
            listRef={listRef}
            onAddProject={onAddProject}
            onOpenProjectSettings={onOpenProjectSettings}
            onStopProject={onStopProject}
            onCloseProject={onCloseProject}
            showAddProject={true}
            showProjectSettings={!!onOpenProjectSettings}
          />
        </AppPaletteDialog.Body>

        <AppPaletteDialog.Footer>
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
              Esc
            </kbd>
            <span className="ml-1.5">to close</span>
          </span>
        </AppPaletteDialog.Footer>
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
  onStopProject,
  onCloseProject,
  onOpenProjectSettings,
  dropdownAlign,
  children,
}: ProjectSwitcherPaletteProps) {
  if (mode === "dropdown") {
    return (
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
        onStopProject={onStopProject}
        onCloseProject={onCloseProject}
        onOpenProjectSettings={onOpenProjectSettings}
        dropdownAlign={dropdownAlign}
      >
        {children}
      </DropdownContent>
    );
  }

  return (
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
      onStopProject={onStopProject}
      onCloseProject={onCloseProject}
    />
  );
}
