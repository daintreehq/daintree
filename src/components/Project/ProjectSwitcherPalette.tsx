import { useMemo, useEffect, useRef, useCallback } from "react";
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
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onOpenProjectSettings?: () => void;
  dropdownAlign?: "start" | "center" | "end";
  children?: React.ReactNode;
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
  const canClose = !project.isActive;

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
                      onCloseProject(project.id);
                    }}
                    className={cn(
                      "p-0.5 rounded transition-colors",
                      canClose
                        ? "text-canopy-text/50 hover:bg-white/[0.06] hover:text-canopy-text/80 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent"
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
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
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
          </div>
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
            const selectedProject = results[selectedIndex];
            if (!selectedProject.isActive) {
              e.preventDefault();
              e.stopPropagation();
              onCloseProject(selectedProject.id);
            }
          }
          break;
      }
    },
    [results, selectedIndex, onSelectPrevious, onSelectNext, onSelect, onClose, onCloseProject]
  );

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel="Project switcher">
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
          aria-activedescendant={
            results.length > 0 && selectedIndex >= 0 && selectedIndex < results.length
              ? `project-option-${results[selectedIndex].id}`
              : undefined
          }
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body className="p-0">
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
            const selectedProject = results[selectedIndex];
            if (!selectedProject.isActive) {
              e.preventDefault();
              e.stopPropagation();
              onCloseProject(selectedProject.id);
            }
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
