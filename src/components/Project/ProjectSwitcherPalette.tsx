import { useEffect, useRef, useCallback } from "react";
import { Circle } from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { ProjectActionRow } from "./ProjectActionRow";
import type { SearchableProject } from "@/hooks/useProjectSwitcherPalette";

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
}: ProjectSwitcherPaletteProps) {
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
          if (results.length > 0 && selectedIndex >= 0) {
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

  const renderIcon = (emoji: string, color?: string) => (
    <div
      className={cn(
        "flex items-center justify-center rounded-[var(--radius-lg)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] shrink-0 transition-all duration-200",
        "h-8 w-8 text-base"
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

  return (
    <AppPaletteDialog isOpen={isOpen} onClose={onClose} ariaLabel="Project switcher">
      <AppPaletteDialog.Header label="Switch Project" keyHint="⌘K, P">
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
            results.length > 0 && selectedIndex >= 0
              ? `project-option-${results[selectedIndex].id}`
              : undefined
          }
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body>
        <div ref={listRef} id="project-list" role="listbox" aria-label="Projects">
          {results.length === 0 ? (
            <AppPaletteDialog.Empty
              query={query}
              emptyMessage="No projects available"
              noMatchMessage={`No projects match "${query}"`}
            />
          ) : (
            results.map((project, index) => (
              <button
                key={project.id}
                id={`project-option-${project.id}`}
                role="option"
                aria-selected={index === selectedIndex}
                className={cn(
                  "relative w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors border",
                  index === selectedIndex
                    ? "bg-white/[0.03] border-overlay text-canopy-text before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r before:bg-canopy-accent before:content-['']"
                    : "border-transparent text-canopy-text/70 hover:bg-white/[0.02] hover:text-canopy-text",
                  project.isActive && "opacity-60"
                )}
                onClick={() => onSelect(project)}
                disabled={project.isActive}
                aria-disabled={project.isActive}
              >
                {renderIcon(project.emoji, project.color)}

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
                    </div>
                  </div>

                  <div className="flex items-center min-w-0 mt-0.5">
                    <span className="truncate text-[11px] leading-none font-mono text-canopy-text/50">
                      {project.path.split(/[/\\]/).pop()}
                    </span>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
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
