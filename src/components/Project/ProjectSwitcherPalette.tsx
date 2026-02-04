import { useEffect, useRef, useCallback } from "react";
import { Circle, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ProjectActionRow } from "./ProjectActionRow";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";

export type ProjectSwitcherMode = "modal" | "dropdown";

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
  children?: React.ReactNode;
}

interface ProjectListItemProps {
  project: SearchableProject;
  index: number;
  selectedIndex: number;
  onSelect: (project: SearchableProject) => void;
  onStopProject?: (projectId: string, e: React.MouseEvent) => void;
}

function ProjectListItem({
  project,
  index,
  selectedIndex,
  onSelect,
  onStopProject,
}: ProjectListItemProps) {
  const showStop = project.processCount > 0;

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
  onStopProject?: (projectId: string, e: React.MouseEvent) => void;
  showAddProject?: boolean;
}

function ProjectListContent({
  results,
  selectedIndex,
  query,
  onSelect,
  listRef,
  onAddProject,
  onStopProject,
  showAddProject = false,
}: ProjectListContentProps) {
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
            />
          ))
        )}
      </div>
      {showAddProject && onAddProject && (
        <>
          <div className="my-1 h-px bg-white/[0.06]" />
          <button
            type="button"
            onClick={onAddProject}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-white/[0.02]"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
              <Plus className="h-4 w-4" />
            </div>
            <span className="font-medium text-sm text-muted-foreground">Add Project...</span>
          </button>
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
}: Omit<ProjectSwitcherPaletteProps, "mode" | "children" | "onAddProject">) {
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
          onSelectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          onSelectNext();
          break;
        case "Enter":
          e.preventDefault();
          if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
            onSelect(results[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        case "Tab":
          e.preventDefault();
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
  children,
}: Omit<ProjectSwitcherPaletteProps, "mode">) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
          onSelectPrevious();
          break;
        case "ArrowDown":
          e.preventDefault();
          onSelectNext();
          break;
        case "Enter":
          e.preventDefault();
          if (results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length) {
            onSelect(results[selectedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [results, selectedIndex, onSelectPrevious, onSelectNext, onSelect, onClose]
  );

  return (
    <Popover open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className="w-[484px] max-w-[calc(100vw-2rem)] p-0"
        align="start"
        sideOffset={8}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <div className="px-3 pt-2 pb-1 border-b border-canopy-border">
          <div className="flex justify-between items-center mb-1.5 text-[11px] text-canopy-text/50">
            <span>Switch Project</span>
          </div>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search projects..."
            className={cn(
              "w-full px-3 py-2 text-sm",
              "bg-canopy-sidebar border border-canopy-border rounded-[var(--radius-md)]",
              "text-canopy-text placeholder:text-canopy-text/40",
              "focus:outline-none focus:border-canopy-accent focus:ring-1 focus:ring-canopy-accent"
            )}
            role="combobox"
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-label="Search projects"
            aria-controls="project-list"
            aria-activedescendant={
              results.length > 0 && selectedIndex >= 0
                ? `project-option-${results[selectedIndex].id}`
                : undefined
            }
          />
        </div>

        <div className="overflow-y-auto p-2 space-y-1 max-h-[60vh]">
          <ProjectListContent
            results={results}
            selectedIndex={selectedIndex}
            query={query}
            onSelect={onSelect}
            listRef={listRef}
            onAddProject={onAddProject}
            onStopProject={onStopProject}
            showAddProject={true}
          />
        </div>
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
    />
  );
}
