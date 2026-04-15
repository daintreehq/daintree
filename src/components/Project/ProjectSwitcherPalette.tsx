import { useMemo, useEffect, useLayoutEffect, useRef, useCallback, memo } from "react";
import { createPortal } from "react-dom";
import {
  Clipboard,
  Download,
  FolderOpen,
  FolderPlus,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Square,
  X,
  AppWindow,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getProjectGradient } from "@/lib/colorUtils";
import { AppPaletteDialog } from "@/components/ui/AppPaletteDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { formatTimeAgo } from "@/utils/timeAgo";
import { useKeybindingDisplay } from "@/hooks/useKeybinding";
import { useModifierKeys } from "@/hooks/useModifierKeys";
import { useOverlayState } from "@/hooks";
import { usePaletteStore } from "@/store/paletteStore";
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
  onCloneRepo?: () => void;
  onCreateFolder?: () => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectBackground?: (project: SearchableProject) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
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
  isSelected: boolean;
  onSelect: (project: SearchableProject) => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
}

const StatusDot = memo(function StatusDot({ project }: { project: SearchableProject }) {
  const hasActive = project.activeAgentCount > 0;
  const hasWaiting = project.waitingAgentCount > 0;
  const hasProcesses = project.processCount > 0;

  if (hasActive) {
    return (
      <div
        className="w-1.5 h-1.5 rounded-full bg-daintree-accent animate-agent-pulse shrink-0"
        aria-label="Agents working"
      />
    );
  }
  if (hasWaiting) {
    return (
      <div
        className="w-1.5 h-1.5 rounded-full bg-status-warning shrink-0"
        aria-label="Agents waiting"
      />
    );
  }
  if (hasProcesses || project.isBackground) {
    return (
      <div
        className="w-1.5 h-1.5 rounded-full bg-status-success shrink-0"
        aria-label="Running in background"
      />
    );
  }
  return (
    <div
      className="w-1.5 h-1.5 rounded-full border border-daintree-text/20 shrink-0"
      aria-label="Idle"
    />
  );
});

const ProjectListItem = memo(function ProjectListItem({
  project,
  isSelected,
  onSelect,
  onStopProject,
  onCloseProject,
  onLocateProject,
  onTogglePinProject,
  onCopyPath,
  onSelectNewWindow,
}: ProjectListItemProps) {
  const showStop = project.processCount > 0 && !project.isMissing;

  const { secondaryText, secondaryClass } = (() => {
    if (project.isMissing)
      return { secondaryText: "Directory not found", secondaryClass: "text-status-warning/70" };
    if (project.activeAgentCount > 0)
      return { secondaryText: "Agent working\u2026", secondaryClass: "text-daintree-accent/80" };
    if (project.waitingAgentCount > 0)
      return { secondaryText: "Needs review", secondaryClass: "text-status-warning/80" };
    if (project.lastOpened > 0)
      return {
        secondaryText: formatTimeAgo(project.lastOpened),
        secondaryClass: "text-daintree-text/50",
      };
    return { secondaryText: project.displayPath, secondaryClass: "text-daintree-text/50" };
  })();

  const row = (
    <div
      id={`project-option-${project.id}`}
      role="option"
      aria-selected={isSelected}
      aria-disabled={project.isMissing || undefined}
      className={cn(
        "group relative w-full flex items-center gap-2 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors border border-transparent",
        project.isActive
          ? cn("text-daintree-text", isSelected && "bg-overlay-soft border-border-subtle")
          : project.isMissing
            ? cn(
                "text-daintree-text/50",
                isSelected ? "bg-overlay-soft border-border-subtle" : "hover:bg-overlay-soft"
              )
            : isSelected
              ? "bg-overlay-soft border-border-subtle text-daintree-text cursor-pointer"
              : "text-daintree-text/70 hover:bg-overlay-soft hover:text-daintree-text cursor-pointer"
      )}
      onClick={() => !project.isActive && !project.isMissing && onSelect(project)}
    >
      <StatusDot project={project} />

      <div
        className={cn(
          "flex items-center justify-center rounded-[var(--radius-lg)] shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] shrink-0 transition duration-200",
          "h-8 w-8 text-base"
        )}
        style={{
          background: project.color
            ? `linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), ${getProjectGradient(project.color)}`
            : "linear-gradient(to bottom, rgba(0,0,0,0.1), rgba(0,0,0,0.2)), var(--color-daintree-sidebar)",
        }}
      >
        <span className="leading-none select-none filter drop-shadow-sm">{project.emoji}</span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center min-w-0">
          <span
            className={cn(
              "truncate text-sm font-semibold leading-tight",
              project.isActive || isSelected ? "text-daintree-text" : "text-daintree-text/85"
            )}
          >
            {project.name}
          </span>
        </div>

        <div className="flex items-center min-w-0 mt-0.5">
          <span className={cn("truncate text-[11px] leading-none", secondaryClass)}>
            {secondaryText}
          </span>
        </div>
      </div>
    </div>
  );

  const hasContextActions =
    onTogglePinProject || onStopProject || onCloseProject || onCopyPath || onSelectNewWindow;
  if (!hasContextActions) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        {onSelectNewWindow && !project.isActive && !project.isMissing && (
          <ContextMenuItem onClick={() => onSelectNewWindow(project)}>
            <AppWindow className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Open in new window
          </ContextMenuItem>
        )}
        {onTogglePinProject && (
          <ContextMenuItem onClick={() => onTogglePinProject(project.id)}>
            {project.isPinned ? (
              <>
                <PinOff className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Unpin project
              </>
            ) : (
              <>
                <Pin className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
                Pin project
              </>
            )}
          </ContextMenuItem>
        )}
        {onCopyPath && (
          <ContextMenuItem onClick={() => onCopyPath(project.path)}>
            <Clipboard className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Copy path
          </ContextMenuItem>
        )}
        {(onTogglePinProject || onCopyPath) && (onStopProject || onCloseProject) && (
          <ContextMenuSeparator />
        )}
        {showStop && onStopProject && (
          <ContextMenuItem destructive onClick={() => onStopProject(project.id)}>
            <Square className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Stop all agents
          </ContextMenuItem>
        )}
        {onCloseProject && !project.isActive && (
          <ContextMenuItem destructive onClick={() => onCloseProject(project.id)}>
            <X className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
            Remove project
          </ContextMenuItem>
        )}
        {project.isMissing && onLocateProject && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onLocateProject(project.id)}>
              <FolderOpen className="w-3.5 h-3.5 mr-2" aria-hidden="true" />
              Locate folder
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

interface TemporalSection {
  key: string;
  label: string | null;
  items: SearchableProject[];
}

function getTemporalBucket(timestamp: number, todayStart: number, weekStart: number): string {
  if (timestamp >= todayStart) return "today";
  if (timestamp >= weekStart) return "this-week";
  return "older";
}

interface ProjectListContentProps {
  results: SearchableProject[];
  selectedIndex: number;
  query: string;
  onSelect: (project: SearchableProject) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  mode?: ProjectSwitcherMode;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
}

function ProjectListContent({
  results,
  selectedIndex,
  query,
  onSelect,
  listRef,
  mode,
  onStopProject,
  onCloseProject,
  onLocateProject,
  onTogglePinProject,
  onCopyPath,
  onSelectNewWindow,
}: ProjectListContentProps) {
  const isSearching = query.trim().length > 0;

  const sections = useMemo<TemporalSection[] | null>(() => {
    if (isSearching || results.length === 0 || mode === "modal") return null;

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const weekStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - mondayOffset
    ).getTime();

    const current = results.filter((p) => p.isActive);
    const pinned = results.filter((p) => p.isPinned && !p.isActive);
    const remaining = results.filter((p) => !p.isActive && !p.isPinned);

    const buckets: Record<string, SearchableProject[]> = {
      today: [],
      "this-week": [],
      older: [],
    };
    for (const p of remaining) {
      buckets[getTemporalBucket(p.lastOpened, todayStart, weekStart)].push(p);
    }

    return [
      current.length > 0 ? { key: "current", label: null, items: current } : null,
      pinned.length > 0 ? { key: "pinned", label: "Pinned", items: pinned } : null,
      buckets.today.length > 0 ? { key: "today", label: "Today", items: buckets.today } : null,
      buckets["this-week"].length > 0
        ? { key: "this-week", label: "This Week", items: buckets["this-week"] }
        : null,
      buckets.older.length > 0 ? { key: "older", label: "Older", items: buckets.older } : null,
    ].filter((s): s is TemporalSection => s !== null);
  }, [results, isSearching, mode]);

  const displayResults = useMemo(() => {
    if (mode === "modal" && !isSearching) {
      return results.filter((p) => p.isActive || p.isBackground || p.processCount > 0);
    }
    return results;
  }, [results, mode, isSearching]);

  const resultIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    results.forEach((p, i) => map.set(p.id, i));
    return map;
  }, [results]);

  const renderItem = (project: SearchableProject) => {
    const index = resultIndexMap.get(project.id) ?? 0;
    return (
      <div key={project.id} role="presentation">
        <ProjectListItem
          project={project}
          isSelected={index === selectedIndex}
          onSelect={onSelect}
          onStopProject={onStopProject}
          onCloseProject={onCloseProject}
          onLocateProject={onLocateProject}
          onTogglePinProject={onTogglePinProject}
          onCopyPath={onCopyPath}
          onSelectNewWindow={onSelectNewWindow}
        />
      </div>
    );
  };

  return (
    <>
      <div ref={listRef} id="project-list" role="listbox" aria-label="Projects">
        {displayResults.length === 0 ? (
          <div className="p-2">
            <div className="px-3 py-8 text-center text-daintree-text/50 text-sm">
              {query.trim() ? (
                <div>{`No projects match "${query}"`}</div>
              ) : mode === "modal" ? (
                "No active projects"
              ) : (
                "No projects available"
              )}
            </div>
          </div>
        ) : sections ? (
          sections.map((section, sectionIdx) => {
            const isActiveSection = section.items[0]?.isActive;
            const isLast = sectionIdx === sections.length - 1;

            return (
              <div key={section.key}>
                {sectionIdx > 0 && <div className="h-[3px] bg-tint/[0.08]" />}
                <div
                  className={cn(
                    "px-2 py-1.5",
                    sectionIdx === 0 && "pt-2",
                    isLast && "pb-2",
                    isActiveSection && "bg-overlay-subtle"
                  )}
                >
                  {section.label && (
                    <div className="px-3 py-1 text-[10px] font-medium tracking-wider uppercase text-daintree-text/40 select-none">
                      {section.label}
                    </div>
                  )}
                  {section.items.map(renderItem)}
                </div>
              </div>
            );
          })
        ) : (
          <div className="p-2">{displayResults.map((project) => renderItem(project))}</div>
        )}
      </div>
    </>
  );
}

const KBD_CLASS =
  "px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-daintree-border text-daintree-text/60";

function ProjectSwitcherFooter({ mode }: { mode?: ProjectSwitcherMode }) {
  const modifiers = useModifierKeys();

  const hint = modifiers.alt
    ? { keys: "⌥↵", label: "Background" }
    : modifiers.meta
      ? { keys: "⌘↵", label: "New window" }
      : { keys: "↵", label: "Switch" };

  return (
    <div className="w-full flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span>
          <kbd className={KBD_CLASS}>{hint.keys}</kbd>
          <span className="ml-1.5">{hint.label}</span>
        </span>
        {mode !== "modal" && (
          <span className="text-daintree-text/30">
            <kbd className={KBD_CLASS}>⌘⌫</kbd>
            <span className="ml-1.5">Remove</span>
          </span>
        )}
      </div>
      {mode !== "modal" && (
        <span className="text-daintree-text/30">
          <span>Right-click for more</span>
        </span>
      )}
    </div>
  );
}

const PALETTE_WIDTH = "w-[484px] max-w-[calc(100vw-2rem)]";
const PALETTE_MAX_HEIGHT = "max-h-[60vh]";

interface ProjectPaletteInnerProps {
  inputRef: React.RefObject<HTMLInputElement | null>;
  listRef: React.RefObject<HTMLDivElement | null>;
  query: string;
  results: SearchableProject[];
  selectedIndex: number;
  mode?: ProjectSwitcherMode;
  onQueryChange: (query: string) => void;
  onSelect: (project: SearchableProject) => void;
  onSelectBackground?: (project: SearchableProject) => void;
  onSelectNewWindow?: (project: SearchableProject) => void;
  onClose: () => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onAddProject?: () => void;
  onCloneRepo?: () => void;
  onCreateFolder?: () => void;
  onOpenProjectSettings?: () => void;
  onStopProject?: (projectId: string) => void;
  onCloseProject?: (projectId: string) => void;
  onLocateProject?: (projectId: string) => void;
  onTogglePinProject?: (projectId: string) => void;
  onCopyPath?: (path: string) => void;
}

function ProjectPaletteInner({
  inputRef,
  listRef,
  query,
  results,
  selectedIndex,
  mode,
  onQueryChange,
  onSelect,
  onSelectBackground,
  onSelectNewWindow,
  onClose,
  onSelectPrevious,
  onSelectNext,
  onAddProject,
  onCloneRepo,
  onCreateFolder,
  onOpenProjectSettings,
  onStopProject,
  onCloseProject,
  onLocateProject,
  onTogglePinProject,
  onCopyPath,
}: ProjectPaletteInnerProps) {
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
  }, [listRef, selectedIndex, results]);

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
            const selected = results[selectedIndex];
            if (e.altKey && onSelectBackground) {
              onSelectBackground(selected);
            } else if (
              (e.metaKey || e.ctrlKey) &&
              onSelectNewWindow &&
              !selected.isActive &&
              !selected.isMissing
            ) {
              onSelectNewWindow(selected);
            } else {
              onSelect(selected);
            }
          }
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
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
    [
      results,
      selectedIndex,
      onSelectPrevious,
      onSelectNext,
      onSelect,
      onSelectBackground,
      onSelectNewWindow,
      onClose,
      onCloseProject,
    ]
  );

  const activeResult = results[selectedIndex];

  return (
    <TooltipProvider>
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
          aria-expanded={true}
          aria-haspopup="listbox"
          aria-label="Search projects"
          aria-controls="project-list"
          aria-activedescendant={activeResult ? `project-option-${activeResult.id}` : undefined}
        />
      </AppPaletteDialog.Header>

      <AppPaletteDialog.Body maxHeight={PALETTE_MAX_HEIGHT} className="p-0">
        <ProjectListContent
          results={results}
          selectedIndex={selectedIndex}
          query={query}
          onSelect={onSelect}
          listRef={listRef}
          mode={mode}
          onStopProject={onStopProject}
          onCloseProject={onCloseProject}
          onLocateProject={onLocateProject}
          onTogglePinProject={onTogglePinProject}
          onCopyPath={onCopyPath}
          onSelectNewWindow={onSelectNewWindow}
        />
      </AppPaletteDialog.Body>

      {(onOpenProjectSettings || onAddProject || onCloneRepo || onCreateFolder) && (
        <>
          <div className="h-[3px] bg-tint/[0.08]" />
          <div className="px-2 pt-1 pb-2">
            {onOpenProjectSettings && (
              <button
                type="button"
                onClick={() => onOpenProjectSettings()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] bg-tint/[0.04] text-muted-foreground">
                  <Settings2 className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">
                  Project Settings...
                </span>
              </button>
            )}
            {onAddProject && (
              <button
                type="button"
                onClick={() => onAddProject()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
                data-testid="project-add-button"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
                  <Plus className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">Add Project...</span>
              </button>
            )}
            {onCloneRepo && (
              <button
                type="button"
                onClick={() => onCloneRepo()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
                data-testid="project-clone-button"
              >
                <div className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground">
                  <Download className="h-4 w-4" />
                </div>
                <span className="font-medium text-sm text-muted-foreground">
                  Clone Repository...
                </span>
              </button>
            )}
            {onCreateFolder && (
              <button
                type="button"
                onClick={() => onCreateFolder()}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-[var(--radius-md)] text-left transition-colors hover:bg-overlay-subtle"
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

      <AppPaletteDialog.Footer>
        <ProjectSwitcherFooter mode={mode} />
      </AppPaletteDialog.Footer>
    </TooltipProvider>
  );
}

function ModalContent({
  isOpen,
  onClose,
  mode,
  ...innerProps
}: Omit<ProjectSwitcherPaletteProps, "children" | "dropdownAlign">) {
  useOverlayState(isOpen);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement as HTMLElement;
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (previousFocusRef.current) {
      if (!usePaletteStore.getState().activePaletteId) {
        previousFocusRef.current.focus();
      }
      previousFocusRef.current = null;
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "Tab" && dialogRef.current) {
        const focusableElements = dialogRef.current.querySelectorAll<HTMLElement>(
          'input, button, [tabindex]:not([tabindex="-1"])'
        );
        const firstEl = focusableElements[0];
        const lastEl = focusableElements[focusableElements.length - 1];

        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl?.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl?.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-start justify-center pt-[15vh] bg-scrim-medium backdrop-blur-sm backdrop-saturate-[var(--theme-material-saturation)]"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Project switcher"
    >
      <div
        ref={dialogRef}
        className={cn(
          PALETTE_WIDTH,
          "mx-4 surface-overlay shadow-overlay rounded-[var(--radius-lg)] overflow-hidden",
          "animate-in fade-in slide-in-from-top-4 duration-150"
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <ProjectPaletteInner
          inputRef={inputRef}
          listRef={listRef}
          query={innerProps.query}
          results={innerProps.results}
          selectedIndex={innerProps.selectedIndex}
          mode={mode}
          onQueryChange={innerProps.onQueryChange}
          onSelect={innerProps.onSelect}
          onClose={onClose}
          onSelectPrevious={innerProps.onSelectPrevious}
          onSelectNext={innerProps.onSelectNext}
          onAddProject={innerProps.onAddProject}
          onCloneRepo={innerProps.onCloneRepo}
          onCreateFolder={innerProps.onCreateFolder}
          onOpenProjectSettings={innerProps.onOpenProjectSettings}
          onStopProject={innerProps.onStopProject}
          onCloseProject={innerProps.onCloseProject}
          onLocateProject={innerProps.onLocateProject}
          onTogglePinProject={innerProps.onTogglePinProject}
          onCopyPath={innerProps.onCopyPath}
          onSelectBackground={innerProps.onSelectBackground}
          onSelectNewWindow={innerProps.onSelectNewWindow}
        />
      </div>
    </div>,
    document.body
  );
}

function DropdownContent({
  isOpen,
  onClose,
  dropdownAlign = "start",
  children,
  mode,
  ...innerProps
}: ProjectSwitcherPaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
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

  return (
    <Popover open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        className={cn(PALETTE_WIDTH, "p-0")}
        data-testid="project-switcher-palette"
        align={dropdownAlign}
        sideOffset={8}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <ProjectPaletteInner
          inputRef={inputRef}
          listRef={listRef}
          query={innerProps.query}
          results={innerProps.results}
          selectedIndex={innerProps.selectedIndex}
          mode={mode}
          onQueryChange={innerProps.onQueryChange}
          onSelect={innerProps.onSelect}
          onClose={onClose}
          onSelectPrevious={innerProps.onSelectPrevious}
          onSelectNext={innerProps.onSelectNext}
          onAddProject={innerProps.onAddProject}
          onCloneRepo={innerProps.onCloneRepo}
          onCreateFolder={innerProps.onCreateFolder}
          onOpenProjectSettings={innerProps.onOpenProjectSettings}
          onStopProject={innerProps.onStopProject}
          onCloseProject={innerProps.onCloseProject}
          onLocateProject={innerProps.onLocateProject}
          onTogglePinProject={innerProps.onTogglePinProject}
          onCopyPath={innerProps.onCopyPath}
          onSelectBackground={innerProps.onSelectBackground}
          onSelectNewWindow={innerProps.onSelectNewWindow}
        />
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
  onCloneRepo,
  onCreateFolder,
  onStopProject,
  onCloseProject,
  onLocateProject,
  onTogglePinProject,
  onCopyPath,
  onSelectBackground,
  onSelectNewWindow,
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
        mode={mode}
        onAddProject={onAddProject}
        onCloneRepo={onCloneRepo}
        onCreateFolder={onCreateFolder}
        onStopProject={onStopProject}
        onCloseProject={onCloseProject}
        onLocateProject={onLocateProject}
        onTogglePinProject={onTogglePinProject}
        onCopyPath={onCopyPath}
        onSelectBackground={onSelectBackground}
        onSelectNewWindow={onSelectNewWindow}
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
        mode={mode}
        onAddProject={onAddProject}
        onCloneRepo={onCloneRepo}
        onCreateFolder={onCreateFolder}
        onStopProject={onStopProject}
        onCloseProject={onCloseProject}
        onLocateProject={onLocateProject}
        onTogglePinProject={onTogglePinProject}
        onCopyPath={onCopyPath}
        onSelectBackground={onSelectBackground}
        onSelectNewWindow={onSelectNewWindow}
        onOpenProjectSettings={onOpenProjectSettings}
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
              <div className="text-xs text-daintree-text/50 font-mono mt-1">
                {removeConfirmProject.path}
              </div>
            </div>
            {removeConfirmProject.isActive
              ? hasRunningProcesses && (
                  <div className="rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20 px-3 py-2 text-xs text-status-warning">
                    <div className="font-medium">
                      Warning: All running processes will be terminated
                    </div>
                    <div className="mt-1 text-status-warning/80">
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
                  <div className="rounded-[var(--radius-md)] bg-status-warning/10 border border-status-warning/20 px-3 py-2 text-xs text-status-warning">
                    <div className="font-medium">Warning: Active sessions detected</div>
                    <div className="mt-1 text-status-warning/80">
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
            <div className="text-xs text-daintree-text/60">
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
